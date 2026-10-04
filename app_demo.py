import gradio as gr
import torch
import torch.nn as nn
from torchvision import models, transforms
from PIL import Image
import cv2
import numpy as np

# =====================================================================
# KIẾN TRÚC PHẢI GIỐNG HỆT server_v5_dp.py (ChestXrayEnsemble, 2 lớp)
# =====================================================================
class ChestXrayEnsemble(nn.Module):
    def __init__(self):
        super().__init__()
        self.densenet = models.densenet121(weights=None)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, 2)
        self.efficientnet = models.efficientnet_b0(weights=None)
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

# Cấu hình biến đổi ảnh — Giống hệt server_v5_dp.py
transform = transforms.Compose([
    transforms.Lambda(apply_clahe),
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
])

# Load Model
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
model = ChestXrayEnsemble().to(device)
try:
    model.load_state_dict(torch.load("demo_weights.pth", map_location=device))
    print("✅ Đã load thành công file demo_weights.pth")
except FileNotFoundError:
    print("⚠️ Cảnh báo: Không tìm thấy 'demo_weights.pth'. Chạy 'python3 train_fast_demo.py' trước!")
model.eval()

# 2 lớp — Khớp hoàn toàn với Báo cáo KHKT
CLASS_NAMES = ["NORMAL (Khỏe mạnh)", "PNEUMONIA (Viêm phổi)"]

def predict(image):
    if image is None:
        return "Vui lòng tải ảnh lên!"
    
    img = Image.fromarray(image).convert('RGB')
    input_tensor = transform(img).unsqueeze(0).to(device)
    
    with torch.no_grad():
        outputs = model(input_tensor)
        probabilities = torch.nn.functional.softmax(outputs[0], dim=0)
    
    return {CLASS_NAMES[i]: float(probabilities[i]) for i in range(2)}

# GIAO DIỆN WEB GRADIO
with gr.Blocks() as demo:
    gr.Markdown("""
    # 🏥 Hệ thống AI Chẩn đoán Viêm phổi qua ảnh X-quang
    ### Federated Learning + Differential Privacy
    
    Mô hình **DenseNet-121 + EfficientNet-B0 (Soft Voting)** được huấn luyện phân tán (FL) từ 3 Bệnh viện mô phỏng
    với thuật toán **FedProx (μ=1.0)** và bảo mật bằng **Nhiễu vi phân Gaussian (σ=0.01)**.
    
    | Chỉ số | Phiên bản V1 (Gộp) | Phiên bản V2 (FL Không DP) | Phiên bản V3 (FL + DP) |
    |--------|:-----------:|:----------------:|:-------------:|
    | **F1-Score** | 96.25% | 94.45% | **95.61%** |
    | **Accuracy** | 97.01% | 95.47% | **96.58%** |
    | Bảo mật | ❌ Không | ❌ Không | ✅ LDP (ε-private) |
    """)
    
    with gr.Row():
        with gr.Column():
            image_input = gr.Image(label="📷 Tải ảnh X-quang ngực lên đây")
            predict_btn = gr.Button("🔍 Chẩn đoán AI", variant="primary", size="lg")
            gr.Markdown("""
            > **Hướng dẫn:** Tải ảnh X-quang phổi (định dạng .jpeg/.png) lên ô bên trên,
            > sau đó bấm nút **Chẩn đoán AI** để xem kết quả.
            """)
        
        with gr.Column():
            label_output = gr.Label(num_top_classes=2, label="Kết quả chẩn đoán")
            gr.Markdown("""
            ### 📋 Giải thích kết quả:
            - **NORMAL (Khỏe mạnh):** Phổi bình thường, không phát hiện tổn thương.
            - **PNEUMONIA (Viêm phổi):** Phát hiện dấu hiệu viêm phổi trên ảnh X-quang.
            
            ---
            ### 🔬 Kiến trúc hệ thống:
            - **Mô hình:** Hybrid Ensemble (DenseNet-121 + EfficientNet-B0)
            - **Tiền xử lý:** CLAHE (Contrast Limited Adaptive Histogram Equalization)
            - **Huấn luyện:** Federated Learning (FedProx) — Dữ liệu không rời khỏi bệnh viện
            - **Bảo mật:** Differential Privacy (L2-Norm Clipping + Gaussian Noise σ=0.01)
            
            > ⚠️ **Lưu ý:** Đây là công cụ hỗ trợ nghiên cứu, không thay thế chẩn đoán của Bác sĩ.
            """)

    predict_btn.click(fn=predict, inputs=image_input, outputs=label_output)

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
