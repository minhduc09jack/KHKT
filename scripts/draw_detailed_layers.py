import matplotlib.pyplot as plt
import matplotlib.patches as patches

fig, ax = plt.subplots(figsize=(16, 12))
ax.set_xlim(0, 16)
ax.set_ylim(0, 12)
ax.axis('off')

# Hàm vẽ khối (Block)
def draw_block(ax, x, y, width, height, title, tensor_shape, bg_color):
    rect = patches.FancyBboxPatch((x, y), width, height, boxstyle="round,pad=0.1", 
                                  linewidth=1.5, edgecolor='#333333', facecolor=bg_color)
    ax.add_patch(rect)
    ax.text(x + width/2, y + height/2 + 0.2, title, color='white', fontsize=11, 
            ha='center', va='center', fontweight='bold')
    ax.text(x + width/2, y + height/2 - 0.2, tensor_shape, color='#ffeb3b', fontsize=10, 
            ha='center', va='center', style='italic')
    return (x + width/2, y), (x + width/2, y + height), (x, y + height/2), (x + width, y + height/2)

# Hàm vẽ mũi tên
def draw_arrow(ax, start, end, text="", rad=0.0):
    ax.annotate("", xy=end, xytext=start,
                arrowprops=dict(arrowstyle="-|>", color="#555555", lw=2, connectionstyle=f"arc3,rad={rad}"))
    if text:
        mid_x = (start[0] + end[0]) / 2
        mid_y = (start[1] + end[1]) / 2
        ax.text(mid_x + 0.2, mid_y, text, fontsize=9, ha='left', va='center', color='#333333', fontweight='bold')

# --- 1. PREPROCESSING ---
in_b, in_t, _, _ = draw_block(ax, 6.5, 10.5, 3, 1, "Input X-Ray Image", "[B, 1, H, W]", "#424242")
pre_b, pre_t, _, _ = draw_block(ax, 6.5, 8.5, 3, 1.2, "CLAHE & RGB Convert\nResize & Normalize", "[B, 3, 224, 224]", "#1f77b4")
draw_arrow(ax, in_b, pre_t, "Tiền xử lý")

# Tách nhánh
split_point = (8, 7.8)
ax.plot([8, 8], [7.8, 8.5], color="#555555", lw=2)
ax.plot([4, 12], [7.8, 7.8], color="#555555", lw=2)
draw_arrow(ax, (4, 7.8), (4, 7.3))
draw_arrow(ax, (12, 7.8), (12, 7.3))

# --- 2. DENSENET-121 BRANCH (Left) ---
d1_b, d1_t, _, _ = draw_block(ax, 2.5, 6.3, 3, 1, "DenseNet Features\n(Conv + Dense Blocks)", "[B, 1024, 7, 7]", "#2ca02c")
d2_b, d2_t, _, _ = draw_block(ax, 2.5, 4.8, 3, 0.8, "AdaptiveAvgPool2d(1)", "[B, 1024, 1, 1]", "#8c564b")
d3_b, d3_t, _, _ = draw_block(ax, 2.5, 3.3, 3, 0.8, "Flatten", "[B, 1024]", "#7f7f7f")
d4_b, d4_t, d4_l, d4_r = draw_block(ax, 2.5, 1.8, 3, 0.8, "Linear Classifier", "[B, 2]", "#ff7f0e")

draw_arrow(ax, d1_b, d2_t)
draw_arrow(ax, d2_b, d3_t)
draw_arrow(ax, d3_b, d4_t)

# --- 3. EFFICIENTNET-B0 BRANCH (Right) ---
e1_b, e1_t, _, _ = draw_block(ax, 10.5, 6.3, 3, 1, "EfficientNet Features\n(MBConv Blocks)", "[B, 1280, 7, 7]", "#2ca02c")
e2_b, e2_t, _, _ = draw_block(ax, 10.5, 4.8, 3, 0.8, "AdaptiveAvgPool2d(1)", "[B, 1280, 1, 1]", "#8c564b")
e3_b, e3_t, _, _ = draw_block(ax, 10.5, 3.3, 3, 0.8, "Flatten & Dropout(0.2)", "[B, 1280]", "#7f7f7f")
e4_b, e4_t, e4_l, e4_r = draw_block(ax, 10.5, 1.8, 3, 0.8, "Linear Classifier", "[B, 2]", "#ff7f0e")

draw_arrow(ax, e1_b, e2_t)
draw_arrow(ax, e2_b, e3_t)
draw_arrow(ax, e3_b, e4_t)

# --- 4. AGGREGATION & OUTPUT ---
agg_b, agg_t, _, _ = draw_block(ax, 6.5, 0.5, 3, 1.2, "Soft Voting\n(Logits_1 + Logits_2) / 2", "[B, 2]", "#d62728")

draw_arrow(ax, d4_b, (6.5, 1.1), " Logits 1", rad=-0.2)
draw_arrow(ax, e4_b, (9.5, 1.1), " Logits 2", rad=0.2) # Mũi tên từ nhánh phải về giữa

# Thêm Softmax text
ax.text(8, 0.2, "Dự đoán: Softmax(Logits) -> Xác suất Normal/Pneumonia", color='red', fontsize=12, fontweight='bold', ha='center')

# Title
plt.title("CHI TIẾT LỚP (LAYER-BY-LAYER) MÔ HÌNH CHEST-XRAY ENSEMBLE", fontsize=16, fontweight='bold', pad=20)

# Legend giải thích Tensor
legend_text = "Chú thích Kích thước Tensor (B: Batch Size):\n" \
              "- [B, 3, 224, 224]: Ảnh RGB kích thước 224x224\n" \
              "- [B, 1024, 7, 7]: Bản đồ đặc trưng (Feature Map) 7x7 với 1024 kênh\n" \
              "- [B, 1024]: Vector đặc trưng (Feature Vector) sau khi gộp (Pooling)\n" \
              "- [B, 2]: Vector Logits đầu ra (Lớp 0: Normal, Lớp 1: Pneumonia)"
ax.text(0.5, 11, legend_text, fontsize=10, bbox=dict(facecolor='#f0f0f0', edgecolor='gray', boxstyle='round,pad=0.5'))

plt.tight_layout()
plt.savefig('plots/model_layers_detailed.png', dpi=300, bbox_inches='tight')
print("Saved to plots/model_layers_detailed.png")
