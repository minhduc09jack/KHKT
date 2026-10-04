import matplotlib.pyplot as plt
import matplotlib.patches as patches
import numpy as np

fig, ax = plt.subplots(figsize=(20, 14))
ax.set_xlim(0, 20)
ax.set_ylim(0, 14)
ax.axis('off')

# === Helper Functions ===
def draw_step(ax, x, y, w, h, title, details, purpose, tensor_info, bg_color, line_ref):
    """Draw a processing step block with title, details, purpose, and tensor info."""
    # Main block
    rect = patches.FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.15",
                                  linewidth=2, edgecolor='#222', facecolor=bg_color)
    ax.add_patch(rect)
    
    # Title (bold, top)
    ax.text(x + w/2, y + h - 0.3, title, color='white', fontsize=13,
            ha='center', va='center', fontweight='bold')
    
    # Details (middle)
    for i, line in enumerate(details):
        ax.text(x + w/2, y + h - 0.7 - i*0.32, line, color='#E0E0E0', fontsize=10,
                ha='center', va='center')
    
    # Purpose box (bottom-left, highlighted)
    purpose_y = y + 0.15
    purpose_rect = patches.FancyBboxPatch((x + 0.15, purpose_y), w * 0.55, 0.5,
                                          boxstyle="round,pad=0.05", linewidth=1,
                                          edgecolor='#FFD54F', facecolor='#FFF8E1', alpha=0.9)
    ax.add_patch(purpose_rect)
    ax.text(x + 0.15 + w*0.55/2, purpose_y + 0.25, purpose, color='#E65100', fontsize=9,
            ha='center', va='center', fontweight='bold')
    
    # Tensor shape (bottom-right)
    ax.text(x + w - 0.2, purpose_y + 0.25, tensor_info, color='#FFEB3B', fontsize=10,
            ha='right', va='center', fontweight='bold',
            bbox=dict(facecolor='#333', edgecolor='#FFD54F', boxstyle='round,pad=0.2'))
    
    # Line reference
    ax.text(x + w - 0.1, y + h - 0.1, line_ref, fontsize=8, color='#FFEB3B',
            ha='right', va='top', style='italic',
            bbox=dict(facecolor='black', alpha=0.7, pad=1.5))
    
    return (x + w/2, y), (x + w/2, y + h)

def draw_arrow_with_label(ax, start, end, label, color='#555'):
    """Draw an arrow with a label in the middle."""
    mid_x = (start[0] + end[0]) / 2
    mid_y = (start[1] + end[1]) / 2
    ax.annotate("", xy=end, xytext=start,
                arrowprops=dict(arrowstyle="-|>", color=color, lw=2.5))
    if label:
        ax.text(mid_x + 0.15, mid_y, label, fontsize=9, color=color, fontweight='bold',
                va='center', ha='left',
                bbox=dict(facecolor='white', edgecolor='none', alpha=0.85))

# === TITLE ===
ax.text(10, 13.5, "PIPELINE TIỀN XỬ LÝ ẢNH X-QUANG (PREPROCESSING)",
        fontsize=18, fontweight='bold', ha='center', color='#1A237E')
ax.text(10, 13.1, "Tham chiếu: client_v5_dp.py  |  Hàm get_train_transforms() (L74-82)  &  get_eval_transforms() (L84-90)",
        fontsize=11, ha='center', color='#555', style='italic')

# === STEP 0: RAW INPUT ===
s0_b, s0_t = draw_step(ax, 7, 11.5, 6, 1.2,
    "BƯỚC 0: Ảnh X-quang Gốc (Raw Input)",
    ["File JPEG từ thư mục federated_data/<client>/<split>/<class>/"],
    "Dữ liệu thô chưa qua xử lý", "[H, W, 1~3]",
    "#424242", "L69-71")

# === STEP 1: CLAHE ===
s1_b, s1_t = draw_step(ax, 3, 9, 14, 1.8,
    "BƯỚC 1: CLAHE — Tăng Cường Tương Phản Cục Bộ",
    ["class CLAHE_Transform(clip_limit=2.0, tile_grid_size=(8,8))",
     "1. Chuyển ảnh RGB sang không gian màu LAB  (cv2.cvtColor COLOR_RGB2LAB)",
     "2. Tách kênh L (Luminance = Ánh sáng), giữ nguyên A, B (Màu sắc)",
     "3. Áp dụng CLAHE chỉ lên kênh L — chia ảnh thành ô 8x8, cân bằng histogram từng ô",
     "4. Gộp lại (L_enhanced, A, B) rồi chuyển ngược LAB -> RGB"],
    "Làm nổi bật vết mờ viêm phổi ẩn sau xương sườn", "[H, W, 3]",
    "#1565C0", "L40-52")
draw_arrow_with_label(ax, s0_b, s1_t, "PIL Image (RGB)", '#1565C0')

