#!/usr/bin/env python3
"""
train_centralized_virtual.py — Centralized Baseline for Federated Chest X-ray Classification
=============================================================================================

Trains a MobileNetV3-Small on the *virtual union* of all 3 federated client datasets
WITHOUT physically copying or duplicating any image files.

Architecture  : MobileNetV3-Small (ImageNet pre-trained) → 4-class head
Classes       : Pneumonia | Infiltration | Atelectasis | No Finding
Hardware      : Apple Silicon M3 Pro — MPS backend
Metrics       : Loss, Accuracy, Macro F1, Macro AUC (One-vs-Rest)

Usage:
    python3 train_centralized_virtual.py --data-root ./federated_data
    python3 train_centralized_virtual.py --data-root ./federated_data --epochs 30 --batch-size 32
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
from torch.optim import AdamW
from torch.optim.lr_scheduler import CosineAnnealingLR
from torch.utils.data import ConcatDataset, DataLoader, Dataset
from torchvision import models, transforms

from PIL import Image
from sklearn.metrics import f1_score, roc_auc_score

# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════

CLASS_NAMES: List[str] = ["Atelectasis", "Infiltration", "No Finding", "Pneumonia"]
NUM_CLASSES: int = len(CLASS_NAMES)
LABEL_TO_IDX: Dict[str, int] = {name: i for i, name in enumerate(CLASS_NAMES)}

# ImageNet normalization (required for pre-trained backbone)
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

CLIENT_DIRS: List[str] = [
    "client_1_lung_hospital",
    "client_2_emergency_general",
    "client_3_screening_clinic",
]

LOG_FORMAT = "%(asctime)s │ %(levelname)-8s │ %(message)s"

# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════════


def setup_logging(verbose: bool = False) -> logging.Logger:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format=LOG_FORMAT, datefmt="%H:%M:%S")
    logger = logging.getLogger("centralized")
    logger.setLevel(level)
    return logger


# ═══════════════════════════════════════════════════════════════════════════════
# DATASET: Folder-based — reads label from parent directory name
# ═══════════════════════════════════════════════════════════════════════════════


class NIHChestXrayDataset(Dataset):
    """
    PyTorch Dataset that reads images from the folder structure:
        <client_dir>/<split>/<LabelDir>/<image>.png

    Symlinks are followed transparently by PIL/OS, so no data
    duplication is required.

    Args:
        image_paths: List of absolute/relative paths to image files.
        labels:      Corresponding integer label for each image.
        transform:   torchvision transform pipeline.
    """

    def __init__(
        self,
        image_paths: List[Path],
        labels: List[int],
        transform: Optional[transforms.Compose] = None,
    ) -> None:
        assert len(image_paths) == len(labels), (
            f"Mismatch: {len(image_paths)} images vs {len(labels)} labels"
        )
        self.image_paths = image_paths
        self.labels = labels
        self.transform = transform

    def __len__(self) -> int:
        return len(self.image_paths)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, int]:
        img_path = self.image_paths[idx]
        label = self.labels[idx]

        # Open and convert to RGB (X-rays are grayscale but backbone expects 3ch)
        image = Image.open(img_path).convert("RGB")

        if self.transform is not None:
            image = self.transform(image)

        return image, label


def _scan_folder_split(
    base_dir: Path,
    split: str,
    label_to_idx: Dict[str, int],
) -> Tuple[List[Path], List[int]]:
    """
    Scan <base_dir>/<split>/<LabelDir>/*.png and return paths + labels.
    Handles label directory naming: 'No_Finding' → 'No Finding'.
    """
    split_dir = base_dir / split
    paths: List[Path] = []
    labels: List[int] = []

    if not split_dir.exists():
        return paths, labels

    for label_dir in sorted(split_dir.iterdir()):
        if not label_dir.is_dir():
            continue

        # Map folder name back to canonical label
        label_name = label_dir.name.replace("_", " ")
        if label_name not in label_to_idx:
            continue

        label_idx = label_to_idx[label_name]
        for img_file in sorted(label_dir.glob("*.png")):
            paths.append(img_file)
            labels.append(label_idx)

    return paths, labels


def build_virtual_dataset(
    data_root: Path,
    split: str,
    transform: transforms.Compose,
    logger: logging.Logger,
) -> NIHChestXrayDataset:
    """
    Virtually aggregate a split ('train' or 'val') across all 3 clients
    by concatenating their file paths into a single Dataset instance.
    Zero file duplication — symlinks are read in-place.
    """
    all_paths: List[Path] = []
    all_labels: List[int] = []

    for client_dir_name in CLIENT_DIRS:
        client_path = data_root / client_dir_name
        paths, labels = _scan_folder_split(client_path, split, LABEL_TO_IDX)
        all_paths.extend(paths)
        all_labels.extend(labels)
        logger.info(
            "  %-35s │ %s │ %5d images",
            client_dir_name, split, len(paths),
        )

    dataset = NIHChestXrayDataset(all_paths, all_labels, transform=transform)
    logger.info("  %-35s │ %s │ %5d images (merged)", "TOTAL", split, len(dataset))
    return dataset


def build_test_dataset(
    data_root: Path,
    transform: transforms.Compose,
    logger: logging.Logger,
) -> NIHChestXrayDataset:
    """Build the global test dataset from federated_data/global_test/<LabelDir>/."""
    test_dir = data_root / "global_test"
    paths: List[Path] = []
    labels: List[int] = []

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
# TRANSFORMS
# ═══════════════════════════════════════════════════════════════════════════════


def get_train_transforms(img_size: int = 224) -> transforms.Compose:
    """Training augmentation pipeline optimized for chest X-ray."""
    return transforms.Compose([
        transforms.Resize((img_size + 32, img_size + 32)),
        transforms.RandomCrop(img_size),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.RandomRotation(degrees=10),
        transforms.ColorJitter(brightness=0.15, contrast=0.15),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])


def get_eval_transforms(img_size: int = 224) -> transforms.Compose:
    """Deterministic transform for validation/test."""
    return transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])


# ═══════════════════════════════════════════════════════════════════════════════
# MODEL
# ═══════════════════════════════════════════════════════════════════════════════


def build_model(num_classes: int = NUM_CLASSES) -> nn.Module:
    """
    MobileNetV3-Small with ImageNet pre-trained weights.
    Replace the final classifier head for 4-class chest X-ray classification.
    """
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = models.mobilenet_v3_small(weights=weights)

    # Original classifier: Sequential(Linear(576, 1024), Hardswish, Dropout, Linear(1024, 1000))
    # Replace only the final Linear layer to preserve learned features
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, num_classes)

    return model


# ═══════════════════════════════════════════════════════════════════════════════
# DEVICE SETUP
# ═══════════════════════════════════════════════════════════════════════════════


def get_device(logger: logging.Logger) -> torch.device:
    """Select MPS (Apple Silicon) → CUDA → CPU with fallback."""
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        device = torch.device("mps")
        logger.info("  🍎 Using Apple MPS (Metal Performance Shaders)")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
        logger.info("  🟢 Using NVIDIA CUDA")
    else:
        device = torch.device("cpu")
        logger.warning("  ⚠ Falling back to CPU — training will be slow")
    return device


# ═══════════════════════════════════════════════════════════════════════════════
# METRICS COMPUTATION
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class EpochMetrics:
    """Metrics for a single epoch."""

    epoch: int
    loss: float
    accuracy: float
    macro_f1: float
    macro_auc: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "epoch": self.epoch,
            "loss": round(self.loss, 6),
            "accuracy": round(self.accuracy, 4),
            "macro_f1": round(self.macro_f1, 4),
            "macro_auc": round(self.macro_auc, 4),
        }


def compute_metrics(
    all_labels: np.ndarray,
    all_preds: np.ndarray,
    all_probs: np.ndarray,
    total_loss: float,
    num_samples: int,
) -> Tuple[float, float, float, float]:
    """
    Compute: avg loss, accuracy, macro F1, macro AUC (OvR).

    Returns:
        (loss, accuracy, macro_f1, macro_auc)
    """
    avg_loss = total_loss / max(num_samples, 1)
    accuracy = float(np.mean(all_labels == all_preds))
    macro_f1 = float(f1_score(all_labels, all_preds, average="macro", zero_division=0))

    # Macro AUC (One-vs-Rest) — handle edge cases where a class may be absent
    try:
        # Only compute AUC if we have at least 2 classes present in ground truth
        unique_labels = np.unique(all_labels)
        if len(unique_labels) >= 2:
            macro_auc = float(
                roc_auc_score(
                    all_labels, all_probs, multi_class="ovr", average="macro"
                )
            )
        else:
            macro_auc = 0.0
    except ValueError:
        macro_auc = 0.0

    return avg_loss, accuracy, macro_f1, macro_auc


# ═══════════════════════════════════════════════════════════════════════════════
# TRAINING & EVALUATION LOOPS
# ═══════════════════════════════════════════════════════════════════════════════


def train_one_epoch(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    optimizer: torch.optim.Optimizer,
    device: torch.device,
    epoch: int,
    logger: logging.Logger,
) -> EpochMetrics:
    """Train for one epoch, return metrics."""
    model.train()

    running_loss = 0.0
    all_labels: List[int] = []
    all_preds: List[int] = []
    all_probs: List[np.ndarray] = []
    num_samples = 0

    num_batches = len(loader)
    log_interval = max(1, num_batches // 5)  # Log ~5 times per epoch

    for batch_idx, (images, labels) in enumerate(loader):
        images = images.to(device, non_blocking=True)
        labels = labels.to(device, non_blocking=True)

        optimizer.zero_grad(set_to_none=True)
        outputs = model(images)
        loss = criterion(outputs, labels)
        loss.backward()
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
            avg = running_loss / num_samples
            logger.debug(
                "    Batch [%3d/%3d] │ Loss: %.4f",
                batch_idx + 1, num_batches, avg,
            )

    all_labels_arr = np.array(all_labels)
    all_preds_arr = np.array(all_preds)
    all_probs_arr = np.vstack(all_probs)

    avg_loss, accuracy, macro_f1, macro_auc = compute_metrics(
        all_labels_arr, all_preds_arr, all_probs_arr, running_loss, num_samples
    )

    return EpochMetrics(
        epoch=epoch, loss=avg_loss, accuracy=accuracy,
        macro_f1=macro_f1, macro_auc=macro_auc,
    )


@torch.no_grad()
def evaluate(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    device: torch.device,
    epoch: int = -1,
) -> EpochMetrics:
    """Evaluate model on a DataLoader (val or test)."""
    model.eval()

    running_loss = 0.0
    all_labels: List[int] = []
    all_preds: List[int] = []
    all_probs: List[np.ndarray] = []
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
        labels_np = labels.cpu().numpy()

        all_labels.extend(labels_np.tolist())
        all_preds.extend(preds.tolist())
        all_probs.append(probs)

    all_labels_arr = np.array(all_labels)
    all_preds_arr = np.array(all_preds)
    all_probs_arr = np.vstack(all_probs)

    avg_loss, accuracy, macro_f1, macro_auc = compute_metrics(
        all_labels_arr, all_preds_arr, all_probs_arr, running_loss, num_samples
    )

    return EpochMetrics(
        epoch=epoch, loss=avg_loss, accuracy=accuracy,
        macro_f1=macro_f1, macro_auc=macro_auc,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN TRAINING PIPELINE
# ═══════════════════════════════════════════════════════════════════════════════


def train(
    data_root: Path,
    output_dir: Path,
    epochs: int,
    batch_size: int,
    num_workers: int,
    lr: float,
    weight_decay: float,
    verbose: bool,
) -> None:
    """Full centralized training pipeline."""
    logger = setup_logging(verbose)

    logger.info("╔══════════════════════════════════════════════════════════════╗")
    logger.info("║  🏥 Centralized Baseline — MobileNetV3-Small              ║")
    logger.info("║  Virtual Aggregation │ Zero Data Duplication │ MPS        ║")
    logger.info("╚══════════════════════════════════════════════════════════════╝")

    device = get_device(logger)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Build Datasets ────────────────────────────────────────────────────────
    logger.info("═" * 65)
    logger.info("📂 Building virtual aggregated datasets...")

    train_transform = get_train_transforms()
    eval_transform = get_eval_transforms()

    train_dataset = build_virtual_dataset(data_root, "train", train_transform, logger)
    val_dataset = build_virtual_dataset(data_root, "val", eval_transform, logger)
    test_dataset = build_test_dataset(data_root, eval_transform, logger)

    # Log class distribution
    train_label_counts = np.bincount(train_dataset.labels, minlength=NUM_CLASSES)
    logger.info("  Train class distribution:")
    for i, name in enumerate(CLASS_NAMES):
        logger.info("    %-15s : %5d (%.1f%%)", name, train_label_counts[i],
                     train_label_counts[i] / len(train_dataset) * 100)

    # ── DataLoaders ───────────────────────────────────────────────────────────
    # persistent_workers keeps worker processes alive between epochs (faster)
    # pin_memory=False for MPS (Metal doesn't support pinned memory)
    loader_kwargs = {
        "batch_size": batch_size,
        "num_workers": num_workers,
        "pin_memory": False,  # MPS does not support pinned memory
        "persistent_workers": num_workers > 0,
        "prefetch_factor": 4 if num_workers > 0 else None,
    }

    train_loader = DataLoader(train_dataset, shuffle=True, drop_last=True, **loader_kwargs)
    val_loader = DataLoader(val_dataset, shuffle=False, **loader_kwargs)
    test_loader = DataLoader(test_dataset, shuffle=False, **loader_kwargs)

    logger.info("  DataLoaders: batch=%d, workers=%d", batch_size, num_workers)

    # ── Model ─────────────────────────────────────────────────────────────────
    logger.info("═" * 65)
    logger.info("🧠 Building MobileNetV3-Small (pre-trained → %d classes)", NUM_CLASSES)
    model = build_model(NUM_CLASSES).to(device)
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    logger.info("  Parameters: %s total, %s trainable",
                f"{total_params:,}", f"{trainable_params:,}")

    # ── Loss, Optimizer, Scheduler ────────────────────────────────────────────
    # Class weights to handle severe imbalance (No Finding >> Pneumonia)
    class_counts = np.bincount(train_dataset.labels, minlength=NUM_CLASSES).astype(np.float64)
    class_weights = 1.0 / np.maximum(class_counts, 1.0)
    class_weights = class_weights / class_weights.sum() * NUM_CLASSES  # normalize
    class_weights_tensor = torch.tensor(class_weights, dtype=torch.float32).to(device)
    logger.info("  Class weights: %s", {CLASS_NAMES[i]: f"{w:.3f}" for i, w in enumerate(class_weights)})

    criterion = nn.CrossEntropyLoss(weight=class_weights_tensor)
    optimizer = AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    scheduler = CosineAnnealingLR(optimizer, T_max=epochs, eta_min=lr * 0.01)

    logger.info("  Optimizer: AdamW (lr=%.1e, wd=%.1e)", lr, weight_decay)
    logger.info("  Scheduler: CosineAnnealingLR (T_max=%d)", epochs)

    # ── Training Loop ─────────────────────────────────────────────────────────
    logger.info("═" * 65)
    logger.info("🚀 Starting training for %d epochs...", epochs)
    logger.info("═" * 65)

    best_f1 = 0.0
    best_epoch = -1
    checkpoint_path = output_dir / "best_centralized.pth"
    history: List[Dict[str, Any]] = []

    for epoch in range(1, epochs + 1):
        epoch_start = time.time()

        # Train
        train_metrics = train_one_epoch(
            model, train_loader, criterion, optimizer, device, epoch, logger
        )

        # Validate
        val_metrics = evaluate(model, val_loader, criterion, device, epoch)

        # Step scheduler
        scheduler.step()
        current_lr = optimizer.param_groups[0]["lr"]

        epoch_time = time.time() - epoch_start

        # Log
        logger.info(
            "Epoch [%2d/%2d] │ %5.1fs │ LR: %.2e │ "
            "Train[L:%.4f A:%.2f%% F1:%.4f] │ "
            "Val[L:%.4f A:%.2f%% F1:%.4f AUC:%.4f]",
            epoch, epochs, epoch_time, current_lr,
            train_metrics.loss, train_metrics.accuracy * 100, train_metrics.macro_f1,
            val_metrics.loss, val_metrics.accuracy * 100, val_metrics.macro_f1, val_metrics.macro_auc,
        )

        # Checkpoint on best Macro F1
        if val_metrics.macro_f1 > best_f1:
            best_f1 = val_metrics.macro_f1
            best_epoch = epoch
            torch.save(model.state_dict(), checkpoint_path)
            logger.info(
                "  ★ New best model saved! Macro F1: %.4f → %s",
                best_f1, checkpoint_path.name,
            )

        # Record history
        history.append({
            "epoch": epoch,
            "lr": round(current_lr, 8),
            "train": train_metrics.to_dict(),
            "val": val_metrics.to_dict(),
            "epoch_time_sec": round(epoch_time, 2),
        })

        # MPS memory management — prevent unified memory leaks
        if device.type == "mps":
            torch.mps.empty_cache()

    logger.info("═" * 65)
    logger.info("✅ Training complete. Best epoch: %d (Macro F1: %.4f)", best_epoch, best_f1)

    # ── Final Evaluation on Global Test ───────────────────────────────────────
    logger.info("═" * 65)
    logger.info("🧪 Evaluating best model on Global Test Set...")

    # Reload best checkpoint
    model.load_state_dict(torch.load(checkpoint_path, map_location=device, weights_only=True))
    test_metrics = evaluate(model, test_loader, criterion, device, epoch=-1)

    logger.info(
        "  Global Test │ Loss: %.4f │ Acc: %.2f%% │ F1: %.4f │ AUC: %.4f",
        test_metrics.loss,
        test_metrics.accuracy * 100,
        test_metrics.macro_f1,
        test_metrics.macro_auc,
    )

    # ── Export Metrics JSON ────────────────────────────────────────────────────
    metrics_path = output_dir / "centralized_baseline_metrics.json"
    report = {
        "experiment": "centralized_baseline",
        "model": "MobileNetV3-Small",
        "num_classes": NUM_CLASSES,
        "class_names": CLASS_NAMES,
        "config": {
            "epochs": epochs,
            "batch_size": batch_size,
            "lr": lr,
            "weight_decay": weight_decay,
            "optimizer": "AdamW",
            "scheduler": "CosineAnnealingLR",
            "img_size": 224,
            "device": str(device),
        },
        "dataset_sizes": {
            "train": len(train_dataset),
            "val": len(val_dataset),
            "test": len(test_dataset),
        },
        "class_weights": {CLASS_NAMES[i]: round(w, 4) for i, w in enumerate(class_weights)},
        "best_epoch": best_epoch,
        "best_val_macro_f1": round(best_f1, 4),
        "training_history": history,
        "global_test_results": test_metrics.to_dict(),
        "checkpoint_path": str(checkpoint_path),
    }

    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    logger.info("  📊 Metrics exported: %s", metrics_path)
    logger.info("  💾 Best model saved: %s", checkpoint_path)
    logger.info("═" * 65)
    logger.info("🎉 DONE — Centralized baseline ready for FL comparison.")

    # Final MPS cleanup
    if device.type == "mps":
        torch.mps.empty_cache()


# ═══════════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════════


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="train_centralized_virtual",
        description=(
            "🏥 Centralized Baseline — MobileNetV3-Small\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "Trains on the virtual union of all 3 federated client datasets\n"
            "WITHOUT physically copying any files. Evaluates on global_test."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--data-root", type=str, required=True,
        help="Path to federated_data/ directory",
    )
    parser.add_argument(
        "--output", type=str, default="./centralized_output",
        help="Output directory for model + metrics (default: ./centralized_output)",
    )
    parser.add_argument(
        "--epochs", type=int, default=15,
        help="Number of training epochs (default: 15)",
    )
    parser.add_argument(
        "--batch-size", type=int, default=64,
        help="Batch size (default: 64)",
    )
    parser.add_argument(
        "--num-workers", type=int, default=4,
        help="DataLoader workers (default: 4)",
    )
    parser.add_argument(
        "--lr", type=float, default=3e-4,
        help="Initial learning rate (default: 3e-4)",
    )
    parser.add_argument(
        "--weight-decay", type=float, default=1e-4,
        help="AdamW weight decay (default: 1e-4)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug-level logging",
    )

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
            data_root=data_root,
            output_dir=output_dir,
            epochs=args.epochs,
            batch_size=args.batch_size,
            num_workers=args.num_workers,
            lr=args.lr,
            weight_decay=args.weight_decay,
            verbose=args.verbose,
        )
    except KeyboardInterrupt:
        print("\n⚠ Training interrupted by user (Ctrl+C).")
        sys.exit(130)


if __name__ == "__main__":
    main()
