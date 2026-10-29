---
title: MedAI Diagnostic PACS/HIS - Federated Learning & Differential Privacy
emoji: 🏥
colorFrom: blue
colorTo: teal
sdk: static
app_file: index.html
pinned: true
license: mit
---

# 🏥 Federated Learning for Pneumonia Detection with Differential Privacy

> **Dự án Khoa học Kỹ thuật (KHKT)** — Ứng dụng Học máy Liên kết (Federated Learning) và Bảo mật Vi phân (Differential Privacy) trong chẩn đoán Viêm phổi qua ảnh X-quang ngực.

![Python](https://img.shields.io/badge/Python-3.14-blue?logo=python)
![PyTorch](https://img.shields.io/badge/PyTorch-2.x-ee4c2c?logo=pytorch)
![Flower](https://img.shields.io/badge/Flower-FL_Framework-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## 📋 Tổng quan

Dự án xây dựng một hệ thống AI chẩn đoán Viêm phổi (Pneumonia) từ ảnh X-quang ngực, cho phép **nhiều bệnh viện cùng huấn luyện chung một mô hình AI mà không cần chia sẻ dữ liệu bệnh nhân** — đảm bảo quyền riêng tư tuyệt đối theo chuẩn quốc tế (HIPAA).

### Điểm nổi bật
- 🧠 **Kiến trúc Lai ghép (Hybrid Ensemble):** DenseNet-121 + EfficientNet-B0 với Soft Voting
- 🏗️ **Federated Learning:** 3 bệnh viện mô phỏng huấn luyện phân tán qua FedProx (μ=1.0)
- 🔐 **Differential Privacy:** Nhiễu Gaussian (σ=0.01) + L2-Norm Clipping bảo vệ trọng số
- 🖼️ **Tiền xử lý CLAHE:** Tăng cường độ tương phản ảnh X-quang tự động
- 💻 **Edge Computing:** Chạy hoàn toàn trên thiết bị cá nhân (Apple M3 Pro, 18GB RAM)

## 📊 Kết quả thực nghiệm

| Phương pháp | Accuracy | F1-Score | Bảo mật |
|:------------|:--------:|:--------:|:-------:|
| Centralized (Upper Bound) | 96.67% | 96.24% | ❌ Không |
| FL V4 — FedProx (Không DP) | 95.47% | 94.45% | ❌ Không |
| **FL V5 — FedProx + DP** | **96.58%** | **95.61%** | ✅ ε-private |

> **Phát hiện quan trọng:** Nhiễu vi phân (DP) không chỉ bảo mật mà còn hoạt động như một bộ điều chuẩn (Regularizer), giúp mô hình chống học vẹt (Overfitting) và đạt F1-Score cao hơn phiên bản không có DP.

## 🗃️ Phân bố Dữ liệu (Non-IID Data)

Dữ liệu được chia theo hướng **Non-IID (Non-Independent and Identically Distributed)** để mô phỏng thực tế: mỗi bệnh viện có số lượng bệnh nhân và tỷ lệ nhiễm bệnh khác nhau.

| Nút (Node) | Phân bố (Train) | Phân bố (Validation) | Đặc điểm mô phỏng |
|:---|:---|:---|:---|
| **Client 1 (Bệnh viện Phổi)** | 507 Normal, 273 Pneumonia | 126 Normal, 68 Pneumonia | Bệnh viện chuyên khoa, cân bằng hơn (~35% Pneumonia) |
| **Client 2 (BV Cấp cứu)** | 253 Normal, 1094 Pneumonia | 63 Normal, 273 Pneumonia | Tuyến đầu cấp cứu, tỷ lệ viêm phổi cao (~81% Pneumonia) |
| **Client 3 (PK Sàng lọc)** | 255 Normal, 1369 Pneumonia | 63 Normal, 342 Pneumonia | Phòng khám sàng lọc cộng đồng (~84% Pneumonia) |
| **Server (Global Test)** | 316 Normal, 854 Pneumonia | - | Tập kiểm thử độc lập đánh giá mô hình toàn cục |

## 🗂️ Cấu trúc thư mục

```
KHKT/
├── client_v4.py              # FL Client — Ensemble model (FedProx)
├── client_v5_dp.py           # FL Client — Ensemble + Differential Privacy
├── server_v4.py              # FL Server — Global evaluation
├── server_v5_dp.py           # FL Server — Global eval + lưu trọng số .pth
├── train_centralized_v4.py   # Centralized baseline (Upper Bound)
├── process_pneumonia_splits.py  # Chia dữ liệu → 3 clients Non-IID
├── app_demo.py               # 🌐 Web Demo (Gradio) — Chẩn đoán trực tuyến
├── run_simulation_v4.sh      # Script chạy FL V4
├── run_simulation_v5_dp.sh   # Script chạy FL V5 (DP)
├── plot_v4.py                # Vẽ biểu đồ V4
├── plot_comparison_v4.py     # So sánh Centralized vs FL V4
├── plot_final_v5.py          # Biểu đồ Privacy-Utility Trade-off (V5)
├── scripts/                  # Scripts phụ trợ
│   ├── train_fast_demo.py    #   Train nhanh để tạo demo_weights.pth
│   ├── monitor_progress.py   #   Giám sát tiến trình FL (CLI)
│   ├── web_monitor.py        #   Giám sát tiến trình FL (Web)
│   └── parse_v5_log.py       #   Trích xuất metrics từ log
├── metrics/                  # Kết quả JSON của tất cả các phiên bản
├── plots/                    # Biểu đồ xuất ra (.png)
├── logs/                     # Log huấn luyện
├── docs/                     # Tài liệu tham khảo
├── archive/                  # Phiên bản cũ (V1–V3, lưu trữ)
├── federated_data/           # Dữ liệu đã chia cho 3 clients (⚠️ không push Git)
└── pneumonia_raw_data/       # Dữ liệu gốc (⚠️ không push Git)
```

## 🚀 Hướng dẫn sử dụng

### 1. Cài đặt môi trường
```bash
pip3 install torch torchvision flwr opencv-python scikit-learn gradio
```

### 2. Chuẩn bị dữ liệu
```bash
python3 process_pneumonia_splits.py --data-root ./pneumonia_raw_data
```

### 3. Chạy Federated Learning
```bash
# V4 (Không có Differential Privacy)
bash run_simulation_v4.sh

# V5 (Có Differential Privacy, σ=0.01)
bash run_simulation_v5_dp.sh 0.01 30 3 1.0
```

### 4. Chạy Web Demo
```bash
# Bước 1: Tạo file trọng số (chỉ cần chạy 1 lần)
python3 scripts/train_fast_demo.py

# Bước 2: Khởi chạy Web
python3 app_demo.py
# → Mở trình duyệt: http://127.0.0.1:7860
```

### 5. Vẽ biểu đồ kết quả
```bash
python3 plot_final_v5.py  # Biểu đồ Privacy-Utility Trade-off
```

## 🔬 Kiến trúc hệ thống

```
┌─────────────────────────────────────────────────────────┐
│                    FL Server (FedProx)                   │
│              Gộp trọng số toàn cục (μ=1.0)              │
└──────────┬──────────────┬──────────────┬────────────────┘
           │              │              │
     ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
     │ Client 1  │  │ Client 2  │  │ Client 3  │
     │ BV Phổi   │  │ BV Cấp cứu│  │ PK Sàng lọc│
     │ 780 ảnh   │  │ 1347 ảnh  │  │ 1624 ảnh  │
     │ 35% PN    │  │ 81% PN    │  │ 84% PN    │
     └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
           │              │              │
     ┌─────▼──────────────▼──────────────▼─────┐
     │        Differential Privacy (V5)         │
     │   L2-Norm Clipping → Gaussian Noise σ    │
     │   (Chỉ áp dụng lên trainable weights)    │
     └──────────────────────────────────────────┘
```

## 📚 Tài liệu tham khảo

1. **McMahan et al.** (2017). *Communication-Efficient Learning of Deep Networks from Decentralized Data.* AISTATS.
2. **Li et al.** (2020). *Federated Optimization in Heterogeneous Networks (FedProx).* MLSys.
3. **Abadi et al.** (2016). *Deep Learning with Differential Privacy.* CCS.
4. **Dwork & Roth** (2015). *The reusable holdout: Preserving validity in adaptive data analysis.* Science.
5. **Neelakantan et al.** (2015). *Adding Gradient Noise Improves Learning for Very Deep Networks.* arXiv.

## ⚙️ Môi trường phát triển

- **Phần cứng:** MacBook Pro — Apple M3 Pro, 18GB Unified Memory
- **GPU Backend:** Apple Metal Performance Shaders (MPS)
- **Python:** 3.14
- **Framework FL:** Flower (flwr)
- **Deep Learning:** PyTorch 2.x

## 📜 Giấy phép

Dự án này được phát triển cho mục đích nghiên cứu khoa học và giáo dục.