# === STEP 2: RESIZE ===
s2_b, s2_t = draw_step(ax, 3, 6.8, 6.5, 1.5,
    "BƯỚC 2a [Train]: Resize + RandomCrop",
    ["Resize(256, 256) — phóng to/thu nhỏ về 256px",
     "RandomCrop(224) — cắt ngẫu nhiên vùng 224x224",
     "Giúp AI nhìn ảnh từ nhiều góc khác nhau"],
    "Data Augmentation (Tăng cường dữ liệu)", "[224, 224, 3]",
    "#0277BD", "L77-78")

s2e_b, s2e_t = draw_step(ax, 10.5, 6.8, 6.5, 1.5,
    "BƯỚC 2b [Eval]: Resize",
    ["Resize(224, 224) — ép trực tiếp về 224px",
     "Không cắt ngẫu nhiên (cố định, nhất quán)",
     "Đảm bảo kết quả đánh giá ổn định, không dao động"],
    "Chuẩn hóa kích thước (Deterministic)", "[224, 224, 3]",
    "#0277BD", "L87")

draw_arrow_with_label(ax, (8, 9), (6.25, 8.3), "Train path", '#0277BD')
draw_arrow_with_label(ax, (12, 9), (13.75, 8.3), "Eval path", '#0277BD')

# === STEP 3: FLIP (Train only) ===
s3_b, s3_t = draw_step(ax, 3, 5, 6.5, 1.2,
    "BƯỚC 3 [Chỉ Train]: RandomHorizontalFlip",
    ["p=0.5 — Lật ngang ảnh với xác suất 50%",
     "Phổi trái/phải đối xứng nên lật không mất thông tin"],
    "Chống Overfitting (Tránh học vẹt vị trí)", "[224, 224, 3]",
    "#00838F", "L79")
draw_arrow_with_label(ax, s2_b, s3_t, "", '#00838F')

# Eval path bypasses flip
ax.annotate("", xy=(13.75, 5.6), xytext=(13.75, 6.8),
            arrowprops=dict(arrowstyle="-|>", color='#00838F', lw=2.5, linestyle='dashed'))
ax.text(14.5, 6.2, "Bỏ qua\n(Eval)", fontsize=9, color='#00838F', ha='center', style='italic')

# === STEP 4: TO TENSOR ===
s4_b, s4_t = draw_step(ax, 5, 3.2, 10, 1.2,
    "BƯỚC 4: ToTensor()",
    ["Chuyển đổi ảnh PIL (numpy) thành Tensor PyTorch",
     "Giá trị pixel: [0, 255] (số nguyên) ——> [0.0, 1.0] (số thực)  |  Hoán vị trục: [H,W,C] -> [C,H,W]"],
    "Định dạng đầu vào cho mạng Nơ-ron", "[3, 224, 224]",
    "#006064", "L80 / L88")

# Merge arrows into step 4
draw_arrow_with_label(ax, s3_b, (8, 4.4), "", '#006064')
ax.plot([13.75, 13.75, 10, 10], [5.6, 4.8, 4.8, 4.4], color='#006064', lw=2.5, linestyle='dashed')
ax.annotate("", xy=(10, 4.4), xytext=(10, 4.8),
            arrowprops=dict(arrowstyle="-|>", color='#006064', lw=2.5))

# === STEP 5: NORMALIZE ===
s5_b, s5_t = draw_step(ax, 3, 0.8, 14, 1.8,
    "BƯỚC 5: Normalize (Chuẩn hóa Phân phối ImageNet)",
    ["mean = [0.485, 0.456, 0.406]   (Trung bình 14 triệu ảnh ImageNet, theo kênh R/G/B)",
     "std  = [0.229, 0.224, 0.225]   (Độ lệch chuẩn của ImageNet)",
     "Công thức:  pixel_normalized = (pixel - mean) / std",
     "Giá trị đầu ra: ~ [-2.1, +2.6]  (Phân phối chuẩn xoay quanh 0)"],
    "Transfer Learning: Khớp phân phối dữ liệu đã pretrain", "[3, 224, 224]",
    "#004D40", "L81 / L89")
draw_arrow_with_label(ax, s4_b, s5_t, "Tensor float32", '#004D40')

# === OUTPUT ARROW ===
ax.annotate("", xy=(10, 0.3), xytext=(10, 0.8),
            arrowprops=dict(arrowstyle="-|>", color='#B71C1C', lw=3))
ax.text(10, 0.15, ">>> ĐẦU VÀO CHO MÔ HÌNH ENSEMBLE (DenseNet-121 + EfficientNet-B0) >>>",
        fontsize=13, fontweight='bold', ha='center', color='#B71C1C')

plt.tight_layout()
plt.savefig('plots/preprocessing_detailed_flowchart.png', dpi=250, bbox_inches='tight')
print("Saved to plots/preprocessing_detailed_flowchart.png")
