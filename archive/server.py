#!/usr/bin/env python3
"""
server.py — Flower Federated Learning Server for Chest X-ray Classification
=============================================================================

Orchestrates the Federated Learning process (FedAvg or FedProx) across 3 clients.
After each FL round, evaluates the aggregated global model on the centralized
`global_test` dataset.

Usage:
    python3 server.py --strategy fedavg --rounds 20
    python3 server.py --strategy fedprox --rounds 30 --mu 0.1
"""

from __future__ import annotations

import argparse
import json
import logging
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

import flwr as fl
from flwr.common import Metrics, NDArrays, Parameters, Scalar
from PIL import Image
from sklearn.metrics import f1_score

# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTS & LOGGING
# ═══════════════════════════════════════════════════════════════════════════════

CLASS_NAMES: List[str] = ["Atelectasis", "Infiltration", "No Finding", "Pneumonia"]
NUM_CLASSES: int = len(CLASS_NAMES)
LABEL_TO_IDX: Dict[str, int] = {name: i for i, name in enumerate(CLASS_NAMES)}

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]

LOG_FORMAT = "%(asctime)s │ %(name)-10s │ %(levelname)-8s │ %(message)s"

logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, datefmt="%H:%M:%S")
logger = logging.getLogger("SERVER")


# ═══════════════════════════════════════════════════════════════════════════════
# GLOBAL TEST DATASET & MODEL
# ═══════════════════════════════════════════════════════════════════════════════


class GlobalTestDataset(Dataset):
    """Reads the global_test dataset for centralized server evaluation."""

    def __init__(self, data_root: Path, transform: transforms.Compose) -> None:
        self.transform = transform
        self.image_paths: List[Path] = []
        self.labels: List[int] = []

        test_dir = data_root / "global_test"
        if not test_dir.exists():
            raise FileNotFoundError(f"Global test directory not found: {test_dir}")

        for label_dir in sorted(test_dir.iterdir()):
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
        image = self.transform(image)
        return image, self.labels[idx]


def get_eval_transforms(img_size: int = 224) -> transforms.Compose:
    return transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])


def build_model(num_classes: int = NUM_CLASSES) -> nn.Module:
    """Same architecture as client: MobileNetV3-Small with 4-class head."""
    weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
    model = models.mobilenet_v3_small(weights=weights)
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, num_classes)
    return model


def get_device() -> torch.device:
    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    return torch.device("cpu")


# ═══════════════════════════════════════════════════════════════════════════════
# METRICS AGGREGATION
# ═══════════════════════════════════════════════════════════════════════════════


def weighted_average(metrics: List[Tuple[int, Metrics]]) -> Metrics:
    """
    Aggregate evaluation metrics from clients.
    Weights each client's metric by the number of examples it used.
    """
    total_examples = sum([num_examples for num_examples, _ in metrics])
    if total_examples == 0:
        return {}

    aggregated_metrics: Dict[str, float] = {}

    # Extract all metric keys present in the first client's metrics
    if not metrics:
        return {}
    keys = metrics[0][1].keys()

    for key in keys:
        weighted_sum = sum(
            [num_examples * m[key] for num_examples, m in metrics if key in m]
        )
        aggregated_metrics[key] = weighted_sum / total_examples

    return aggregated_metrics


# ═══════════════════════════════════════════════════════════════════════════════
# GLOBAL EVALUATION FUNCTION
# ═══════════════════════════════════════════════════════════════════════════════


