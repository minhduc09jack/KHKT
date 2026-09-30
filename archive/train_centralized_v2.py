#!/usr/bin/env python3
"""
train_centralized_v2.py — Centralized Baseline V2 (Anti-Overfitting Edition)
=============================================================================

Phiên bản cải tiến của Centralized Baseline với 7 kỹ thuật chống overfitting:

  1. Focal Loss (Lin et al., 2017)     — giảm trọng số mẫu dễ, tập trung mẫu khó
  2. Label Smoothing (Szegedy, 2016)    — soft labels ngăn overconfidence
  3. Aggressive Augmentation            — RandAugment + random erasing
  4. WeightedRandomSampler              — oversample lớp thiểu số mỗi epoch
  5. 2-Stage Fine-Tuning                — freeze backbone → unfreeze toàn bộ
  6. Early Stopping                     — dừng khi val F1 không cải thiện
  7. Gradient Clipping                  — ổn định training khi class weights lớn

So sánh kết quả với V1 để chứng minh: Centralized training trên dữ liệu
Non-IID cực kỳ mất cân bằng vẫn bị overfitting dù áp dụng nhiều kỹ thuật
→ Federated Learning là hướng tiếp cận cần thiết.

Usage:
    python3 train_centralized_v2.py --data-root ./federated_data
    python3 train_centralized_v2.py --data-root ./federated_data --epochs 25 --patience 7
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingWarmRestarts, SequentialLR, LinearLR
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision import models, transforms

from PIL import Image
from sklearn.metrics import f1_score, roc_auc_score

# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════

CLASS_NAMES: List[str] = ["Atelectasis", "Infiltration", "No Finding", "Pneumonia"]
NUM_CLASSES: int = len(CLASS_NAMES)
LABEL_TO_IDX: Dict[str, int] = {name: i for i, name in enumerate(CLASS_NAMES)}

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

CLIENT_DIRS: List[str] = [
    "client_1_lung_hospital",
    "client_2_emergency_general",
    "client_3_screening_clinic",
]

LOG_FORMAT = "%(asctime)s │ %(levelname)-8s │ %(message)s"


def setup_logging(verbose: bool = False) -> logging.Logger:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format=LOG_FORMAT, datefmt="%H:%M:%S")
    logger = logging.getLogger("centralized_v2")
    logger.setLevel(level)
    return logger


# ═══════════════════════════════════════════════════════════════════════════════
# [IMPROVEMENT 1] FOCAL LOSS — Lin et al., 2017
# ═══════════════════════════════════════════════════════════════════════════════


class FocalLoss(nn.Module):
    """
    Focal Loss for multi-class classification.

    FL(p_t) = -α_t × (1 - p_t)^γ × log(p_t)

    - When a sample is correctly classified with high confidence (p_t → 1),
      the modulating factor (1 - p_t)^γ → 0, reducing the loss contribution.
    - Misclassified or uncertain samples (p_t → 0) contribute more to the loss.

    Args:
        alpha:           Per-class weight tensor [C]. Balances class frequency.
        gamma:           Focusing parameter (γ ≥ 0). Higher γ = more focus on hard samples.
        label_smoothing: Smoothing factor ε. Converts hard labels to soft targets:
                         y_smooth = (1 - ε) × y_hard + ε / C
    """

    def __init__(
        self,
        alpha: Optional[torch.Tensor] = None,
        gamma: float = 2.0,
        label_smoothing: float = 0.1,
        reduction: str = "mean",
    ) -> None:
        super().__init__()
        self.gamma = gamma
        self.label_smoothing = label_smoothing
        self.reduction = reduction
        if alpha is not None:
            self.register_buffer("alpha", alpha)
        else:
            self.alpha = None

    def forward(self, logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        """
        Args:
            logits:  [B, C] raw model output
            targets: [B]    integer class indices
        """
        num_classes = logits.size(1)

        # Label smoothing: convert to soft targets
        with torch.no_grad():
            smooth_targets = torch.zeros_like(logits)
            smooth_targets.fill_(self.label_smoothing / (num_classes - 1))
            smooth_targets.scatter_(
                1, targets.unsqueeze(1), 1.0 - self.label_smoothing
            )

        # Compute log-probabilities
        log_probs = F.log_softmax(logits, dim=1)
        probs = torch.exp(log_probs)

        # Focal modulating factor: (1 - p_t)^γ for each class
        focal_weight = (1.0 - probs) ** self.gamma

        # Combine: focal × log(p) × soft_target
        loss = -focal_weight * log_probs * smooth_targets  # [B, C]

        # Apply per-class alpha weights
        if self.alpha is not None:
            alpha = self.alpha.unsqueeze(0)  # [1, C]
            loss = loss * alpha

        # Sum over classes, then reduce over batch
        loss = loss.sum(dim=1)  # [B]

        if self.reduction == "mean":
            return loss.mean()
        elif self.reduction == "sum":
            return loss.sum()
        return loss


# ═══════════════════════════════════════════════════════════════════════════════
# DATASET
# ═══════════════════════════════════════════════════════════════════════════════


class NIHChestXrayDataset(Dataset):
    """PyTorch Dataset reading from folder structure via symlinks."""

    def __init__(
        self,
        image_paths: List[Path],
        labels: List[int],
        transform: Optional[transforms.Compose] = None,
    ) -> None:
        assert len(image_paths) == len(labels)
        self.image_paths = image_paths
        self.labels = labels
        self.transform = transform

    def __len__(self) -> int:
        return len(self.image_paths)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, int]:
        image = Image.open(self.image_paths[idx]).convert("RGB")
        if self.transform is not None:
            image = self.transform(image)
        return image, self.labels[idx]


def _scan_folder_split(
    base_dir: Path, split: str, label_to_idx: Dict[str, int],
) -> Tuple[List[Path], List[int]]:
    split_dir = base_dir / split
    paths, labels = [], []
    if not split_dir.exists():
        return paths, labels
    for label_dir in sorted(split_dir.iterdir()):
        if not label_dir.is_dir():
            continue
        label_name = label_dir.name.replace("_", " ")
        if label_name not in label_to_idx:
            continue
        label_idx = label_to_idx[label_name]
        for img_file in sorted(label_dir.glob("*.png")):
            paths.append(img_file)
            labels.append(label_idx)
    return paths, labels


def build_virtual_dataset(
    data_root: Path, split: str, transform: transforms.Compose, logger: logging.Logger,
) -> NIHChestXrayDataset:
    all_paths, all_labels = [], []
    for client_dir_name in CLIENT_DIRS:
        client_path = data_root / client_dir_name
        paths, labels = _scan_folder_split(client_path, split, LABEL_TO_IDX)
        all_paths.extend(paths)
        all_labels.extend(labels)
        logger.info("  %-35s │ %s │ %5d images", client_dir_name, split, len(paths))
    dataset = NIHChestXrayDataset(all_paths, all_labels, transform=transform)
    logger.info("  %-35s │ %s │ %5d images (merged)", "TOTAL", split, len(dataset))
    return dataset


def build_test_dataset(
    data_root: Path, transform: transforms.Compose, logger: logging.Logger,
) -> NIHChestXrayDataset:
    test_dir = data_root / "global_test"
    paths, labels = [], []
    for label_dir in sorted(test_dir.iterdir()):
        if not label_dir.is_dir():
            continue
        label_name = label_dir.name.replace("_", " ")
        if label_name not in LABEL_TO_IDX:
            continue
        label_idx = LABEL_TO_IDX[label_name]
        for img_file in sorted(label_dir.glob("*.png")):
            paths.append(img_file)
            labels.append(label_idx)
    dataset = NIHChestXrayDataset(paths, labels, transform=transform)
    logger.info("  %-35s │ test │ %5d images", "global_test", len(dataset))
    return dataset


# ═══════════════════════════════════════════════════════════════════════════════
# [IMPROVEMENT 3] AGGRESSIVE AUGMENTATION
# ═══════════════════════════════════════════════════════════════════════════════


def get_train_transforms_v2(img_size: int = 224) -> transforms.Compose:
    """
    V2 augmentation pipeline — significantly more aggressive than V1:
      + RandAugment (Cubuk et al., 2020)
      + Random Erasing (Zhong et al., 2020)
      + Wider rotation range
      + Perspective distortion
    """
    return transforms.Compose([
        transforms.Resize((img_size + 32, img_size + 32)),
        transforms.RandomCrop(img_size),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.RandomRotation(degrees=15),                  # V1: 10° → V2: 15°
        transforms.RandomAffine(
            degrees=0, translate=(0.05, 0.05), scale=(0.95, 1.05)
        ),
        transforms.ColorJitter(
            brightness=0.2, contrast=0.2, saturation=0.1        # V1: 0.15 → V2: 0.2
        ),
        transforms.RandomPerspective(distortion_scale=0.1, p=0.3),
        transforms.RandAugment(num_ops=2, magnitude=6),         # NEW: auto-augmentation
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
        transforms.RandomErasing(p=0.15, scale=(0.02, 0.15)),   # NEW: cutout regularization
    ])


def get_eval_transforms(img_size: int = 224) -> transforms.Compose:
    return transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])


# ═══════════════════════════════════════════════════════════════════════════════
# MODEL — [IMPROVEMENT 5] 2-STAGE FINE-TUNING
# ═══════════════════════════════════════════════════════════════════════════════


def build_model(num_classes: int = NUM_CLASSES, dropout: float = 0.3) -> nn.Module:
    """
    MobileNetV3-Small with increased dropout in the classifier head.
    V1 used default dropout (0.2); V2 increases to 0.3.
    """
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = models.mobilenet_v3_small(weights=weights)

    in_features = model.classifier[-1].in_features

    # Replace classifier with higher dropout
    model.classifier = nn.Sequential(
        nn.Linear(model.classifier[0].in_features, 1024),
        nn.Hardswish(inplace=True),
        nn.Dropout(p=dropout, inplace=True),     # V1: 0.2 → V2: 0.3
        nn.Linear(1024, num_classes),
    )

    return model


def freeze_backbone(model: nn.Module) -> None:
    """Freeze all layers except the classifier head."""
    for name, param in model.named_parameters():
        if "classifier" not in name:
            param.requires_grad = False


def unfreeze_backbone(model: nn.Module) -> None:
    """Unfreeze all layers for full fine-tuning."""
    for param in model.parameters():
        param.requires_grad = True


# ═══════════════════════════════════════════════════════════════════════════════
# [IMPROVEMENT 4] WEIGHTED RANDOM SAMPLER
# ═══════════════════════════════════════════════════════════════════════════════


def build_weighted_sampler(labels: List[int], num_classes: int) -> WeightedRandomSampler:
    """
    Creates a WeightedRandomSampler that oversamples minority classes.
    Each sample gets weight = 1 / count(its_class).
    Classes with 0 samples are safely ignored.
    """
    class_counts = np.bincount(labels, minlength=num_classes).astype(np.float64)
    # For classes with 0 samples, set weight to 0 (they have no samples to weight)
    class_weights = np.zeros(num_classes)
    for i in range(num_classes):
        if class_counts[i] > 0:
            class_weights[i] = 1.0 / class_counts[i]

    sample_weights = np.array([class_weights[label] for label in labels])
    sample_weights = torch.from_numpy(sample_weights).double()

    return WeightedRandomSampler(
        weights=sample_weights,
        num_samples=len(labels),
        replacement=True,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# DEVICE
# ═══════════════════════════════════════════════════════════════════════════════


def get_device(logger: logging.Logger) -> torch.device:
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        device = torch.device("mps")
        logger.info("  🍎 Using Apple MPS (Metal Performance Shaders)")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
        logger.info("  🟢 Using NVIDIA CUDA")
    else:
        device = torch.device("cpu")
        logger.warning("  ⚠ Falling back to CPU")
    return device


# ═══════════════════════════════════════════════════════════════════════════════
# METRICS
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class EpochMetrics:
    epoch: int
    loss: float
    accuracy: float
    macro_f1: float
    macro_auc: float
    stage: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "epoch": self.epoch,
            "loss": round(self.loss, 6),
            "accuracy": round(self.accuracy, 4),
            "macro_f1": round(self.macro_f1, 4),
            "macro_auc": round(self.macro_auc, 4),
        }
        if self.stage:
            d["stage"] = self.stage
        return d


def compute_metrics(
    all_labels: np.ndarray, all_preds: np.ndarray, all_probs: np.ndarray,
    total_loss: float, num_samples: int,
) -> Tuple[float, float, float, float]:
    avg_loss = total_loss / max(num_samples, 1)
    accuracy = float(np.mean(all_labels == all_preds))
    macro_f1 = float(f1_score(all_labels, all_preds, average="macro", zero_division=0))
    try:
        unique_labels = np.unique(all_labels)
        if len(unique_labels) >= 2:
            macro_auc = float(roc_auc_score(
                all_labels, all_probs, multi_class="ovr", average="macro"
            ))
        else:
            macro_auc = 0.0
    except ValueError:
        macro_auc = 0.0
    return avg_loss, accuracy, macro_f1, macro_auc


# ═══════════════════════════════════════════════════════════════════════════════
# [IMPROVEMENT 6] EARLY STOPPING
# ═══════════════════════════════════════════════════════════════════════════════


class EarlyStopping:
    """
    Stops training when monitored metric (Macro F1) has not improved
    for `patience` consecutive epochs.
    """

    def __init__(self, patience: int = 7, min_delta: float = 0.001) -> None:
        self.patience = patience
        self.min_delta = min_delta
        self.best_score: Optional[float] = None
        self.counter: int = 0
        self.should_stop: bool = False

    def step(self, score: float) -> bool:
        """Returns True if training should stop."""
        if self.best_score is None:
            self.best_score = score
            return False

        if score > self.best_score + self.min_delta:
            self.best_score = score
            self.counter = 0
        else:
            self.counter += 1
            if self.counter >= self.patience:
                self.should_stop = True

        return self.should_stop


# ═══════════════════════════════════════════════════════════════════════════════
# TRAINING & EVALUATION LOOPS
# ═══════════════════════════════════════════════════════════════════════════════


def train_one_epoch(
    model: nn.Module, loader: DataLoader, criterion: nn.Module,
    optimizer: torch.optim.Optimizer, device: torch.device,
    epoch: int, max_grad_norm: float, logger: logging.Logger,
    stage: str = "",
) -> EpochMetrics:
    model.train()
    running_loss = 0.0
    all_labels, all_preds, all_probs = [], [], []
    num_samples = 0
    num_batches = len(loader)
    log_interval = max(1, num_batches // 5)

    for batch_idx, (images, labels) in enumerate(loader):
        images = images.to(device, non_blocking=True)
        labels = labels.to(device, non_blocking=True)

        optimizer.zero_grad(set_to_none=True)
        outputs = model(images)
        loss = criterion(outputs, labels)
        loss.backward()

        # [IMPROVEMENT 7] Gradient clipping
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=max_grad_norm)

        optimizer.step()

        batch_size = labels.size(0)
        running_loss += loss.item() * batch_size
        num_samples += batch_size

        probs = torch.softmax(outputs.detach(), dim=1).cpu().numpy()
        preds = outputs.detach().argmax(dim=1).cpu().numpy()
        labels_np = labels.cpu().numpy()

        all_labels.extend(labels_np.tolist())
        all_preds.extend(preds.tolist())
        all_probs.append(probs)

        if (batch_idx + 1) % log_interval == 0:
            logger.debug("    Batch [%3d/%3d] │ Loss: %.4f",
                         batch_idx + 1, num_batches, running_loss / num_samples)

    all_labels_arr = np.array(all_labels)
    all_preds_arr = np.array(all_preds)
    all_probs_arr = np.vstack(all_probs)

    avg_loss, accuracy, macro_f1, macro_auc = compute_metrics(
        all_labels_arr, all_preds_arr, all_probs_arr, running_loss, num_samples
    )
    return EpochMetrics(epoch=epoch, loss=avg_loss, accuracy=accuracy,
                        macro_f1=macro_f1, macro_auc=macro_auc, stage=stage)


@torch.no_grad()
def evaluate(
    model: nn.Module, loader: DataLoader, criterion: nn.Module,
    device: torch.device, epoch: int = -1,
) -> EpochMetrics:
    model.eval()
    running_loss = 0.0
    all_labels, all_preds, all_probs = [], [], []
    num_samples = 0

    for images, labels in loader:
        images = images.to(device, non_blocking=True)
        labels = labels.to(device, non_blocking=True)
        outputs = model(images)
        loss = criterion(outputs, labels)

        batch_size = labels.size(0)
        running_loss += loss.item() * batch_size
        num_samples += batch_size

        probs = torch.softmax(outputs, dim=1).cpu().numpy()
        preds = outputs.argmax(dim=1).cpu().numpy()
        all_labels.extend(labels.cpu().numpy().tolist())
        all_preds.extend(preds.tolist())
        all_probs.append(probs)

    all_labels_arr = np.array(all_labels)
    all_preds_arr = np.array(all_preds)
    all_probs_arr = np.vstack(all_probs)
    avg_loss, accuracy, macro_f1, macro_auc = compute_metrics(
        all_labels_arr, all_preds_arr, all_probs_arr, running_loss, num_samples
    )
    return EpochMetrics(epoch=epoch, loss=avg_loss, accuracy=accuracy,
                        macro_f1=macro_f1, macro_auc=macro_auc)


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ═══════════════════════════════════════════════════════════════════════════════


def train(
    data_root: Path, output_dir: Path, epochs: int, batch_size: int,
    num_workers: int, lr: float, weight_decay: float, gamma: float,
    label_smoothing: float, dropout: float, patience: int,
    max_grad_norm: float, warmup_epochs: int, verbose: bool,
) -> None:
    logger = setup_logging(verbose)

    logger.info("╔══════════════════════════════════════════════════════════════╗")
    logger.info("║  🏥 Centralized Baseline V2 — Anti-Overfitting Edition     ║")
    logger.info("║  Focal Loss │ RandAugment │ WeightedSampler │ EarlyStopping║")
    logger.info("╚══════════════════════════════════════════════════════════════╝")

    device = get_device(logger)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Improvements Summary ──────────────────────────────────────────────────
    improvements = {
        "1_focal_loss": f"γ={gamma}, label_smoothing={label_smoothing}",
        "2_label_smoothing": f"ε={label_smoothing}",
        "3_aggressive_augment": "RandAugment(n=2,m=6) + RandomErasing(p=0.15) + Perspective",
        "4_weighted_sampler": "WeightedRandomSampler (oversample minority classes)",
        "5_two_stage_finetune": f"Stage 1: freeze backbone ({warmup_epochs} epochs) → Stage 2: full finetune",
        "6_early_stopping": f"patience={patience}, min_delta=0.001",
        "7_gradient_clipping": f"max_norm={max_grad_norm}",
        "8_higher_dropout": f"classifier dropout={dropout} (V1: 0.2)",
    }
    logger.info("═" * 65)
    logger.info("🛡️  Anti-Overfitting Improvements (V2 vs V1):")
    for key, desc in improvements.items():
        logger.info("  [%s] %s", key.split("_", 1)[0], desc)

    # ── Datasets ──────────────────────────────────────────────────────────────
    logger.info("═" * 65)
    logger.info("📂 Building virtual aggregated datasets...")

    train_transform = get_train_transforms_v2()
    eval_transform = get_eval_transforms()

    train_dataset = build_virtual_dataset(data_root, "train", train_transform, logger)
    val_dataset = build_virtual_dataset(data_root, "val", eval_transform, logger)
    test_dataset = build_test_dataset(data_root, eval_transform, logger)

    # Class distribution
    train_label_counts = np.bincount(train_dataset.labels, minlength=NUM_CLASSES)
    logger.info("  Train class distribution:")
    for i, name in enumerate(CLASS_NAMES):
        logger.info("    %-15s : %5d (%.1f%%)", name, train_label_counts[i],
                     train_label_counts[i] / len(train_dataset) * 100)

    # ── [IMPROVEMENT 4] Weighted Sampler ──────────────────────────────────────
    train_sampler = build_weighted_sampler(train_dataset.labels, NUM_CLASSES)
    logger.info("  ✓ WeightedRandomSampler built (oversample minority classes)")

    loader_kwargs = {
        "batch_size": batch_size,
        "num_workers": num_workers,
        "pin_memory": False,
        "persistent_workers": num_workers > 0,
        "prefetch_factor": 4 if num_workers > 0 else None,
    }

    # Note: sampler is mutually exclusive with shuffle
    train_loader = DataLoader(train_dataset, sampler=train_sampler,
                              drop_last=True, **loader_kwargs)
    val_loader = DataLoader(val_dataset, shuffle=False, **loader_kwargs)
    test_loader = DataLoader(test_dataset, shuffle=False, **loader_kwargs)

    # ── Model ─────────────────────────────────────────────────────────────────
    logger.info("═" * 65)
    logger.info("🧠 Building MobileNetV3-Small (dropout=%.2f)", dropout)
    model = build_model(NUM_CLASSES, dropout=dropout).to(device)
    total_params = sum(p.numel() for p in model.parameters())
    logger.info("  Parameters: %s total", f"{total_params:,}")

    # ── [IMPROVEMENT 1] Focal Loss ────────────────────────────────────────────
    class_counts = np.bincount(train_dataset.labels, minlength=NUM_CLASSES).astype(np.float64)
    # Safe alpha: only weight classes that actually have samples
    # Classes with 0 samples get alpha=0 (no contribution to loss)
    present_mask = class_counts > 0
    num_present = present_mask.sum()
    alpha_weights = np.zeros(NUM_CLASSES)
    for i in range(NUM_CLASSES):
        if class_counts[i] > 0:
            alpha_weights[i] = 1.0 / class_counts[i]
    # Normalize so present classes sum to num_present
    alpha_sum = alpha_weights.sum()
    if alpha_sum > 0:
        alpha_weights = alpha_weights / alpha_sum * num_present
    alpha_tensor = torch.tensor(alpha_weights, dtype=torch.float32).to(device)

    # Log which classes are missing
    for i, name in enumerate(CLASS_NAMES):
        if class_counts[i] == 0:
            logger.warning("  ⚠ Class '%s' has 0 training samples — alpha set to 0", name)

    criterion = FocalLoss(
        alpha=alpha_tensor,
        gamma=gamma,
        label_smoothing=label_smoothing,
    )
    logger.info("  Loss: FocalLoss(γ=%.1f, smoothing=%.2f)", gamma, label_smoothing)
    logger.info("  Alpha: %s", {CLASS_NAMES[i]: f"{w:.4f}" for i, w in enumerate(alpha_weights)})
    logger.info("  Present classes: %d / %d", int(num_present), NUM_CLASSES)

    # Standard CE for val/test evaluation (consistent comparison with V1)
    # Use uniform weights for absent classes to avoid NaN
    eval_weights = alpha_tensor.clone()
    eval_weights[eval_weights == 0] = 1.0  # neutral weight for absent classes
    criterion_eval = nn.CrossEntropyLoss(weight=eval_weights)

    # ── [IMPROVEMENT 5] 2-Stage Fine-Tuning ──────────────────────────────────
    # Stage 1: Freeze backbone, train only classifier head
    freeze_backbone(model)
    trainable_s1 = sum(p.numel() for p in model.parameters() if p.requires_grad)
    logger.info("  Stage 1: Backbone FROZEN (%s trainable params)", f"{trainable_s1:,}")

    optimizer = AdamW(
        filter(lambda p: p.requires_grad, model.parameters()),
        lr=lr,
        weight_decay=weight_decay,
    )

    # Warmup: ramp LR from lr*0.1 → lr over warmup_epochs
    warmup_scheduler = LinearLR(optimizer, start_factor=0.1, end_factor=1.0, total_iters=warmup_epochs)
    cosine_scheduler = CosineAnnealingWarmRestarts(optimizer, T_0=max(1, epochs - warmup_epochs), T_mult=1)

    logger.info("  Optimizer: AdamW (lr=%.1e, wd=%.1e)", lr, weight_decay)
    logger.info("  Scheduler: LinearWarmup(%d) → CosineAnnealingWarmRestarts", warmup_epochs)

    # ── [IMPROVEMENT 6] Early Stopping ────────────────────────────────────────
    early_stopper = EarlyStopping(patience=patience)
    logger.info("  Early Stopping: patience=%d", patience)

    # ── Training Loop ─────────────────────────────────────────────────────────
    logger.info("═" * 65)
    logger.info("🚀 Starting training for up to %d epochs...", epochs)
    logger.info("═" * 65)

    best_f1 = 0.0
    best_epoch = -1
    checkpoint_path = output_dir / "best_centralized_v2.pth"
    history: List[Dict[str, Any]] = []
    actual_epochs = 0

    for epoch in range(1, epochs + 1):
        epoch_start = time.time()
        actual_epochs = epoch

        # ── Stage Transition ──────────────────────────────────────────────
        if epoch == warmup_epochs + 1:
            logger.info("═" * 65)
            logger.info("🔓 STAGE 2: Unfreezing backbone for full fine-tuning")
            unfreeze_backbone(model)
            trainable_s2 = sum(p.numel() for p in model.parameters() if p.requires_grad)
            logger.info("  Now %s trainable params", f"{trainable_s2:,}")

            # Re-create optimizer with all parameters and lower LR
            optimizer = AdamW(
                model.parameters(),
                lr=lr * 0.1,  # 10× lower LR for backbone
                weight_decay=weight_decay,
            )
            cosine_scheduler = CosineAnnealingWarmRestarts(
                optimizer, T_0=epochs - warmup_epochs, T_mult=1
            )
            logger.info("  New LR: %.1e (10× lower for pre-trained layers)", lr * 0.1)
            logger.info("═" * 65)

        stage = "Stage1-Frozen" if epoch <= warmup_epochs else "Stage2-FullFT"

        # Train
        train_metrics = train_one_epoch(
            model, train_loader, criterion, optimizer, device,
            epoch, max_grad_norm, logger, stage,
        )

        # Validate (using standard CE for fair comparison with V1)
        val_metrics = evaluate(model, val_loader, criterion_eval, device, epoch)

        # Step scheduler
        if epoch <= warmup_epochs:
            warmup_scheduler.step()
        else:
            cosine_scheduler.step()

        current_lr = optimizer.param_groups[0]["lr"]
        epoch_time = time.time() - epoch_start

        # Log
        logger.info(
            "Epoch [%2d/%2d] %s │ %5.1fs │ LR: %.2e │ "
            "Train[L:%.4f A:%.2f%% F1:%.4f] │ "
            "Val[L:%.4f A:%.2f%% F1:%.4f AUC:%.4f]",
            epoch, epochs, stage[:6], epoch_time, current_lr,
            train_metrics.loss, train_metrics.accuracy * 100, train_metrics.macro_f1,
            val_metrics.loss, val_metrics.accuracy * 100, val_metrics.macro_f1,
            val_metrics.macro_auc,
        )

        # Checkpoint on best Macro F1
        if val_metrics.macro_f1 > best_f1:
            best_f1 = val_metrics.macro_f1
            best_epoch = epoch
            torch.save(model.state_dict(), checkpoint_path)
            logger.info("  ★ New best! Macro F1: %.4f → %s", best_f1, checkpoint_path.name)

        history.append({
            "epoch": epoch,
            "stage": stage,
            "lr": round(current_lr, 8),
            "train": train_metrics.to_dict(),
            "val": val_metrics.to_dict(),
            "epoch_time_sec": round(epoch_time, 2),
        })

        # [IMPROVEMENT 6] Early stopping check
        if early_stopper.step(val_metrics.macro_f1):
            logger.info("═" * 65)
            logger.info(
                "⏹  Early stopping triggered at epoch %d "
                "(no improvement for %d epochs)", epoch, patience
            )
            break

        # MPS memory cleanup
        if device.type == "mps":
            torch.mps.empty_cache()

    logger.info("═" * 65)
    logger.info("✅ Training complete. Best epoch: %d (Macro F1: %.4f)", best_epoch, best_f1)
    if early_stopper.should_stop:
        logger.info("  (Stopped early at epoch %d / %d)", actual_epochs, epochs)

    # ── Final Test Evaluation ─────────────────────────────────────────────────
    logger.info("═" * 65)
    logger.info("🧪 Evaluating best model on Global Test Set...")

    model.load_state_dict(torch.load(checkpoint_path, map_location=device, weights_only=True))
    test_metrics = evaluate(model, test_loader, criterion_eval, device, epoch=-1)

    logger.info(
        "  Global Test │ Loss: %.4f │ Acc: %.2f%% │ F1: %.4f │ AUC: %.4f",
        test_metrics.loss, test_metrics.accuracy * 100,
        test_metrics.macro_f1, test_metrics.macro_auc,
    )

    # ── Load V1 metrics for comparison ────────────────────────────────────────
    v1_metrics = None
    v1_path = Path("./centralized_output/centralized_baseline_metrics.json")
    if v1_path.exists():
        with open(v1_path, "r") as f:
            v1_data = json.load(f)
        v1_metrics = v1_data.get("global_test_results", {})
        logger.info("═" * 65)
        logger.info("📊 V1 vs V2 COMPARISON (Global Test)")
        logger.info("  %-20s │ %10s │ %10s │ %8s", "Metric", "V1", "V2", "Δ")
        logger.info("  " + "─" * 60)
        for metric_name in ["accuracy", "macro_f1", "macro_auc", "loss"]:
            v1_val = v1_metrics.get(metric_name, 0)
            v2_val = getattr(test_metrics, metric_name)
            delta = v2_val - v1_val
            sign = "+" if delta >= 0 else ""
            logger.info("  %-20s │ %10.4f │ %10.4f │ %s%.4f",
                         metric_name, v1_val, v2_val, sign, delta)

    # ── Export Metrics ────────────────────────────────────────────────────────
    metrics_path = output_dir / "centralized_v2_metrics.json"
    report = {
        "experiment": "centralized_baseline_v2",
        "model": "MobileNetV3-Small",
        "num_classes": NUM_CLASSES,
        "class_names": CLASS_NAMES,
        "version": "v2_anti_overfitting",
        "improvements": improvements,
        "config": {
            "epochs_configured": epochs,
            "epochs_actual": actual_epochs,
            "early_stopped": early_stopper.should_stop,
            "batch_size": batch_size,
            "lr": lr,
            "weight_decay": weight_decay,
            "optimizer": "AdamW",
            "scheduler": "LinearWarmup → CosineAnnealingWarmRestarts",
            "loss": f"FocalLoss(γ={gamma}, smoothing={label_smoothing})",
            "dropout": dropout,
            "patience": patience,
            "max_grad_norm": max_grad_norm,
            "warmup_epochs": warmup_epochs,
            "img_size": 224,
            "device": str(device),
        },
        "dataset_sizes": {
            "train": len(train_dataset),
            "val": len(val_dataset),
            "test": len(test_dataset),
        },
        "class_weights_alpha": {CLASS_NAMES[i]: round(w, 4) for i, w in enumerate(alpha_weights)},
        "best_epoch": best_epoch,
        "best_val_macro_f1": round(best_f1, 4),
        "training_history": history,
        "global_test_results": test_metrics.to_dict(),
        "v1_comparison": {
            "v1_test": v1_metrics,
            "v2_test": test_metrics.to_dict(),
        } if v1_metrics else None,
        "checkpoint_path": str(checkpoint_path),
    }

    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    logger.info("  📊 Metrics: %s", metrics_path)
    logger.info("  💾 Model:   %s", checkpoint_path)
    logger.info("═" * 65)
    logger.info("🎉 DONE — V2 baseline ready for comparison.")

    if device.type == "mps":
        torch.mps.empty_cache()


# ═══════════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════════


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="train_centralized_v2",
        description=(
            "🏥 Centralized Baseline V2 — Anti-Overfitting Edition\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "7 improvements over V1: Focal Loss, RandAugment, WeightedSampler,\n"
            "2-Stage Fine-Tuning, Early Stopping, Gradient Clipping, Higher Dropout."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--data-root", type=str, required=True)
    parser.add_argument("--output", type=str, default="./centralized_output_v2")
    parser.add_argument("--epochs", type=int, default=25,
                        help="Max epochs (default: 25, may stop early)")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--num-workers", type=int, default=4)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-3,
                        help="V2: stronger weight decay (V1: 1e-4)")
    parser.add_argument("--gamma", type=float, default=2.0,
                        help="Focal Loss γ (default: 2.0)")
    parser.add_argument("--label-smoothing", type=float, default=0.1,
                        help="Label smoothing ε (default: 0.1)")
    parser.add_argument("--dropout", type=float, default=0.3,
                        help="Classifier dropout (V1: 0.2, V2: 0.3)")
    parser.add_argument("--patience", type=int, default=7,
                        help="Early stopping patience (default: 7)")
    parser.add_argument("--max-grad-norm", type=float, default=1.0,
                        help="Gradient clipping max norm (default: 1.0)")
    parser.add_argument("--warmup-epochs", type=int, default=3,
                        help="Stage 1 warmup epochs with frozen backbone (default: 3)")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    data_root = Path(args.data_root).resolve()
    output_dir = Path(args.output).resolve()

    if not data_root.exists():
        print(f"⛔ Data root not found: {data_root}")
        sys.exit(1)

    try:
        train(
            data_root=data_root, output_dir=output_dir,
            epochs=args.epochs, batch_size=args.batch_size,
            num_workers=args.num_workers, lr=args.lr,
            weight_decay=args.weight_decay, gamma=args.gamma,
            label_smoothing=args.label_smoothing, dropout=args.dropout,
            patience=args.patience, max_grad_norm=args.max_grad_norm,
            warmup_epochs=args.warmup_epochs, verbose=args.verbose,
        )
    except KeyboardInterrupt:
        print("\n⚠ Training interrupted.")
        sys.exit(130)


if __name__ == "__main__":
    main()
