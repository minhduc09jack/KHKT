import matplotlib.pyplot as plt
import matplotlib.patches as patches

fig, ax = plt.subplots(figsize=(18, 22))
ax.set_xlim(0, 18)
ax.set_ylim(0, 22)
ax.axis('off')

# --- Hàm vẽ ---
def draw_block(ax, x, y, w, h, lines, bg, tc='white', fs=10, ls=None):
    rect = patches.FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.15",
                                  linewidth=2, edgecolor='#333', facecolor=bg)
    ax.add_patch(rect)
    for i, line in enumerate(lines):
        offset = h/2 - (i - (len(lines)-1)/2) * 0.35
        ax.text(x + w/2, y + offset, line, color=tc, fontsize=fs,
                ha='center', va='center', fontweight='bold' if i == 0 else 'normal')
    if ls:
        ax.text(x + w - 0.15, y + h - 0.15, ls, fontsize=8, color='yellow',
                ha='right', va='top', style='italic',
                bbox=dict(facecolor='black', alpha=0.6, pad=1.5))
    return (x + w/2, y), (x + w/2, y + h)

def arrow(ax, s, e):
    ax.annotate("", xy=e, xytext=s, arrowprops=dict(arrowstyle="-|>", color="#444", lw=2))

def section_label(ax, x, y, text, color='#333'):
    ax.text(x, y, text, fontsize=14, color=color, fontweight='bold',
            bbox=dict(facecolor='#f0f0f0', edgecolor=color, boxstyle='round,pad=0.3'))

# ==================== PHASE 1: INPUT & PREPROCESSING ====================
section_label(ax, 0.5, 21.2, "PHASE 1: INPUT & PREPROCESSING (Tiền xử lý ảnh)")

# Input
b1, t1 = draw_block(ax, 6, 20, 6, 0.8,
    ["INPUT: Ảnh X-quang phổi (JPEG, Grayscale/RGB, kích thước bất kỳ)"],
    "#616161", ls="L70")

# CLAHE
b2, t2 = draw_block(ax, 4, 18.2, 10, 1.5,
    ["CLAHE_Transform (Tăng cường Tương phản Cục bộ)",
     "clip_limit=2.0  |  tile_grid_size=(8, 8)",
     "RGB -> LAB -> CLAHE trên kênh L -> LAB -> RGB",
     "Tensor: [H, W, 3] (Giữ nguyên kích thước)"],
    "#1565C0", ls="L40-52")
arrow(ax, b1, t2)

# Resize
b3, t3 = draw_block(ax, 4, 16.5, 10, 1,
    ["Resize(256, 256) + RandomCrop(224)  [Train]",
     "Resize(224, 224)  [Eval]",
     "Tensor: [224, 224, 3]"],
    "#0277BD", ls="L77-78 / L87")
arrow(ax, b2, t3)

# Augmentation
b4, t4 = draw_block(ax, 4, 15.2, 10, 0.8,
    ["RandomHorizontalFlip(p=0.5)  [Chỉ Train]",
     "Lật ngang ngẫu nhiên 50% ảnh -> Tăng đa dạng dữ liệu"],
    "#00838F", ls="L79")
arrow(ax, b3, t4)

# ToTensor
b5, t5 = draw_block(ax, 4, 14, 10, 0.8,
    ["ToTensor()",
     "Chuyển ảnh PIL -> Tensor PyTorch, ép pixel [0,255] -> [0.0, 1.0]",
     "Tensor: [3, 224, 224]"],
    "#006064", ls="L80 / L88")
arrow(ax, b4, t5)

# Normalize
b6, t6 = draw_block(ax, 4, 12.5, 10, 1,
    ["Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])",
     "Chuẩn hóa ImageNet: pixel = (pixel - mean) / std",
     "Tensor: [3, 224, 224] (giá trị ~ -2.0 đến +2.5)"],
    "#004D40", ls="L81 / L89")
arrow(ax, b5, t6)

# ==================== PHASE 2: ENSEMBLE MODEL ====================
section_label(ax, 0.5, 11.6, "PHASE 2: ENSEMBLE MODEL (Mô hình Lai Kép)", color='#1B5E20')

# Split
split_y = 11.2
ax.plot([9, 9], [split_y, 12.5], color="#444", lw=2)
ax.plot([4, 14], [split_y, split_y], color="#444", lw=2)
arrow(ax, (4, split_y), (4, 10.8))
arrow(ax, (14, split_y), (14, 10.8))

# --- DENSENET BRANCH (LEFT) ---
ax.text(4, 11, "NHÁNH 1: DenseNet-121", fontsize=12, color='#1B5E20',
        fontweight='bold', ha='center')

d1_b, d1_t = draw_block(ax, 1.5, 9, 5, 1.2,
    ["densenet121(weights=DenseNet121_Weights.DEFAULT)",
     "121 lớp | 4 Dense Blocks | ~7.0M params",
     "Conv2d(3,64,7,s=2) -> BN -> ReLU -> MaxPool",
     "Output: [B, 1024, 7, 7]"],
    "#2E7D32", ls="L95")
