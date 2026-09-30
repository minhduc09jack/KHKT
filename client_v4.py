#!/usr/bin/env python3
"""
client_v4.py — Flower Federated Learning Client (V4 - ENSEMBLE)
=============================================================================

Architecture: DenseNet-121 + EfficientNet-B0 (Soft Voting)
Loss: Weighted Binary Cross-Entropy (via CrossEntropy with class weights)
Preprocessing: CLAHE (Contrast Limited Adaptive Histogram Equalization)
"""

from __future__ import annotations

import argparse
import logging
import sys
import warnings
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
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

CLASS_NAMES: List[str] = ["NORMAL", "PNEUMONIA"]
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
# PREPROCESSING (CLAHE)
# ═══════════════════════════════════════════════════════════════════════════════

class CLAHE_Transform:
    """Applies Contrast Limited Adaptive Histogram Equalization to X-Ray images."""
    def __init__(self, clip_limit=2.0, tile_grid_size=(8, 8)):
        self.clip_limit = clip_limit
        self.tile_grid_size = tile_grid_size

    def __call__(self, img: Image.Image) -> Image.Image:
        img_np = np.array(img)
        # Apply CLAHE on the Lightness channel of LAB color space
        lab = cv2.cvtColor(img_np, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=self.clip_limit, tileGridSize=self.tile_grid_size)
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        final = cv2.cvtColor(limg, cv2.COLOR_LAB2RGB)
        return Image.fromarray(final)

# ═══════════════════════════════════════════════════════════════════════════════
# DATASET
# ═══════════════════════════════════════════════════════════════════════════════

class LocalChestXrayDataset(Dataset):
    def __init__(self, base_dir: Path, split: str, transform: Optional[transforms.Compose] = None) -> None:
        self.transform = transform
        self.image_paths: List[Path] = []
        self.labels: List[int] = []

        split_dir = base_dir / split
        if not split_dir.exists(): return

        for label_dir in sorted(split_dir.iterdir()):
            if not label_dir.is_dir(): continue
            label_name = label_dir.name
            if label_name not in LABEL_TO_IDX: continue
            label_idx = LABEL_TO_IDX[label_name]
            for img_file in sorted(label_dir.glob("*.jpeg")):
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
        CLAHE_Transform(), # Feature enhancement directly at client edge
        transforms.Resize((img_size + 32, img_size + 32)),
        transforms.RandomCrop(img_size),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.RandomRotation(degrees=10),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])

def get_eval_transforms(img_size: int = 224) -> transforms.Compose:
    return transforms.Compose([
        CLAHE_Transform(),
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])

# ═══════════════════════════════════════════════════════════════════════════════
# ENSEMBLE MODEL (DenseNet121 + EfficientNet-B0)
# ═══════════════════════════════════════════════════════════════════════════════

class ChestXrayEnsemble(nn.Module):
    def __init__(self, num_classes: int = NUM_CLASSES):
        super().__init__()
        # Branch 1: DenseNet-121 (Dense local features)
        self.densenet = models.densenet121(weights=models.DenseNet121_Weights.DEFAULT)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, num_classes)
        
        # Branch 2: EfficientNet-B0 (Global context, highly efficient)
        self.efficientnet = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT)
        self.efficientnet.classifier[1] = nn.Linear(self.efficientnet.classifier[1].in_features, num_classes)
        
    def forward(self, x):
        # Soft Voting: Average the logits of both branches
        out_d = self.densenet(x)
        out_e = self.efficientnet(x)
        return (out_d + out_e) / 2.0

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

    # Compute class weights for Weighted BCE (Implemented via CrossEntropy)
    # Penalize heavily if misclassifying the minority class (NORMAL)
    all_labels = train_loader.dataset.labels
    num_normal = sum(1 for l in all_labels if l == 0)
    num_pneumonia = sum(1 for l in all_labels if l == 1)
    
    # Weight for NORMAL = N_Pneumonia / N_Normal (~3x penalty)
    # Weight for PNEUMONIA = 1.0
    weight_normal = float(num_pneumonia) / max(num_normal, 1)
    weights = torch.tensor([weight_normal, 1.0], dtype=torch.float32).to(device)
    logger.info("  Weighted BCE Multipliers -> NORMAL: %.2fx, PNEUMONIA: 1.00x", weight_normal)

    criterion = nn.CrossEntropyLoss(weight=weights)
    
    # Optimize entire Ensemble Model
    optimizer = AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    total_loss, correct, total = 0.0, 0, 0

    for epoch in range(epochs):
        epoch_loss, epoch_correct, epoch_total = 0.0, 0, 0
        for images, labels in train_loader:
            images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)

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
        logger.info("  Epoch [%d/%d] │ Loss: %.4f │ Acc: %.2f%%", epoch + 1, epochs, avg_loss, acc * 100)

        total_loss += epoch_loss
        correct += epoch_correct
        total += epoch_total

        if device.type == "mps": torch.mps.empty_cache()

    return {"train_loss": total_loss / max(total, 1), "train_accuracy": correct / max(total, 1)}

