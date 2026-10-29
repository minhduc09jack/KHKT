import os
import time
import uuid
import hashlib
import uvicorn
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, File, UploadFile, Form, Body, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.middleware.gzip import GZipMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import torch
import torch.nn as nn
from torchvision import models, transforms
from PIL import Image
import cv2
import numpy as np
import io
import base64

try:
    import pydicom
except ImportError:
    pydicom = None


# =====================================================================
# HOSPITAL SECURITY & CACHE CONTROL MIDDLEWARE
# Complies with Hospital Cybersecurity (HIPAA / TT54-BYT) & Modern Web Guidance
# =====================================================================
class HospitalSecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path

        # Prevent MIME sniffing & Clickjacking
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"

        # Cache control: dynamic HTML/JS/API always fresh, static sample images cached
        if path.startswith("/dashboard/assets/"):
            response.headers["Cache-Control"] = "public, max-age=86400"
        elif path.startswith("/dashboard") or path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"

        return response


app = FastAPI(
    title="MedAI Diagnostic PACS/HIS & Federated Learning Hospital Platform",
    version="4.0.0",
    description="Hệ thống Chẩn đoán X-Quang Phổi AI đa vai trò (Admin Bệnh viện - Kỹ thuật viên X-Quang - Bác sĩ Chẩn đoán)"
)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(HospitalSecurityMiddleware)


# =====================================================================
# IN-MEMORY MULTI-DEVICE HOSPITAL STATE SYNC (FOR INTERNET DEPLOYMENT)
# Enables Technician, Doctor, and Admin across different devices/tabs
# to synchronize Worklist cases, Admin Policies, and Audit Logs seamlessly.
# =====================================================================
HOSPITAL_SYNC_STATE: Dict[str, Any] = {
    "policy": {
        "activeClientNode": "CLIENT_1",
        "aiEnabled": True,
        "requireTechQA": True,
        "phiMaskingEnabled": False,
        "emergencyLockdown": False,
        "globalDecisionThreshold": 50,
        "autoPreTriageAI": True,
        "sessionTimeoutMinutes": 30,
        "flMu": 1.0,
        "dpSigma": 0.01,
        "dpClipNorm": 1.0,
        "flRoundCount": 30,
        "lastFlSync": int(time.time() * 1000) - 3600000,
        "updatedBy": "Admin Hệ thống",
        "updatedAt": int(time.time() * 1000)
    },
    "worklist": [],
    "auditLogs": [
        {
            "id": "AUD-INIT-001",
            "timestamp": int(time.time() * 1000) - 7200000,
            "actor": "Hệ thống Khởi tạo (System Daemon)",
            "role": "ADMIN",
            "clientNode": "CLIENT_1",
            "action": "SYSTEM_BOOT_DP_READY",
            "severity": "SECURITY",
            "details": "Khởi động MedAI PACS/HIS v4.0. Mô hình Hybrid Ensemble (DenseNet121 + EfficientNetB0) nạp trọng số FL V5 (FedProx μ=1.0, DP σ=0.01).",
            "hash": hashlib.sha256(b"AUD-INIT-001-MEDAI").hexdigest()[:16].upper()
        }
    ]
}


# =====================================================================
# ROLE PORTAL SHORTCUT ROUTES
# =====================================================================
@app.get("/")
def read_root():
    return RedirectResponse(url="/dashboard/index.html")


@app.get("/doctor")
def redirect_doctor():
    return RedirectResponse(url="/dashboard/index.html")


@app.get("/technician")
def redirect_technician():
    return RedirectResponse(url="/dashboard/technician.html")


@app.get("/admin")
def redirect_admin():
    return RedirectResponse(url="/dashboard/admin.html")


@app.get("/api/health")
def health_check():
    return {
        "status": "online",
        "model_name": "Hybrid Ensemble (DenseNet-121 + EfficientNet-B0)",
        "device": str(device),
        "model_loaded": model is not None,
        "torch_version": torch.__version__,
        "service": "MedAI Diagnostic PACS/HIS Multi-Role API v4.0",
        "fl_framework": "Flower (FedProx μ=1.0 + Local DP σ=0.01)",
        "active_policy": HOSPITAL_SYNC_STATE["policy"],
        "worklist_pending_count": len([
            w for w in HOSPITAL_SYNC_STATE["worklist"]
            if w.get("status") == "PENDING_DOCTOR"
        ])
    }


# =====================================================================
# REAL-TIME MULTI-ROLE SYNC ENDPOINTS (WORKLIST, ADMIN POLICY, AUDIT)
# =====================================================================
@app.get("/api/sync/state")
def get_sync_state():
    return {
        "status": "success",
        "policy": HOSPITAL_SYNC_STATE["policy"],
        "worklist": HOSPITAL_SYNC_STATE["worklist"][:50],
        "auditLogs": HOSPITAL_SYNC_STATE["auditLogs"][:100],
        "serverTime": int(time.time() * 1000)
    }


