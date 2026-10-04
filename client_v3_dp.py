#!/usr/bin/env python3
"""
client_v3_dp.py — FL Client with DIFFERENTIAL PRIVACY (LDP)
=============================================================================
Architecture: DenseNet-121 + EfficientNet-B0
Privacy: Client-Level Gradient Clipping + Gaussian Noise
"""

from __future__ import annotations
import argparse
import logging
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
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

CLASS_NAMES = ["NORMAL", "PNEUMONIA"]
NUM_CLASSES = len(CLASS_NAMES)
LABEL_TO_IDX = {name: i for i, name in enumerate(CLASS_NAMES)}

LOG_FORMAT = "%(asctime)s │ %(name)-12s │ %(levelname)-8s │ %(message)s"

def setup_logging(client_name: str) -> logging.Logger:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, datefmt="%H:%M:%S")
    logger = logging.getLogger(client_name)
    logger.setLevel(logging.INFO)
    return logger

class CLAHE_Transform:
    def __init__(self, clip_limit=2.0, tile_grid_size=(8, 8)):
        self.clip_limit = clip_limit
        self.tile_grid_size = tile_grid_size
    def __call__(self, img: Image.Image) -> Image.Image:
        img_np = np.array(img)
        lab = cv2.cvtColor(img_np, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=self.clip_limit, tileGridSize=self.tile_grid_size)
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        final = cv2.cvtColor(limg, cv2.COLOR_LAB2RGB)
        return Image.fromarray(final)

class LocalChestXrayDataset(Dataset):
    def __init__(self, base_dir: Path, split: str, transform=None):
        self.transform = transform
        self.image_paths, self.labels = [], []
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
    def __len__(self): return len(self.image_paths)
    def __getitem__(self, idx):
        image = Image.open(self.image_paths[idx]).convert("RGB")
        if self.transform: image = self.transform(image)
        return image, self.labels[idx]

def get_train_transforms():
    return transforms.Compose([
        CLAHE_Transform(),
        transforms.Resize((256, 256)),
        transforms.RandomCrop(224),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])

def get_eval_transforms():
    return transforms.Compose([
        CLAHE_Transform(),
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])

class ChestXrayEnsemble(nn.Module):
    def __init__(self, num_classes=NUM_CLASSES):
        super().__init__()
        self.densenet = models.densenet121(weights=models.DenseNet121_Weights.DEFAULT)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, num_classes)
        self.efficientnet = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT)
        self.efficientnet.classifier[1] = nn.Linear(self.efficientnet.classifier[1].in_features, num_classes)
    def forward(self, x):
        return (self.densenet(x) + self.efficientnet(x)) / 2.0

def get_device():
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")

def train_local(model, train_loader, device, epochs, lr, logger):
    model.train()
    model.to(device)
    
    all_labels = train_loader.dataset.labels
    weight_normal = float(all_labels.count(1)) / max(all_labels.count(0), 1)
    weights = torch.tensor([weight_normal, 1.0], dtype=torch.float32).to(device)
    criterion = nn.CrossEntropyLoss(weight=weights)
    optimizer = AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    for epoch in range(epochs):
        for images, labels in train_loader:
            images, labels = images.to(device), labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()
    if device.type == "mps": torch.mps.empty_cache()
    return {}

@torch.no_grad()
def evaluate_local(model, val_loader, device):
    model.eval()
    model.to(device)
    criterion = nn.CrossEntropyLoss()
    running_loss, num_samples = 0.0, 0
    all_labels, all_preds = [], []
    for images, labels in val_loader:
        images, labels = images.to(device), labels.to(device)
        outputs = model(images)
        loss = criterion(outputs, labels)
        running_loss += loss.item() * labels.size(0)
        num_samples += labels.size(0)
        all_labels.extend(labels.cpu().numpy().tolist())
        all_preds.extend(outputs.argmax(dim=1).cpu().numpy().tolist())
    avg_loss = running_loss / max(num_samples, 1)
    accuracy = float(np.mean(np.array(all_labels) == np.array(all_preds)))
    if device.type == "mps": torch.mps.empty_cache()
    return avg_loss, num_samples, {"val_loss": avg_loss, "val_accuracy": accuracy}