@torch.no_grad()
def evaluate_local(model: nn.Module, val_loader: DataLoader, device: torch.device) -> Tuple[float, int, Dict[str, float]]:
    model.eval()
    model.to(device)
    criterion = nn.CrossEntropyLoss()
    running_loss, num_samples = 0.0, 0
    all_labels, all_preds = [], []

    for images, labels in val_loader:
        images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)
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

    if device.type == "mps": torch.mps.empty_cache()

    return avg_loss, num_samples, {"val_loss": float(avg_loss), "val_accuracy": float(accuracy), "val_macro_f1": float(macro_f1)}

# ═══════════════════════════════════════════════════════════════════════════════
# FLOWER CLIENT
# ═══════════════════════════════════════════════════════════════════════════════

class ChestXrayClient(fl.client.NumPyClient):
    def __init__(self, client_dir: Path, batch_size: int, local_epochs: int, lr: float, num_workers: int) -> None:
        self.client_name = client_dir.name
        self.logger = setup_logging(self.client_name[:12])
        self.device = get_device()
        self.local_epochs = local_epochs
        self.lr = lr

        self.logger.info("═" * 60)
        self.logger.info("🏥 FL V4 Client (DenseNet+EfficientNet Ensemble): %s", self.client_name)
        
        self.model = ChestXrayEnsemble(NUM_CLASSES).to(self.device)

        train_dataset = LocalChestXrayDataset(client_dir, "train", get_train_transforms())
        val_dataset = LocalChestXrayDataset(client_dir, "val", get_eval_transforms())

        kwargs = {"batch_size": batch_size, "num_workers": num_workers, "pin_memory": False, "persistent_workers": num_workers > 0}
        self.train_loader = DataLoader(train_dataset, shuffle=True, drop_last=True, **kwargs)
        self.val_loader = DataLoader(val_dataset, shuffle=False, **kwargs)

    def get_parameters(self, config: Dict[str, Scalar]) -> NDArrays:
        return [val.cpu().numpy() for _, val in self.model.state_dict().items()]

    def set_parameters(self, parameters: NDArrays) -> None:
        params_dict = zip(self.model.state_dict().keys(), parameters)
        self.model.load_state_dict(OrderedDict({k: torch.tensor(v) for k, v in params_dict}), strict=True)

    def fit(self, parameters: NDArrays, config: Dict[str, Scalar]) -> Tuple[NDArrays, int, Dict[str, Scalar]]:
        self.set_parameters(parameters)
        epochs = int(config.get("local_epochs", self.local_epochs))
        metrics = train_local(self.model, self.train_loader, self.device, epochs, self.lr, self.logger)
        return self.get_parameters(config={}), len(self.train_loader.dataset), metrics

    def evaluate(self, parameters: NDArrays, config: Dict[str, Scalar]) -> Tuple[float, int, Dict[str, Scalar]]:
        self.set_parameters(parameters)
        loss, num_samples, metrics = evaluate_local(self.model, self.val_loader, self.device)
        return loss, num_samples, metrics

def main() -> None:
    parser = argparse.ArgumentParser(description="🏥 Flower FL Client V4")
    parser.add_argument("--client-dir", type=str, required=True)
    parser.add_argument("--server", type=str, default="127.0.0.1:8080")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--num-workers", type=int, default=2)
    args = parser.parse_args()

    client = ChestXrayClient(Path(args.client_dir).resolve(), args.batch_size, args.epochs, args.lr, args.num_workers)
    fl.client.start_client(server_address=args.server, client=client.to_client())

if __name__ == "__main__": main()