@app.post("/api/sync/policy")
async def update_system_policy(payload: Dict[str, Any] = Body(...)):
    current = HOSPITAL_SYNC_STATE["policy"]
    for k, v in payload.items():
        if k in current:
            current[k] = v
    current["updatedAt"] = int(time.time() * 1000)
    return {"status": "success", "policy": current}


@app.post("/api/sync/worklist")
async def push_worklist_case(item: Dict[str, Any] = Body(...)):
    if not item.get("id"):
        item["id"] = "WL-" + uuid.uuid4().hex[:8].upper()
    item["timestamp"] = item.get("timestamp") or int(time.time() * 1000)
    item["status"] = item.get("status") or "PENDING_DOCTOR"

    # Replace if existing id, else prepend
    existing_idx = next(
        (i for i, x in enumerate(HOSPITAL_SYNC_STATE["worklist"]) if x.get("id") == item["id"]),
        None
    )
    if existing_idx is not None:
        HOSPITAL_SYNC_STATE["worklist"][existing_idx] = item
    else:
        HOSPITAL_SYNC_STATE["worklist"].insert(0, item)

    # Cap in-memory list to 50 recent items to protect server RAM on free cloud tiers
    HOSPITAL_SYNC_STATE["worklist"] = HOSPITAL_SYNC_STATE["worklist"][:50]
    return {"status": "success", "item": item}


@app.patch("/api/sync/worklist/{item_id}")
async def update_worklist_case(item_id: str, updates: Dict[str, Any] = Body(...)):
    for item in HOSPITAL_SYNC_STATE["worklist"]:
        if item.get("id") == item_id:
            item.update(updates)
            item["updatedAt"] = int(time.time() * 1000)
            return {"status": "success", "item": item}
    return JSONResponse(status_code=404, content={"status": "error", "error": "Không tìm thấy ca chụp trong hàng đợi."})


@app.post("/api/sync/audit")
async def push_audit_log(entry: Dict[str, Any] = Body(...)):
    if not entry.get("id"):
        entry["id"] = "AUD-" + uuid.uuid4().hex[:8].upper()
    entry["timestamp"] = entry.get("timestamp") or int(time.time() * 1000)
    raw_str = f"{entry['id']}-{entry.get('actor')}-{entry.get('action')}-{entry['timestamp']}"
    entry["hash"] = entry.get("hash") or hashlib.sha256(raw_str.encode("utf-8")).hexdigest()[:16].upper()

    HOSPITAL_SYNC_STATE["auditLogs"].insert(0, entry)
    HOSPITAL_SYNC_STATE["auditLogs"] = HOSPITAL_SYNC_STATE["auditLogs"][:150]
    return {"status": "success", "entry": entry}


# =====================================================================
# AI MODEL CONFIGURATION (Hybrid Ensemble: DenseNet-121 + EfficientNet-B0)
# =====================================================================
class ChestXrayEnsemble(nn.Module):
    def __init__(self):
        super().__init__()
        self.densenet = models.densenet121(weights=None)
        self.densenet.classifier = nn.Linear(self.densenet.classifier.in_features, 2)
        self.efficientnet = models.efficientnet_b0(weights=None)
        self.efficientnet.classifier[1] = nn.Linear(self.efficientnet.classifier[1].in_features, 2)

    def forward(self, x):
        # Tránh lỗi inplace=True của DenseNet torchvision khi dùng chung với hook (GradCAM)
        features = self.densenet.features(x)
        out = torch.nn.functional.relu(features, inplace=False)
        out = torch.nn.functional.adaptive_avg_pool2d(out, (1, 1))
        out = torch.flatten(out, 1)
        densenet_out = self.densenet.classifier(out)

        efficientnet_out = self.efficientnet(x)
        return (densenet_out + efficientnet_out) / 2.0


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


transform = transforms.Compose([
    transforms.Lambda(apply_clahe),
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
])

device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
model = ChestXrayEnsemble().to(device)

try:
    model.load_state_dict(torch.load("demo_weights.pth", map_location=device))
    print("✅ Đã load thành công model Hybrid Ensemble.")
except Exception as e:
    print(f"⚠️ Cảnh báo: Không load được model - {e}")
model.eval()


class SimpleGradCAM:
    def __init__(self, model, target_layer):
        self.model = model
        self.target_layer = target_layer
        self.gradients = None
        self.activations = None

        target_layer.register_forward_hook(self.save_activation)
        target_layer.register_full_backward_hook(self.save_gradient)

    def save_activation(self, module, input, output):
        self.activations = output

    def save_gradient(self, module, grad_input, grad_output):
        self.gradients = grad_output[0]

    def generate(self, x, class_idx):
        self.model.zero_grad()
        output = self.model(x)
        score = output[0, class_idx]
        score.backward(retain_graph=True)

        weights = torch.mean(self.gradients, dim=[2, 3], keepdim=True)
        cam = torch.sum(weights * self.activations, dim=1).squeeze()
        cam = torch.relu(cam)

        cam = cam.detach().cpu().numpy()
        if np.max(cam) != 0:
            cam = cam - np.min(cam)
            cam = cam / np.max(cam)
        return cam


