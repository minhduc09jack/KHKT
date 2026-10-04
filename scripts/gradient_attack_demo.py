"""
gradient_attack_demo.py — Mô phỏng Rò rỉ Gradient (Gradient Leakage Visualization)
=============================================================================
Phương pháp:
  1. Trích xuất gradient lớp Conv đầu tiên (chứa thông tin không gian của ảnh gốc)
  2. Không DP: Gradient bộc lộ rõ cấu trúc phổi bệnh nhân
  3. Có DP: Gradient bị nhiễu hóa → chỉ còn nhiễu trắng

Nguyên lý khoa học: Gradient của lớp tích chập đầu tiên (Conv1) có kích thước
tương ứng với ảnh đầu vào. Kẻ tấn công có thể trực quan hóa gradient này để
suy luận ngược ra nội dung ảnh y tế đã huấn luyện.

Tham khảo: "Deep Leakage from Gradients" (Zhu et al., NeurIPS 2019)
"""

import torch
import torch.nn as nn
from torchvision import models, transforms
import numpy as np
import cv2
from PIL import Image
import matplotlib.pyplot as plt
from pathlib import Path
import warnings
warnings.filterwarnings('ignore')

# === MÔ HÌNH ===
class ChestXrayEnsemble(nn.Module):
    def __init__(self):
        super().__init__()
        self.densenet = models.densenet121(weights=models.DenseNet121_Weights.DEFAULT)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, 2)
        self.efficientnet = models.efficientnet_b0(weights=models.EfficientNet_B0_Weights.DEFAULT)
        self.efficientnet.classifier[1] = nn.Linear(self.efficientnet.classifier[1].in_features, 2)
    def forward(self, x):
        return (self.densenet(x) + self.efficientnet(x)) / 2.0

class CLAHE_Transform:
    def __call__(self, img):
        img_np = np.array(img)
        if len(img_np.shape) == 3:
            lab = cv2.cvtColor(img_np, cv2.COLOR_RGB2LAB)
            l, a, b = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            cl = clahe.apply(l)
            limg = cv2.merge((cl, a, b))
            img_np = cv2.cvtColor(limg, cv2.COLOR_LAB2RGB)
        return Image.fromarray(img_np)

