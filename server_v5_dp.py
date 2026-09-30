#!/usr/bin/env python3
"""
server_v5_dp.py — FL Server (V5 - DP)
=============================================================================
Matches the architecture of V4 but outputs to a different metric file.
"""

import argparse
import json
import logging
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms
import flwr as fl
from PIL import Image
from sklearn.metrics import f1_score

logging.basicConfig(level=logging.INFO, format="%(asctime)s │ %(levelname)-8s │ %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("SERVER")

CLASS_NAMES = ["NORMAL", "PNEUMONIA"]
LABEL_TO_IDX = {name: i for i, name in enumerate(CLASS_NAMES)}

class CLAHE_Transform:
    def __call__(self, img):
        img_np = np.array(img)
        lab = cv2.cvtColor(img_np, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        return Image.fromarray(cv2.cvtColor(limg, cv2.COLOR_LAB2RGB))

class GlobalTestDataset(Dataset):
    def __init__(self, data_root, transform):
        self.transform = transform
        self.image_paths, self.labels = [], []
        test_dir = data_root / "global_test"
        for label_dir in sorted(test_dir.iterdir()):
            if not label_dir.is_dir(): continue
            label_idx = LABEL_TO_IDX.get(label_dir.name)
            if label_idx is None: continue
            for img in sorted(label_dir.glob("*.jpeg")):
                self.image_paths.append(img)
                self.labels.append(label_idx)
    def __len__(self): return len(self.image_paths)
    def __getitem__(self, idx):
        image = self.transform(Image.open(self.image_paths[idx]).convert("RGB"))
        return image, self.labels[idx]

class ChestXrayEnsemble(nn.Module):
    def __init__(self):
        super().__init__()
        self.densenet = models.densenet121(weights=models.DenseNet121_Weights.DEFAULT)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, 2)
        self.efficientnet = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT)
        self.efficientnet.classifier[1] = nn.Linear(self.efficientnet.classifier[1].in_features, 2)
    def forward(self, x): return (self.densenet(x) + self.efficientnet(x)) / 2.0

def get_evaluate_fn(data_root, device, history_dict, save_path="global_model_v5_dp.pth"):
    transform = transforms.Compose([
        CLAHE_Transform(), transforms.Resize((224, 224)), transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    test_dataset = GlobalTestDataset(data_root, transform)
    test_loader = DataLoader(test_dataset, batch_size=32, shuffle=False)
    model = ChestXrayEnsemble().to(device)
    criterion = nn.CrossEntropyLoss()

    def evaluate(server_round, parameters, config):
        logger.info("🧪 ROUND %d: Global Eval (V5 - DP)", server_round)
        params_dict = zip(model.state_dict().keys(), parameters)
        model.load_state_dict(OrderedDict({k: torch.tensor(v) for k, v in params_dict}), strict=True)
        model.eval()

        running_loss, num_samples = 0.0, 0
        all_labels, all_preds = [], []

        with torch.no_grad():
            for images, labels in test_loader:
                images, labels = images.to(device), labels.to(device)
                outputs = model(images)
                loss = criterion(outputs, labels)
                running_loss += loss.item() * labels.size(0)
                num_samples += labels.size(0)
                all_labels.extend(labels.cpu().numpy().tolist())
                all_preds.extend(outputs.argmax(dim=1).cpu().numpy().tolist())

        avg_loss = running_loss / max(num_samples, 1)
        accuracy = float(np.mean(np.array(all_labels) == np.array(all_preds)))
        macro_f1 = float(f1_score(all_labels, all_preds, average="macro", zero_division=0))

        if device.type == "mps": torch.mps.empty_cache()

        logger.info("  Global Test │ Loss: %.4f │ Acc: %.2f%% │ F1: %.4f", avg_loss, accuracy * 100, macro_f1)
        history_dict[server_round] = {"loss": avg_loss, "accuracy": accuracy, "macro_f1": macro_f1}

        # Lưu trọng số toàn cục sau mỗi vòng (ghi đè). Khi FL kết thúc, file sẽ chứa trọng số vòng cuối.
        torch.save(model.state_dict(), save_path)
        logger.info("  💾 Đã lưu trọng số vòng %d vào: %s", server_round, save_path)

        return float(avg_loss), {"accuracy": accuracy, "macro_f1": macro_f1}
    return evaluate

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=str, default="./federated_data")
    parser.add_argument("--rounds", type=int, default=30)
    parser.add_argument("--sigma", type=float, default=0.01) # Log for file saving
    args = parser.parse_args()

    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    history_dict = {}
    weights_path = f"global_model_v5_dp_sigma{args.sigma}.pth"
    eval_fn = get_evaluate_fn(Path(args.data_root).resolve(), device, history_dict, save_path=weights_path)

    def weighted_average(metrics):
        total = sum([n for n, _ in metrics])
        if total == 0: return {}
        return {k: sum([n * m[k] for n, m in metrics]) / total for k in metrics[0][1].keys()}

    strategy = fl.server.strategy.FedProx(
        fraction_fit=1.0, fraction_evaluate=1.0, min_fit_clients=2, min_evaluate_clients=2,
        min_available_clients=3, evaluate_fn=eval_fn, evaluate_metrics_aggregation_fn=weighted_average,
        proximal_mu=1.0,
    )

    fl.server.start_server(server_address="0.0.0.0:8080", config=fl.server.ServerConfig(num_rounds=args.rounds), strategy=strategy)
    logger.info("💾 Trọng số toàn cục cuối cùng đã được lưu tại: %s", weights_path)

    out = f"federated_metrics_v5_dp_sigma{args.sigma}.json"
    with open(out, "w") as f:
        json.dump({"rounds": args.rounds, "sigma": args.sigma, "history": history_dict}, f, indent=2)

if __name__ == "__main__": main()