class DpChestXrayClient(fl.client.NumPyClient):
    def __init__(self, client_dir: Path, batch_size: int, local_epochs: int, lr: float, c: float, sigma: float):
        self.client_name = client_dir.name
        self.logger = setup_logging(self.client_name[:12])
        self.device = get_device()
        self.local_epochs = local_epochs
        self.lr = lr
        self.c = c          # DP Clipping Norm
        self.sigma = sigma  # DP Noise Multiplier

        self.logger.info("🛡️ LDP Enabled | C=%.2f, Sigma=%.3f", self.c, self.sigma)
        self.model = ChestXrayEnsemble().to(self.device)
        
        train_dataset = LocalChestXrayDataset(client_dir, "train", get_train_transforms())
        val_dataset = LocalChestXrayDataset(client_dir, "val", get_eval_transforms())
        kwargs = {"batch_size": batch_size, "num_workers": 2, "pin_memory": False}
        self.train_loader = DataLoader(train_dataset, shuffle=True, drop_last=True, **kwargs)
        self.val_loader = DataLoader(val_dataset, shuffle=False, **kwargs)

    def get_parameters(self, config):
        return [val.cpu().numpy() for _, val in self.model.state_dict().items()]

    def set_parameters(self, parameters):
        params_dict = zip(self.model.state_dict().keys(), parameters)
        self.model.load_state_dict(OrderedDict({k: torch.tensor(v) for k, v in params_dict}), strict=True)

    def fit(self, parameters, config):
        # 1. Save original weights
        self.set_parameters(parameters)
        old_parameters = self.get_parameters(config={})
        
        # 2. Local Training
        epochs = int(config.get("local_epochs", self.local_epochs))
        train_local(self.model, self.train_loader, self.device, epochs, self.lr, self.logger)
        
        # 3. Get updated weights
        new_parameters = self.get_parameters(config={})
        
        # 4. DIFFERENTIAL PRIVACY (LDP)
        # Calculate Delta: new - old, ONLY for trainable parameters (skip BatchNorm running stats)
        state_dict_keys = list(self.model.state_dict().keys())
        deltas = []
        trainable_indices = []
        for i, key in enumerate(state_dict_keys):
            if "running" not in key and "num_batches_tracked" not in key:
                deltas.append(new_parameters[i] - old_parameters[i])
                trainable_indices.append(i)
        
        # Calculate Global L2 Norm (only on trainable parameters)
        global_norm = np.sqrt(sum(np.sum(d ** 2) for d in deltas))
        
        # Clipping
        clip_factor = max(1.0, global_norm / self.c)
        
        # Add Noisy Delta back to old weights
        final_parameters = list(new_parameters) # Start with new parameters (this correctly copies non-trainable stats)
        for idx, d in zip(trainable_indices, deltas):
            clipped_d = d / clip_factor
            noise = np.random.normal(loc=0.0, scale=self.sigma * self.c, size=d.shape)
            final_parameters[idx] = old_parameters[idx] + clipped_d + noise
        
        self.logger.info("  🛡️ DP Stats | Norm: %.4f | Clip: %.4f", global_norm, clip_factor)
        
        return final_parameters, len(self.train_loader.dataset), {}

    def evaluate(self, parameters, config):
        self.set_parameters(parameters)
        loss, num_samples, metrics = evaluate_local(self.model, self.val_loader, self.device)
        return loss, num_samples, metrics

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-dir", type=str, required=True)
    parser.add_argument("--server", type=str, default="127.0.0.1:8080")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--c", type=float, default=1.0)
    parser.add_argument("--sigma", type=float, default=0.01)
    args = parser.parse_args()

    client = DpChestXrayClient(Path(args.client_dir).resolve(), 16, args.epochs, args.lr, args.c, args.sigma)
    fl.client.start_client(server_address=args.server, client=client.to_client())

if __name__ == "__main__": main()
