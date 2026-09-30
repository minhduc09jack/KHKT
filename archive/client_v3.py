#!/usr/bin/env python3
"""
client_v3.py — Flower Federated Learning Client (V3)
=============================================================================

Implements a NumPyClient for DenseNet-121 using Transfer Learning.
V3 Features:
- DenseNet-121 backbone (feature extractor is FROZEN).
- Only the classifier layer is trained.
- Focal Loss (gamma=2.0) with dynamic class weights (alpha) to combat label skew.
"""

from __future__ import annotations

import argparse
import logging
import sys
import warnings
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim import AdamW
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

import flwr as fl
from flwr.common import NDArrays, Scalar
from PIL import Image
from sklearn.metrics import f1_score

warnings.filterwarnings("ignore", category=UserWarning)

# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════

CLASS_NAMES: List[str] = ["Atelectasis", "Infiltration", "No Finding", "Pneumonia"]
NUM_CLASSES: int = len(CLASS_NAMES)
LABEL_TO_IDX: Dict[str, int] = {name: i for i, name in enumerate(CLASS_NAMES)}

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

LOG_FORMAT = "%(asctime)s │ %(name)-12s │ %(levelname)-8s │ %(message)s"

def setup_logging(client_name: str) -> logging.Logger:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, datefmt="%H:%M:%S")
    logger = logging.getLogger(client_name)
    logger.setLevel(logging.INFO)
    return logger

# ═══════════════════════════════════════════════════════════════════════════════
# FOCAL LOSS
# ═══════════════════════════════════════════════════════════════════════════════

class FocalLoss(nn.Module):
    def __init__(self, alpha: Optional[torch.Tensor] = None, gamma: float = 2.0, reduction: str = 'mean'):
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma
        self.reduction = reduction

    def forward(self, inputs: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        ce_loss = F.cross_entropy(inputs, targets, reduction='none', weight=self.alpha)
        pt = torch.exp(-ce_loss)
        focal_loss = ((1 - pt) ** self.gamma) * ce_loss
        
        if self.reduction == 'mean':
            return focal_loss.mean()
        elif self.reduction == 'sum':
            return focal_loss.sum()
        return focal_loss

# ═══════════════════════════════════════════════════════════════════════════════
# DATASET
# ═══════════════════════════════════════════════════════════════════════════════

class LocalChestXrayDataset(Dataset):
    def __init__(self, base_dir: Path, split: str, transform: Optional[transforms.Compose] = None) -> None:
        self.transform = transform
        self.image_paths: List[Path] = []
        self.labels: List[int] = []

        split_dir = base_dir / split
        if not split_dir.exists():
            return

        for label_dir in sorted(split_dir.iterdir()):
            if not label_dir.is_dir():
                continue
            label_name = label_dir.name.replace("_", " ")
            if label_name not in LABEL_TO_IDX:
                continue
            label_idx = LABEL_TO_IDX[label_name]
            for img_file in sorted(label_dir.glob("*.png")):
                self.image_paths.append(img_file)
                self.labels.append(label_idx)

    def __len__(self) -> int:
        return len(self.image_paths)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, int]:
        image = Image.open(self.image_paths[idx]).convert("RGB")
        if self.transform is not None:
            image = self.transform(image)
        return image, self.labels[idx]

def get_train_transforms(img_size: int = 224) -> transforms.Compose:
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
    return transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])

# ═══════════════════════════════════════════════════════════════════════════════
# MODEL (V3 CORE IMPROVEMENT)
# ═══════════════════════════════════════════════════════════════════════════════

def build_model(num_classes: int = NUM_CLASSES) -> nn.Module:
    # Use DenseNet-121
    weights = models.DenseNet121_Weights.DEFAULT
    model = models.densenet121(weights=weights)
    
    # TRANSFER LEARNING: Freeze all feature extractor parameters
    for param in model.parameters():
        param.requires_grad = False
        
    # Replace the classifier (this will automatically have requires_grad=True)
    in_features = model.classifier.in_features
    model.classifier = nn.Linear(in_features, num_classes)
    
    return model

def get_device() -> torch.device:
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")

# ═══════════════════════════════════════════════════════════════════════════════
# LOCAL TRAINING & EVALUATION
# ═══════════════════════════════════════════════════════════════════════════════

def train_local(
    model: nn.Module,
    train_loader: DataLoader,
    device: torch.device,
    epochs: int,
    lr: float,
    logger: logging.Logger,
) -> Dict[str, float]:
    model.train()
    model.to(device)

    # Compute class weights (alpha for Focal Loss)
    all_labels = train_loader.dataset.labels
    label_counts = np.bincount(all_labels, minlength=NUM_CLASSES).astype(np.float64)
    weights = np.zeros(NUM_CLASSES)
    for i in range(NUM_CLASSES):
        if label_counts[i] > 0:
            weights[i] = 1.0 / label_counts[i]
    w_sum = weights.sum()
    if w_sum > 0:
        weights = weights / w_sum * (label_counts > 0).sum()
    
    alpha_weights = torch.tensor(weights, dtype=torch.float32).to(device)

    criterion = FocalLoss(alpha=alpha_weights, gamma=2.0)
    
    # ONLY pass parameters that require gradients (the classifier) to the optimizer
    trainable_params = [p for p in model.parameters() if p.requires_grad]
    optimizer = AdamW(trainable_params, lr=lr, weight_decay=1e-4)

    total_loss = 0.0
    correct = 0
    total = 0

    for epoch in range(epochs):
        epoch_loss = 0.0
        epoch_correct = 0
        epoch_total = 0

        for images, labels in train_loader:
            images = images.to(device, non_blocking=True)
            labels = labels.to(device, non_blocking=True)

            optimizer.zero_grad(set_to_none=True)
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            batch_size = labels.size(0)
            epoch_loss += loss.item() * batch_size
            epoch_correct += (outputs.argmax(dim=1) == labels).sum().item()
            epoch_total += batch_size

        avg_loss = epoch_loss / max(epoch_total, 1)
        acc = epoch_correct / max(epoch_total, 1)
        logger.info(
            "  Local Epoch [%d/%d] │ Focal Loss: %.4f │ Acc: %.2f%%",
            epoch + 1, epochs, avg_loss, acc * 100,
        )

        total_loss += epoch_loss
        correct += epoch_correct
        total += epoch_total

        if device.type == "mps":
            torch.mps.empty_cache()

    return {
        "train_loss": total_loss / max(total, 1),
        "train_accuracy": correct / max(total, 1),
    }

