#!/usr/bin/env python3
"""
client.py — Flower Federated Learning Client for Chest X-ray Classification
=============================================================================

Implements a NumPyClient that trains MobileNetV3-Small locally on one hospital's
data partition and communicates weight updates with the FL server.

Each client loads data from its own folder structure:
    <client_dir>/train/<LabelDir>/*.png
    <client_dir>/val/<LabelDir>/*.png

Usage:
    python3 client.py --client-dir ./federated_data/client_1_lung_hospital
    python3 client.py --client-dir ./federated_data/client_2_emergency_general --server 127.0.0.1:8080
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
# DATASET
# ═══════════════════════════════════════════════════════════════════════════════


class LocalChestXrayDataset(Dataset):
    """
    Reads images from folder structure:
        <base_dir>/<split>/<LabelDir>/*.png
    Follows symlinks transparently.
    """

    def __init__(
        self,
        base_dir: Path,
        split: str,
        transform: Optional[transforms.Compose] = None,
    ) -> None:
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
# MODEL
# ═══════════════════════════════════════════════════════════════════════════════


def build_model(num_classes: int = NUM_CLASSES) -> nn.Module:
    """MobileNetV3-Small with custom 4-class head."""
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = models.mobilenet_v3_small(weights=weights)
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, num_classes)
    return model


def get_device() -> torch.device:
    """Force MPS backend for Apple Silicon."""
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
    """
    Train the model locally for `epochs` epochs (one FL round).

    Returns:
        Dict with training metrics: loss, accuracy.
    """
    model.train()
    model.to(device)

    # Compute class weights from the local dataset for balanced CE
    all_labels = train_loader.dataset.labels
    label_counts = np.bincount(all_labels, minlength=NUM_CLASSES).astype(np.float64)
    # Safe weights: 0 for absent classes, inverse frequency for present ones
    weights = np.zeros(NUM_CLASSES)
    for i in range(NUM_CLASSES):
        if label_counts[i] > 0:
            weights[i] = 1.0 / label_counts[i]
    w_sum = weights.sum()
    if w_sum > 0:
        weights = weights / w_sum * (label_counts > 0).sum()
    class_weights = torch.tensor(weights, dtype=torch.float32).to(device)

    criterion = nn.CrossEntropyLoss(weight=class_weights)
    optimizer = AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

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
            "  Local Epoch [%d/%d] │ Loss: %.4f │ Acc: %.2f%%",
            epoch + 1, epochs, avg_loss, acc * 100,
        )

        total_loss += epoch_loss
        correct += epoch_correct
        total += epoch_total

        # MPS memory management
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
    """
    Evaluate model on local validation set.

    Returns:
        (loss, num_samples, metrics_dict)
    """
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

    # MPS cleanup
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
    """
    Flower NumPyClient for federated chest X-ray classification.

    Handles:
      - Loading/setting model parameters as NumPy arrays
      - Local training (fit) with MPS acceleration
      - Local evaluation (evaluate) returning metrics to the server
    """

    def __init__(
        self,
        client_dir: Path,
        batch_size: int = 64,
        local_epochs: int = 3,
        lr: float = 3e-4,
        num_workers: int = 4,
    ) -> None:
        self.client_name = client_dir.name
        self.logger = setup_logging(self.client_name[:12])
        self.device = get_device()
        self.local_epochs = local_epochs
        self.lr = lr

        self.logger.info("═" * 60)
        self.logger.info("🏥 Initializing FL Client: %s", self.client_name)
        self.logger.info("  Device: %s", self.device)

        # Build model
        self.model = build_model(NUM_CLASSES).to(self.device)

        # Build datasets and loaders
        train_dataset = LocalChestXrayDataset(
            client_dir, "train", get_train_transforms()
        )
        val_dataset = LocalChestXrayDataset(
            client_dir, "val", get_eval_transforms()
        )

        loader_kwargs = {
            "batch_size": batch_size,
            "num_workers": num_workers,
            "pin_memory": False,  # MPS doesn't support pinned memory
            "persistent_workers": num_workers > 0,
        }

        self.train_loader = DataLoader(
            train_dataset, shuffle=True, drop_last=True, **loader_kwargs
        )
        self.val_loader = DataLoader(
            val_dataset, shuffle=False, **loader_kwargs
        )

        # Log dataset stats
        train_counts = np.bincount(train_dataset.labels, minlength=NUM_CLASSES)
        self.logger.info("  Train: %d images", len(train_dataset))
        for i, name in enumerate(CLASS_NAMES):
            if train_counts[i] > 0:
                self.logger.info(
                    "    %-15s : %5d (%.1f%%)",
                    name, train_counts[i],
                    train_counts[i] / max(len(train_dataset), 1) * 100,
                )
        self.logger.info("  Val:   %d images", len(val_dataset))
        self.logger.info("═" * 60)

    def get_parameters(self, config: Dict[str, Scalar]) -> NDArrays:
        """Return model parameters as a list of NumPy arrays."""
        return [
            val.cpu().numpy()
            for _, val in self.model.state_dict().items()
        ]

    def set_parameters(self, parameters: NDArrays) -> None:
        """Set model parameters from a list of NumPy arrays."""
        params_dict = zip(self.model.state_dict().keys(), parameters)
        state_dict = OrderedDict(
            {k: torch.tensor(v) for k, v in params_dict}
        )
        self.model.load_state_dict(state_dict, strict=True)

    def fit(
        self, parameters: NDArrays, config: Dict[str, Scalar]
    ) -> Tuple[NDArrays, int, Dict[str, Scalar]]:
        """
        Receive global parameters, train locally, return updated parameters.

        Args:
            parameters: Global model weights from the server.
            config:     Configuration dict (can contain 'local_epochs', 'lr').

        Returns:
            (updated_parameters, num_train_samples, metrics_dict)
        """
        # Apply global parameters
        self.set_parameters(parameters)

        # Allow server to override local config
        epochs = int(config.get("local_epochs", self.local_epochs))
        lr = float(config.get("lr", self.lr))

        self.logger.info("🏋️  FIT round │ epochs=%d │ lr=%.1e", epochs, lr)

        # Train locally
        metrics = train_local(
            self.model, self.train_loader, self.device, epochs, lr, self.logger
        )

        # Return updated parameters + num samples + metrics
        return (
            self.get_parameters(config={}),
            len(self.train_loader.dataset),
            {k: float(v) for k, v in metrics.items()},
        )

    def evaluate(
        self, parameters: NDArrays, config: Dict[str, Scalar]
    ) -> Tuple[float, int, Dict[str, Scalar]]:
        """
        Evaluate the global model on local validation data.

        Returns:
            (loss, num_val_samples, metrics_dict)
        """
        self.set_parameters(parameters)

        loss, num_samples, metrics = evaluate_local(
            self.model, self.val_loader, self.device
        )

        self.logger.info(
            "📊 EVALUATE │ Loss: %.4f │ Acc: %.2f%% │ F1: %.4f │ n=%d",
            loss, metrics["val_accuracy"] * 100,
            metrics["val_macro_f1"], num_samples,
        )

        return loss, num_samples, {k: float(v) for k, v in metrics.items()}


# ═══════════════════════════════════════════════════════════════════════════════
# CLI & MAIN
# ═══════════════════════════════════════════════════════════════════════════════


def main() -> None:
    parser = argparse.ArgumentParser(
        description="🏥 Flower FL Client — Chest X-ray Classification"
    )
    parser.add_argument(
        "--client-dir", type=str, required=True,
        help="Path to client data directory (e.g., ./federated_data/client_1_lung_hospital)",
    )
    parser.add_argument("--server", type=str, default="127.0.0.1:8080",
                        help="Server address (default: 127.0.0.1:8080)")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=3,
                        help="Local epochs per FL round (default: 3)")
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--num-workers", type=int, default=2)

    args = parser.parse_args()
    client_dir = Path(args.client_dir).resolve()

    if not client_dir.exists():
        print(f"⛔ Client directory not found: {client_dir}")
        sys.exit(1)

    # Create and start Flower client
    client = ChestXrayClient(
        client_dir=client_dir,
        batch_size=args.batch_size,
        local_epochs=args.epochs,
        lr=args.lr,
        num_workers=args.num_workers,
    )

    fl.client.start_client(
        server_address=args.server,
        client=client.to_client(),
    )


if __name__ == "__main__":
    main()