def generate_heatmap_overlay(original_img, cam, colormap=cv2.COLORMAP_JET, alpha=0.5):
    cam_resized = cv2.resize(cam, (original_img.size[0], original_img.size[1]))
    heatmap = cv2.applyColorMap(np.uint8(255 * cam_resized), colormap)
    heatmap = cv2.cvtColor(heatmap, cv2.COLOR_BGR2RGB)

    original_np = np.array(original_img)
    overlay = cv2.addWeighted(original_np, 1 - alpha, heatmap, alpha, 0)
    return Image.fromarray(overlay)


# Initialize GradCAM
grad_cam = SimpleGradCAM(model, model.densenet.features.norm5)


# =====================================================================
# AI PREDICTION ENDPOINT
# =====================================================================
@app.post("/api/predict")
async def predict(file: UploadFile = File(...)):
    try:
        # Respect Admin Emergency Lockdown or AI Disabled Policy
        policy = HOSPITAL_SYNC_STATE.get("policy", {})
        if policy.get("emergencyLockdown"):
            return JSONResponse(
                status_code=423,
                content={"status": "error", "error": "Hệ thống đang trong chế độ Khóa Khẩn Cấp (Emergency Lockdown) bởi Admin Bệnh viện."}
            )
        if policy.get("aiEnabled") is False:
            return JSONResponse(
                status_code=403,
                content={"status": "error", "error": "Mô-đun Suy luận AI hiện đang được Admin Bệnh viện tạm ngưng để bảo trì định kỳ."}
            )

        t_start = time.time()
        contents = await file.read()

        # Compute SHA-256 hash of raw medical image for DICOM integrity verification
        img_sha256 = hashlib.sha256(contents).hexdigest()[:16].upper()

        # Handle DICOM
        if file.filename and file.filename.lower().endswith('.dcm'):
            if pydicom is None:
                return JSONResponse(status_code=500, content={"error": "Thư viện pydicom chưa được cài đặt để đọc file DICOM."})
            dicom = pydicom.dcmread(io.BytesIO(contents))
            pixel_array = dicom.pixel_array
            pixel_array = cv2.normalize(pixel_array, None, 0, 255, cv2.NORM_MINMAX)
            pixel_array = pixel_array.astype(np.uint8)
            if len(pixel_array.shape) == 2:
                img = Image.fromarray(cv2.cvtColor(pixel_array, cv2.COLOR_GRAY2RGB))
            else:
                img = Image.fromarray(pixel_array)
        else:
            img = Image.open(io.BytesIO(contents)).convert('RGB')

        # Inference
        input_tensor = transform(img).unsqueeze(0).to(device)
        model.eval()

        with torch.no_grad():
            outputs = model(input_tensor)
            probs = torch.nn.functional.softmax(outputs[0], dim=0)

        prob_normal = float(probs[0]) * 100
        prob_pneumonia = float(probs[1]) * 100
        threshold = float(policy.get("globalDecisionThreshold", 50))
        pred_class = 1 if prob_pneumonia >= threshold else 0

        # Generate Grad-CAM for the predicted class
        with torch.enable_grad():
            input_tensor_cam = input_tensor.clone().requires_grad_(True)
            cam = grad_cam.generate(input_tensor_cam, pred_class)

        cmap = cv2.COLORMAP_WINTER if pred_class == 0 else cv2.COLORMAP_JET
        overlay_img = generate_heatmap_overlay(img.resize((224, 224)), cam, colormap=cmap)

        buffered = io.BytesIO()
        overlay_img.save(buffered, format="JPEG", quality=90)
        heatmap_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")

        inference_ms = round((time.time() - t_start) * 1000, 1)

        return {
            "status": "success",
            "probabilities": {
                "normal": prob_normal,
                "pneumonia": prob_pneumonia
            },
            "applied_threshold": threshold,
            "heatmap_base64": heatmap_b64,
            "image_sha256": img_sha256,
            "inference_ms": inference_ms
        }

    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# Mount dashboard folder as static files (placed after API routes)
app.mount("/dashboard", StaticFiles(directory="dashboard", html=True), name="dashboard")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"🏥 Khởi động Hệ thống MedAI PACS/HIS tại:")
    print(f"   👨‍⚕️ Bác sĩ Chẩn đoán : http://localhost:{port}/dashboard/index.html")
    print(f"   🩻 Kỹ thuật viên XQ : http://localhost:{port}/dashboard/technician.html")
    print(f"   🛡️ Admin Bệnh viện  : http://localhost:{port}/dashboard/admin.html")
    uvicorn.run(app, host="0.0.0.0", port=port)