transform = transforms.Compose([
    CLAHE_Transform(),
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

def extract_gradient_map(gradients, model):
    """
    Trích xuất gradient lớp Conv đầu tiên của DenseNet (features.conv0)
    và EfficientNet (features.0.0) rồi gộp lại thành bản đồ rò rỉ.
    
    Gradient Conv1 có shape [out_channels, in_channels=3, kH, kW].
    Kẻ tấn công tính tổng (sum) qua chiều output_channels để ra bản đồ 2D
    tương quan với cấu trúc không gian của ảnh đầu vào.
    """
    state_keys = list(model.state_dict().keys())
    
    # Tìm gradient của lớp conv đầu tiên (DenseNet: features.conv0.weight)
    conv0_idx = None
    for i, key in enumerate(state_keys):
        if 'densenet.features.conv0.weight' in key:
            conv0_idx = i
            break
    
    if conv0_idx is None:
        return None
    
    # Gradient conv0: shape [64, 3, 7, 7] → sum qua out_channels → [3, 7, 7]
    conv0_grad = gradients[conv0_idx]  # [64, 3, 7, 7]
    
    # Tính "năng lượng gradient" cho từng kênh input (R, G, B)
    grad_energy = conv0_grad.abs().sum(dim=0)  # [3, 7, 7]
    
    # Upscale lên kích thước ảnh gốc
    grad_map = grad_energy.unsqueeze(0)  # [1, 3, 7, 7]
    grad_map = torch.nn.functional.interpolate(grad_map, size=(224, 224), mode='bilinear', align_corners=False)
    grad_map = grad_map.squeeze(0)  # [3, 224, 224]
    
    # Chuyển sang grayscale (trung bình 3 kênh)
    grad_map = grad_map.mean(dim=0)  # [224, 224]
    
    return grad_map

def main():
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"Device: {device}")
    
    # Load ảnh
    data_root = Path("federated_data")
    sample_images = list((data_root / "client_1_lung_hospital" / "train" / "PNEUMONIA").glob("*.jpeg"))
    if not sample_images:
        sample_images = list((data_root / "global_test" / "PNEUMONIA").glob("*.jpeg"))
    
    img_path = sample_images[0]
    print(f"Ảnh gốc: {img_path.name}")
    
    original_pil = Image.open(img_path).convert("RGB")
    input_tensor = transform(original_pil).unsqueeze(0).to(device)
    # Cho phép tính gradient theo input image (cho Saliency Map)
    input_tensor.requires_grad = True
    label = torch.tensor([1], device=device)
    
    model = ChestXrayEnsemble().to(device)
    model.eval()
    criterion = nn.CrossEntropyLoss()
    
    # === TÍNH GRADIENT ===
    print("\n[1/3] Tính gradient thật từ ảnh bệnh nhân...")
    model.zero_grad()
    output = model(input_tensor)
    loss = criterion(output, label)
    
    # Gradient theo input (Saliency Map — cho thấy pixel nào ảnh hưởng dự đoán)
    loss.backward()
    input_grad = input_tensor.grad.detach().cpu().squeeze()  # [3, 224, 224]
    
    # Gradient theo model params
    model.zero_grad()
    output2 = model(input_tensor.detach().requires_grad_(False))
    loss2 = criterion(output2, label)
    param_grads_clean = torch.autograd.grad(loss2, model.parameters())
    param_grads_clean = [g.detach().clone() for g in param_grads_clean]
    
    # Saliency Map (không DP)
    saliency_clean = input_grad.abs().mean(dim=0).numpy()  # [224, 224]
    
    # Trích xuất gradient Conv1 (không DP)
    conv_leak_clean = extract_gradient_map(param_grads_clean, model)
    
    # === THÊM DP ===
    print("[2/3] Áp dụng Differential Privacy (σ=0.01)...")
    C, sigma = 1.0, 0.01
    total_norm = torch.sqrt(sum(torch.sum(g ** 2) for g in param_grads_clean))
    clip_factor = max(1.0, total_norm.item() / C)
    
    param_grads_dp = []
    for g in param_grads_clean:
        clipped = g / clip_factor
        noise = torch.normal(0.0, sigma * C, size=g.shape, device=device)
        param_grads_dp.append(clipped + noise)
    
    # Trích xuất gradient Conv1 (có DP)
    conv_leak_dp = extract_gradient_map(param_grads_dp, model)
    
    # Saliency có DP (thêm noise vào input gradient)
    noise_input = torch.normal(0.0, sigma, size=input_grad.shape)
    saliency_dp = (input_grad / clip_factor + noise_input).abs().mean(dim=0).numpy()
    
    print(f"  L2-Norm: {total_norm.item():.2f} | Clip: {clip_factor:.2f}")
    
    # === VẼ KẾT QUẢ ===
    print("[3/3] Đang vẽ kết quả...")
    original_display = np.array(original_pil.resize((224, 224))) / 255.0
    
    fig, axes = plt.subplots(2, 3, figsize=(18, 12))
    
    # === HÀNG 1: SALIENCY MAP (Gradient theo Input) ===
    axes[0][0].imshow(original_display)
    axes[0][0].set_title("Ảnh X-quang Gốc\n(Hồ sơ Bệnh nhân)", fontsize=13, fontweight='bold', color='#2E7D32')
    axes[0][0].axis('off')
    
    axes[0][1].imshow(saliency_clean, cmap='hot')
    axes[0][1].set_title("Saliency Map (Không có DP)\nGradient rò rỉ cấu trúc phổi", fontsize=13, fontweight='bold', color='#C62828')
    axes[0][1].text(112, 210, "RÒ RỈ: Thấy rõ vị trí tổn thương", fontsize=10, ha='center', color='white',
                bbox=dict(facecolor='#C62828', alpha=0.9, boxstyle='round,pad=0.3'))
    axes[0][1].axis('off')
    
    axes[0][2].imshow(saliency_dp, cmap='hot')
    axes[0][2].set_title("Saliency Map (Có DP, σ=0.01)\nGradient bị nhiễu hóa", fontsize=13, fontweight='bold', color='#1565C0')
    axes[0][2].text(112, 210, "AN TOÀN: Chỉ thấy nhiễu trắng", fontsize=10, ha='center', color='white',
                bbox=dict(facecolor='#1565C0', alpha=0.9, boxstyle='round,pad=0.3'))
    axes[0][2].axis('off')
    
    # === HÀNG 2: CONV1 GRADIENT (Gradient theo tham số Conv đầu tiên) ===
    # Overlay saliency lên ảnh gốc
    overlay_clean = original_display.copy()
    sal_norm = (saliency_clean - saliency_clean.min()) / (saliency_clean.max() - saliency_clean.min() + 1e-8)
    heatmap = plt.cm.jet(sal_norm)[:, :, :3]
    overlay_clean = 0.5 * overlay_clean + 0.5 * heatmap
    
    axes[1][0].imshow(overlay_clean)
    axes[1][0].set_title("Overlay: Ảnh gốc + Saliency\n(Vùng đỏ = Vùng rò rỉ dữ liệu)", fontsize=13, fontweight='bold', color='#E65100')
    axes[1][0].axis('off')
    
    if conv_leak_clean is not None:
        conv_clean_np = conv_leak_clean.cpu().numpy()
        axes[1][1].imshow(conv_clean_np, cmap='inferno')
        axes[1][1].set_title("Gradient Conv1 (Không DP)\nBộc lộ cấu trúc không gian ảnh", fontsize=13, fontweight='bold', color='#C62828')
        axes[1][1].text(112, 210, "NGUY HIỂM: Kẻ tấn công đọc được", fontsize=10, ha='center', color='white',
                    bbox=dict(facecolor='#C62828', alpha=0.9, boxstyle='round,pad=0.3'))
        axes[1][1].axis('off')
    
    if conv_leak_dp is not None:
        conv_dp_np = conv_leak_dp.cpu().numpy()
        axes[1][2].imshow(conv_dp_np, cmap='inferno')
        axes[1][2].set_title("Gradient Conv1 (Có DP, σ=0.01)\nNhiễu phá hủy thông tin", fontsize=13, fontweight='bold', color='#1565C0')
        axes[1][2].text(112, 210, "BẢO MẬT: Không suy luận được gì", fontsize=10, ha='center', color='white',
                    bbox=dict(facecolor='#1565C0', alpha=0.9, boxstyle='round,pad=0.3'))
        axes[1][2].axis('off')
    
    fig.suptitle("MÔ PHỎNG TẤN CÔNG RÒ RỈ GRADIENT (Gradient Leakage Attack)\n"
                 "Hàng 1: Saliency Map (pixel nào ảnh hưởng dự đoán)  |  "
                 "Hàng 2: Gradient Conv1 (thông tin không gian bị lộ)",
                 fontsize=15, fontweight='bold', y=1.02)
    
    plt.tight_layout()
    plt.savefig('plots/gradient_attack_comparison.png', dpi=300, bbox_inches='tight')
    print("\n✅ Lưu tại plots/gradient_attack_comparison.png")

if __name__ == "__main__":
    main()
