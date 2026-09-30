#!/usr/bin/env python3
"""
train_centralized_v4.py — Centralized Baseline (V4 - ENSEMBLE)
=============================================================================

Trains the exact same Ensemble architecture on the aggregated dataset (All Clients)
to establish the "Upper Bound" performance for the KHKT report.
"""

import json
import logging
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
from torch.optim import AdamW
from torch.utils.data import DataLoader, ConcatDataset, Dataset
from torchvision import models, transforms
from PIL import Image
from sklearn.metrics import f1_score

LOG_FORMAT = "%(asctime)s │ %(levelname)-8s │ %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, datefmt="%H:%M:%S")
logger = logging.getLogger("CENTRALIZED")

CLASS_NAMES = ["NORMAL", "PNEUMONIA"]
NUM_CLASSES = len(CLASS_NAMES)
LABEL_TO_IDX = {name: i for i, name in enumerate(CLASS_NAMES)}
IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

# ═══════════════════════════════════════════════════════════════════════════════
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
        return Image.fromarray(cv2.cvtColor(limg, cv2.COLOR_LAB2RGB))

def get_train_transforms(img_size=224):
    return transforms.Compose([
        CLAHE_Transform(),
        transforms.Resize((img_size + 32, img_size + 32)),
        transforms.RandomCrop(img_size),
        transforms.RandomHorizontalFlip(),
        transforms.RandomRotation(10),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])

def get_eval_transforms(img_size=224):
    return transforms.Compose([
        CLAHE_Transform(),
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])

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

# ═══════════════════════════════════════════════════════════════════════════════
def main():
    device = get_device()
    logger.info("🚀 Bắt đầu Huấn luyện Centralized Baseline V4 trên %s", device.type.upper())

    data_root = Path("./federated_data")
    clients = ["client_1_lung_hospital", "client_2_emergency_general", "client_3_screening_clinic"]
    
    # Gộp tất cả Data của 3 Client
    train_datasets = [LocalChestXrayDataset(data_root / c, "train", get_train_transforms()) for c in clients]
    combined_train = ConcatDataset(train_datasets)
    
    # Global Test Set (Tương tự Server V4)
    test_dataset = LocalChestXrayDataset(data_root, "global_test", get_eval_transforms())

    logger.info("📦 Tổng ảnh Huấn luyện gộp (All Clients): %d", len(combined_train))
    logger.info("📦 Tổng ảnh Kiểm thử (Global Test): %d", len(test_dataset))

    train_loader = DataLoader(combined_train, batch_size=16, shuffle=True, num_workers=2)
    test_loader = DataLoader(test_dataset, batch_size=32, shuffle=False, num_workers=2)

    # Tính toán lại Class Weights cho Weighted BCE
    num_normal = 1266  # Tổng Normal Train/Val của 3 client
    num_pneumonia = 3418 # Tổng Pneumonia Train/Val của 3 client
    weight_normal = num_pneumonia / max(num_normal, 1)
    weights = torch.tensor([weight_normal, 1.0], dtype=torch.float32).to(device)
    
    model = ChestXrayEnsemble().to(device)
    criterion = nn.CrossEntropyLoss(weight=weights)
    optimizer = AdamW(model.parameters(), lr=2e-4, weight_decay=1e-4)

    EPOCHS = 15
    history = {}

    for epoch in range(EPOCHS):
        logger.info("═" * 40)
        logger.info("🔥 Đang chạy Epoch %d/%d...", epoch + 1, EPOCHS)
        
        model.train()
        epoch_loss, correct, total = 0, 0, 0
        for images, labels in train_loader:
            images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()
            
            epoch_loss += loss.item() * labels.size(0)
            correct += (outputs.argmax(dim=1) == labels).sum().item()
            total += labels.size(0)
            
        train_acc = correct / total
        if device.type == "mps": torch.mps.empty_cache()

        # Đánh giá Global Test
        model.eval()
        val_loss, num_samples = 0.0, 0
        all_labels, all_preds = [], []
        with torch.no_grad():
            for images, labels in test_loader:
                images, labels = images.to(device, non_blocking=True), labels.to(device, non_blocking=True)
                outputs = model(images)
                loss = criterion(outputs, labels)
                val_loss += loss.item() * labels.size(0)
                num_samples += labels.size(0)
                all_labels.extend(labels.cpu().numpy().tolist())
                all_preds.extend(outputs.argmax(dim=1).cpu().numpy().tolist())
                
        val_loss /= num_samples
        val_acc = float(np.mean(np.array(all_labels) == np.array(all_preds)))
        val_f1 = float(f1_score(all_labels, all_preds, average="macro", zero_division=0))
        
        if device.type == "mps": torch.mps.empty_cache()

        logger.info("✅ Epoch %d │ Train Acc: %.2f%% │ Test Acc: %.2f%% │ Test F1: %.4f", 
                    epoch + 1, train_acc*100, val_acc*100, val_f1)
        
        history[epoch+1] = {"train_acc": train_acc, "test_acc": val_acc, "test_f1": val_f1}

    # Lưu JSON
    output_file = "centralized_metrics_v4.json"
    with open(output_file, "w") as f:
        json.dump(history, f, indent=2)
    logger.info("💾 Đã lưu kết quả vào %s", output_file)

if __name__ == "__main__":
    main()
