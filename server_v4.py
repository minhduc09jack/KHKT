#!/usr/bin/env python3
"""
server_v4.py — Flower Federated Learning Server (V4 - ENSEMBLE)
=============================================================================

Architecture: DenseNet-121 + EfficientNet-B0 (Soft Voting)
Preprocessing: CLAHE
"""

from __future__ import annotations

import argparse
import json
import logging
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

import flwr as fl
from flwr.common import Metrics, NDArrays, Scalar
from PIL import Image
from sklearn.metrics import f1_score

CLASS_NAMES = ["NORMAL", "PNEUMONIA"]
NUM_CLASSES = len(CLASS_NAMES)
LABEL_TO_IDX = {name: i for i, name in enumerate(CLASS_NAMES)}

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

LOG_FORMAT = "%(asctime)s │ %(name)-10s │ %(levelname)-8s │ %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, datefmt="%H:%M:%S")
logger = logging.getLogger("SERVER")

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

class GlobalTestDataset(Dataset):
    def __init__(self, data_root: Path, transform: transforms.Compose) -> None:
        self.transform = transform
        self.image_paths: List[Path] = []
        self.labels: List[int] = []
        test_dir = data_root / "global_test"
        for label_dir in sorted(test_dir.iterdir()):
            if not label_dir.is_dir(): continue
            label_name = label_dir.name
            if label_name not in LABEL_TO_IDX: continue
            label_idx = LABEL_TO_IDX[label_name]
            for img_file in sorted(label_dir.glob("*.jpeg")):
                self.image_paths.append(img_file)
                self.labels.append(label_idx)

    def __len__(self) -> int: return len(self.image_paths)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, int]:
        image = Image.open(self.image_paths[idx]).convert("RGB")
        image = self.transform(image)
        return image, self.labels[idx]

def get_eval_transforms(img_size: int = 224) -> transforms.Compose:
    return transforms.Compose([
        CLAHE_Transform(),
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])

class ChestXrayEnsemble(nn.Module):
    def __init__(self, num_classes: int = NUM_CLASSES):
        super().__init__()
        self.densenet = models.densenet121(weights=models.DenseNet121_Weights.DEFAULT)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, num_classes)
        
        self.efficientnet = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT)
        self.efficientnet.classifier[1] = nn.Linear(self.efficientnet.classifier[1].in_features, num_classes)
        
    def forward(self, x):
        out_d = self.densenet(x)
        out_e = self.efficientnet(x)
        return (out_d + out_e) / 2.0

def get_device() -> torch.device:
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")

def weighted_average(metrics: List[Tuple[int, Metrics]]) -> Metrics:
    total_examples = sum([num_examples for num_examples, _ in metrics])
    if total_examples == 0 or not metrics: return {}
    agg = {}
    for key in metrics[0][1].keys():
        weighted_sum = sum([num_examples * m[key] for num_examples, m in metrics if key in m])
        agg[key] = weighted_sum / total_examples
    return agg

def get_evaluate_fn(data_root: Path, device: torch.device, history_dict: Dict[str, Any]) -> callable:
    logger.info("📂 Loading global_test dataset...")
    test_dataset = GlobalTestDataset(data_root, get_eval_transforms())
    test_loader = DataLoader(test_dataset, batch_size=32, shuffle=False, num_workers=4)
    model = ChestXrayEnsemble(NUM_CLASSES).to(device)
    criterion = nn.CrossEntropyLoss()

    def evaluate(server_round: int, parameters: NDArrays, config: Dict[str, Scalar]) -> Optional[Tuple[float, Dict[str, Scalar]]]:
        logger.info("═" * 60)
        logger.info("🧪 ROUND %d: Global Eval (DenseNet+EfficientNet Ensemble)", server_round)
        params_dict = zip(model.state_dict().keys(), parameters)
        model.load_state_dict(OrderedDict({k: torch.tensor(v) for k, v in params_dict}), strict=True)
        model.eval()

        running_loss = 0.0
        all_labels, all_preds = [], []
        num_samples = 0

        with torch.no_grad():
            for images, labels in test_loader:
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

        logger.info("  Global Test │ Loss: %.4f │ Acc: %.2f%% │ F1: %.4f", avg_loss, accuracy * 100, macro_f1)
        
        metrics = {"accuracy": accuracy, "macro_f1": macro_f1}
        history_dict[server_round] = {"loss": avg_loss, "accuracy": accuracy, "macro_f1": macro_f1}
        return float(avg_loss), metrics
    return evaluate

def main() -> None:
    parser = argparse.ArgumentParser(description="🌸 Flower FL Server V4")
    parser.add_argument("--data-root", type=str, default="./federated_data")
    parser.add_argument("--strategy", type=str, choices=["fedavg", "fedprox"], default="fedprox")
    parser.add_argument("--rounds", type=int, default=30)
    parser.add_argument("--mu", type=float, default=1.0)
    parser.add_argument("--host", type=str, default="0.0.0.0:8080")

    args = parser.parse_args()
    device = get_device()
    history_dict = {}
    eval_fn = get_evaluate_fn(Path(args.data_root).resolve(), device, history_dict)

    if args.strategy.lower() == "fedavg":
        strategy = fl.server.strategy.FedAvg(
            fraction_fit=1.0, fraction_evaluate=1.0, min_fit_clients=2, min_evaluate_clients=2,
            min_available_clients=3, evaluate_fn=eval_fn, evaluate_metrics_aggregation_fn=weighted_average,
        )
    else:
        logger.info("  FedProx mu: %.2f", args.mu)
        strategy = fl.server.strategy.FedProx(
            fraction_fit=1.0, fraction_evaluate=1.0, min_fit_clients=2, min_evaluate_clients=2,
            min_available_clients=3, evaluate_fn=eval_fn, evaluate_metrics_aggregation_fn=weighted_average,
            proximal_mu=args.mu,
        )

    logger.info("🚀 Starting Flower Server V4 on %s...", args.host)
    fl.server.start_server(
        server_address=args.host,
        config=fl.server.ServerConfig(num_rounds=args.rounds),
        strategy=strategy,
    )

    output_file = f"federated_metrics_{args.strategy}_v4.json"
    logger.info("💾 Saving evaluation history to %s", output_file)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump({"strategy": args.strategy, "rounds": args.rounds, "mu": args.mu if args.strategy == "fedprox" else None, "history": history_dict}, f, indent=2)

if __name__ == "__main__":
    main()