def get_evaluate_fn(
    data_root: Path,
    device: torch.device,
    history_dict: Dict[str, Any],
) -> callable:
    """
    Returns an evaluation function for the server to call after every round.
    This evaluates the global model on the independent `global_test` set.
    """
    # 1. Prepare DataLoader
    logger.info("📂 Loading global_test dataset...")
    test_dataset = GlobalTestDataset(data_root, get_eval_transforms())
    test_loader = DataLoader(
        test_dataset,
        batch_size=64,
        shuffle=False,
        num_workers=4,
        pin_memory=False,
        persistent_workers=True,
    )
    logger.info("  Found %d images for global evaluation", len(test_dataset))

    # 2. Prepare Model
    model = build_model(NUM_CLASSES).to(device)
    criterion = nn.CrossEntropyLoss()

    # 3. Define the evaluation function
    def evaluate(
        server_round: int,
        parameters: NDArrays,
        config: Dict[str, Scalar],
    ) -> Optional[Tuple[float, Dict[str, Scalar]]]:
        logger.info("═" * 60)
        logger.info("🧪 ROUND %d: Global Evaluation Started", server_round)

        # Set model parameters
        params_dict = zip(model.state_dict().keys(), parameters)
        state_dict = OrderedDict({k: torch.tensor(v) for k, v in params_dict})
        model.load_state_dict(state_dict, strict=True)
        model.eval()

        running_loss = 0.0
        all_labels, all_preds = [], []
        num_samples = 0

        with torch.no_grad():
            for images, labels in test_loader:
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

        logger.info(
            "  Global Test │ Loss: %.4f │ Acc: %.2f%% │ F1: %.4f",
            avg_loss, accuracy * 100, macro_f1,
        )
        logger.info("═" * 60)

        # Record metrics
        metrics = {
            "accuracy": accuracy,
            "macro_f1": macro_f1,
        }
        
        # Save history for exporting later
        history_dict[server_round] = {
            "loss": avg_loss,
            "accuracy": accuracy,
            "macro_f1": macro_f1
        }

        return float(avg_loss), metrics

    return evaluate


# ═══════════════════════════════════════════════════════════════════════════════
# CLI & MAIN
# ═══════════════════════════════════════════════════════════════════════════════


def main() -> None:
    parser = argparse.ArgumentParser(description="🌸 Flower FL Server")
    parser.add_argument("--data-root", type=str, default="./federated_data",
                        help="Root directory containing global_test")
    parser.add_argument("--strategy", type=str, choices=["fedavg", "fedprox"],
                        default="fedavg", help="Aggregation strategy")
    parser.add_argument("--rounds", type=int, default=20,
                        help="Number of FL rounds")
    parser.add_argument("--mu", type=float, default=0.1,
                        help="Proximal term (mu) for FedProx strategy")
    parser.add_argument("--host", type=str, default="0.0.0.0:8080",
                        help="Server address")

    args = parser.parse_args()
    data_root = Path(args.data_root).resolve()
    device = get_device()

    logger.info("╔══════════════════════════════════════════════════════════════╗")
    logger.info("║  🌸 FLOWER FEDERATED SERVER (%s)                        ║", args.strategy.upper())
    logger.info("╚══════════════════════════════════════════════════════════════╝")
    logger.info("  Rounds: %d", args.rounds)
    logger.info("  Device: %s", device)

    # ── Strategy Configuration ────────────────────────────────────────────────
    
    # We'll use a dict to accumulate evaluation history (passed by reference)
    history_dict: Dict[int, Dict[str, float]] = {}

    eval_fn = get_evaluate_fn(data_root, device, history_dict)

    if args.strategy.lower() == "fedavg":
        strategy = fl.server.strategy.FedAvg(
            fraction_fit=1.0,               # Sample 100% of available clients
            fraction_evaluate=1.0,
            min_fit_clients=2,              # Minimum clients required for training
            min_evaluate_clients=2,
            min_available_clients=3,        # Wait for all 3 clients to be connected
            evaluate_fn=eval_fn,
            evaluate_metrics_aggregation_fn=weighted_average,
        )
    else:
        logger.info("  FedProx mu: %.2f", args.mu)
        strategy = fl.server.strategy.FedProx(
            fraction_fit=1.0,
            fraction_evaluate=1.0,
            min_fit_clients=2,
            min_evaluate_clients=2,
            min_available_clients=3,
            evaluate_fn=eval_fn,
            evaluate_metrics_aggregation_fn=weighted_average,
            proximal_mu=args.mu,
        )

    # ── Start Server ──────────────────────────────────────────────────────────
    
    logger.info("🚀 Starting Flower Server on %s...", args.host)
    
    # Capture the history returned by start_server
    fl_history = fl.server.start_server(
        server_address=args.host,
        config=fl.server.ServerConfig(num_rounds=args.rounds),
        strategy=strategy,
    )

    # ── Export Metrics ────────────────────────────────────────────────────────
    
    output_file = f"federated_metrics_{args.strategy}.json"
    logger.info("💾 Saving evaluation history to %s", output_file)
    
    report = {
        "strategy": args.strategy,
        "rounds": args.rounds,
        "mu": args.mu if args.strategy == "fedprox" else None,
        "history": history_dict,
    }
    
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        
    logger.info("🎉 Federated Learning completed.")


if __name__ == "__main__":
    main()
