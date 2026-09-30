import torch
import torch.nn as nn
from torchvision import models, transforms
from torch.utils.data import DataLoader, Dataset
from PIL import Image
from pathlib import Path
import cv2
import numpy as np

# =====================================================================
# KIẾN TRÚC PHẢI GIỐNG HỆT server_v5_dp.py (ChestXrayEnsemble, 2 lớp)
# =====================================================================
class ChestXrayEnsemble(nn.Module):
    def __init__(self):
        super().__init__()
        self.densenet = models.densenet121(weights=models.DenseNet121_Weights.DEFAULT)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, 2)
        self.efficientnet = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT)
        self.efficientnet.classifier[1] = nn.Linear(self.efficientnet.classifier[1].in_features, 2)

    def forward(self, x):
        return (self.densenet(x) + self.efficientnet(x)) / 2.0

# TIỀN XỬ LÝ ẢNH (CLAHE) — Giống hệt pipeline FL
def apply_clahe(img):
    img_cv = np.array(img)
    if len(img_cv.shape) == 3:
        lab = cv2.cvtColor(img_cv, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        img_cv = cv2.cvtColor(limg, cv2.COLOR_LAB2RGB)
    return Image.fromarray(img_cv)

# DATASET — 2 lớp: NORMAL, PNEUMONIA
class FastChestXrayDataset(Dataset):
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.classes = sorted([d.name for d in self.data_dir.iterdir() if d.is_dir()])
        self.class_to_idx = {cls_name: i for i, cls_name in enumerate(self.classes)}
        self.image_paths = []
        for cls_name in self.classes:
            cls_dir = self.data_dir / cls_name
            for ext in ('*.png', '*.jpg', '*.jpeg'):
                self.image_paths.extend(list(cls_dir.glob(ext)))
                
        self.transform = transforms.Compose([
            transforms.Lambda(apply_clahe),
            transforms.Resize((224, 224)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
        ])

    def __len__(self):
        return len(self.image_paths)

    def __getitem__(self, idx):
        img_path = self.image_paths[idx]
        image = Image.open(img_path).convert('RGB')
        label = self.class_to_idx[img_path.parent.name]
        return self.transform(image), label

# HUẤN LUYỆN 3 EPOCH (đủ để demo có kết quả tốt)
def main():
    print("🚀 Đang khởi tạo mô hình ChestXrayEnsemble (2 lớp: NORMAL / PNEUMONIA)...")
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = ChestXrayEnsemble().to(device)
    
    dataset = FastChestXrayDataset("./federated_data/client_1_lung_hospital/train")
    print(f"📊 Tìm thấy {len(dataset)} ảnh, các lớp: {dataset.classes}")
    dataloader = DataLoader(dataset, batch_size=32, shuffle=True)
    
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    
    num_epochs = 3
    print(f"🔥 Bắt đầu Train {num_epochs} epochs trên {device}...")
    for epoch in range(num_epochs):
        model.train()
        total_loss = 0
        correct = 0
        total = 0
        for batch_idx, (images, labels) in enumerate(dataloader):
            images, labels = images.to(device), labels.to(device)
            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()
            
            total_loss += loss.item()
            _, predicted = outputs.max(1)
            total += labels.size(0)
            correct += predicted.eq(labels).sum().item()
            
        acc = 100. * correct / total
        avg_loss = total_loss / len(dataloader)
        print(f"  Epoch {epoch+1}/{num_epochs} — Loss: {avg_loss:.4f} — Acc: {acc:.2f}%")
            
    print("✅ Đã train xong! Lưu file trọng số vào 'demo_weights.pth'")
    torch.save(model.state_dict(), "demo_weights.pth")
    print(f"📦 File trọng số: demo_weights.pth ({Path('demo_weights.pth').stat().st_size / 1024 / 1024:.1f} MB)")

if __name__ == "__main__":
    main()