@torch.no_grad()
def evaluate_local(
    model: nn.Module,
    val_loader: DataLoader,
    device: torch.device,
) -> Tuple[float, int, Dict[str, float]]:
    model.eval()
    model.to(device)
    
    criterion = nn.CrossEntropyLoss()
    running_loss = 0.0
    all_labels, all_preds = [], []
    num_samples = 0

    for images, labels in val_loader:
        images = images.to(device, non_blocking=True)
        labels = labels.to(device, non_blocking=True)

        outputs = model(images)
        loss = criterion(outputs, labels)

        batch_size = labels.size(0)
        running_loss += loss.item() * batch_size
        num_samples += batch_size

        all_labels.extend(labels.cpu().numpy().tolist())
        all_preds.extend(outputs.argmax(dim=1).cpu().numpy().tolist())

    avg_loss = running_loss / max(num_samples, 1)
    accuracy = float(np.mean(np.array(all_labels) == np.array(all_preds)))
    macro_f1 = float(f1_score(all_labels, all_preds, average="macro", zero_division=0))

    if device.type == "mps":
        torch.mps.empty_cache()

    return avg_loss, num_samples, {
        "val_loss": float(avg_loss),
        "val_accuracy": float(accuracy),
        "val_macro_f1": float(macro_f1),
    }

# ═══════════════════════════════════════════════════════════════════════════════
# FLOWER CLIENT
# ═══════════════════════════════════════════════════════════════════════════════

class ChestXrayClient(fl.client.NumPyClient):
    def __init__(
        self,
        client_dir: Path,
        batch_size: int = 32,
        local_epochs: int = 1,
        lr: float = 3e-4,
        num_workers: int = 4,
    ) -> None:
        self.client_name = client_dir.name
        self.logger = setup_logging(self.client_name[:12])
        self.device = get_device()
        self.local_epochs = local_epochs
        self.lr = lr

        self.logger.info("═" * 60)
        self.logger.info("🏥 Initializing FL V3 Client (DenseNet-121): %s", self.client_name)
        
        self.model = build_model(NUM_CLASSES).to(self.device)

        train_dataset = LocalChestXrayDataset(client_dir, "train", get_train_transforms())
        val_dataset = LocalChestXrayDataset(client_dir, "val", get_eval_transforms())

        loader_kwargs = {
            "batch_size": batch_size,
            "num_workers": num_workers,
            "pin_memory": False,
            "persistent_workers": num_workers > 0,
        }

        self.train_loader = DataLoader(train_dataset, shuffle=True, drop_last=True, **loader_kwargs)
        self.val_loader = DataLoader(val_dataset, shuffle=False, **loader_kwargs)

    def get_parameters(self, config: Dict[str, Scalar]) -> NDArrays:
        # Note: Sending the whole model (including frozen features) 
        # to ensure server can evaluate it.
        return [val.cpu().numpy() for _, val in self.model.state_dict().items()]

    def set_parameters(self, parameters: NDArrays) -> None:
        params_dict = zip(self.model.state_dict().keys(), parameters)
        state_dict = OrderedDict({k: torch.tensor(v) for k, v in params_dict})
        self.model.load_state_dict(state_dict, strict=True)

    def fit(self, parameters: NDArrays, config: Dict[str, Scalar]) -> Tuple[NDArrays, int, Dict[str, Scalar]]:
        self.set_parameters(parameters)
        epochs = int(config.get("local_epochs", self.local_epochs))
        lr = float(config.get("lr", self.lr))

        metrics = train_local(self.model, self.train_loader, self.device, epochs, lr, self.logger)
        return (self.get_parameters(config={}), len(self.train_loader.dataset), {k: float(v) for k, v in metrics.items()})

    def evaluate(self, parameters: NDArrays, config: Dict[str, Scalar]) -> Tuple[float, int, Dict[str, Scalar]]:
        self.set_parameters(parameters)
        loss, num_samples, metrics = evaluate_local(self.model, self.val_loader, self.device)
        return loss, num_samples, {k: float(v) for k, v in metrics.items()}

def main() -> None:
    parser = argparse.ArgumentParser(description="🏥 Flower FL Client V3 (DenseNet-121)")
    parser.add_argument("--client-dir", type=str, required=True)
    parser.add_argument("--server", type=str, default="127.0.0.1:8080")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--num-workers", type=int, default=2)
    args = parser.parse_args()

    client_dir = Path(args.client_dir).resolve()
    if not client_dir.exists():
        sys.exit(1)

    client = ChestXrayClient(
        client_dir=client_dir,
        batch_size=args.batch_size,
        local_epochs=args.epochs,
        lr=args.lr,
        num_workers=args.num_workers,
    )

    fl.client.start_client(server_address=args.server, client=client.to_client())

if __name__ == "__main__":
    main()