arrow(ax, (4, 10.8), d1_t)

d2_b, d2_t = draw_block(ax, 1.5, 7.5, 5, 0.8,
    ["AdaptiveAvgPool2d(output_size=1)",
     "Gộp toàn bộ Feature Map 7x7 -> 1x1",
     "Output: [B, 1024, 1, 1]"],
    "#388E3C", ls="Tích hợp")
arrow(ax, d1_b, d2_t)

d3_b, d3_t = draw_block(ax, 1.5, 6.2, 5, 0.8,
    ["Flatten() -> [B, 1024]",
     "densenet.classifier = Linear(1024, 2)",
     "Output: [B, 2] (Logits DenseNet)"],
    "#43A047", ls="L96")
arrow(ax, d2_b, d3_t)

# --- EFFICIENTNET BRANCH (RIGHT) ---
ax.text(14, 11, "NHÁNH 2: EfficientNet-B0", fontsize=12, color='#1B5E20',
        fontweight='bold', ha='center')

e1_b, e1_t = draw_block(ax, 11.5, 9, 5, 1.2,
    ["efficientnet_b0(weights=EfficientNet_B0_Weights.DEFAULT)",
     "MBConv Blocks | Squeeze-Excitation | ~5.3M params",
     "Conv2d(3,32,3,s=2) -> BN -> SiLU -> MBConv1-7",
     "Output: [B, 1280, 7, 7]"],
    "#2E7D32", ls="L97")
arrow(ax, (14, 10.8), e1_t)

e2_b, e2_t = draw_block(ax, 11.5, 7.5, 5, 0.8,
    ["AdaptiveAvgPool2d(output_size=1)",
     "Gộp toàn bộ Feature Map 7x7 -> 1x1",
     "Output: [B, 1280, 1, 1]"],
    "#388E3C", ls="Tích hợp")
arrow(ax, e1_b, e2_t)

e3_b, e3_t = draw_block(ax, 11.5, 6.2, 5, 0.8,
    ["Dropout(p=0.2) -> Flatten() -> [B, 1280]",
     "efficientnet.classifier[1] = Linear(1280, 2)",
     "Output: [B, 2] (Logits EfficientNet)"],
    "#43A047", ls="L98")
arrow(ax, e2_b, e3_t)

# ==================== PHASE 3: SOFT VOTING ====================
section_label(ax, 0.5, 5.4, "PHASE 3: SOFT VOTING & OUTPUT (Biểu quyết Mềm)", color='#B71C1C')

merge_y = 5.8
ax.plot([4, 4], [5.8, 6.2], color="#444", lw=2)
ax.plot([14, 14], [5.8, 6.2], color="#444", lw=2)
ax.plot([4, 14], [5.8, 5.8], color="#444", lw=2)
arrow(ax, (9, 5.8), (9, 5.3))

sv_b, sv_t = draw_block(ax, 5, 4, 8, 1,
    ["Soft Voting:  output = (logits_dense + logits_eff) / 2.0",
     "Lấy trung bình cộng Logits của 2 nhánh",
     "Output: [B, 2]"],
    "#C62828", ls="L99-100")

# ==================== PHASE 4: LOSS & DP ====================
section_label(ax, 0.5, 3.2, "PHASE 4: LOSS, OPTIMIZER & DIFFERENTIAL PRIVACY", color='#4A148C')

loss_b, loss_t = draw_block(ax, 1, 1.5, 7.5, 1.2,
    ["CrossEntropyLoss(weight=[w_normal, 1.0])",
     "w_normal = count(PN) / count(Normal) (Cân bằng lớp)",
     "Optimizer: AdamW(lr=2e-4, weight_decay=1e-4)",
     "Local Epochs: 3 | Batch Size: 16"],
    "#6A1B9A", ls="L112-115")
arrow(ax, sv_b, loss_t)

dp_b, dp_t = draw_block(ax, 9.5, 1.5, 7.5, 1.2,
    ["Differential Privacy (LDP)",
     "1. Tính Delta = W_new - W_old (chỉ trainable)",
     "2. L2-Norm Clipping: C=1.0",
     "3. Gaussian Noise: N(0, sigma*C), sigma=0.01"],
    "#4A148C", ls="L186-209")

# Title
fig.suptitle("SƠ ĐỒ CHI TIẾT TỪNG LỚP — MÔ HÌNH CHEST-XRAY ENSEMBLE V5\n(Tham chiếu: client_v5_dp.py)",
             fontsize=18, fontweight='bold', y=0.98)

# Legend
ax.text(0.5, 0.3,
    "Ghi chú: Nhãn vàng góc phải mỗi khối = Số dòng (Line) trong file client_v5_dp.py  |  B = Batch Size  |  Tổng tham số mô hình: ~12.3M",
    fontsize=10, style='italic', color='#555')

plt.tight_layout(rect=[0, 0.02, 1, 0.96])
plt.savefig('plots/model_detailed_flowchart.png', dpi=250, bbox_inches='tight')
print("Saved to plots/model_detailed_flowchart.png")
