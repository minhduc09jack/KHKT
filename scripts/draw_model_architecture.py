import matplotlib.pyplot as plt
import matplotlib.patches as patches

fig, ax = plt.subplots(figsize=(15, 8))
ax.set_xlim(0, 15)
ax.set_ylim(0, 8)
ax.axis('off')

def draw_box(ax, x, y, width, height, text, bg_color, text_color, fontsize=11):
    rect = patches.FancyBboxPatch((x, y), width, height, boxstyle="round,pad=0.1", 
                                  linewidth=2, edgecolor='black', facecolor=bg_color)
    ax.add_patch(rect)
    ax.text(x + width/2, y + height/2, text, color=text_color, fontsize=fontsize, 
            ha='center', va='center', fontweight='bold', wrap=True)
    return (x + width/2, y), (x + width/2, y + height), (x, y + height/2), (x + width, y + height/2)

def draw_arrow(ax, start, end, text="", rad=0.0):
    ax.annotate("", xy=end, xytext=start,
                arrowprops=dict(arrowstyle="->", color="black", lw=2, connectionstyle=f"arc3,rad={rad}"))
    if text:
        mid_x = (start[0] + end[0]) / 2
        mid_y = (start[1] + end[1]) / 2
        ax.text(mid_x, mid_y, text, fontsize=9, ha='center', va='center', bbox=dict(facecolor='white', edgecolor='none', alpha=0.8))

# 1. Input
in_b, in_t, in_l, in_r = draw_box(ax, 0.5, 3.5, 2, 1, "Ảnh X-quang Gốc\n(Raw Chest X-ray)", "#7f7f7f", "white")

# 2. Preprocessing
prep_b, prep_t, prep_l, prep_r = draw_box(ax, 3.5, 3, 2.5, 2, "Tiền xử lý (Preprocessing)\n\n1. Áp dụng CLAHE\n2. Resize (224x224)\n3. Chuẩn hóa (Normalize)", "#1f77b4", "white")
draw_arrow(ax, in_r, prep_l)

# 3. Ensemble Split Point
split_x = 6.5
draw_arrow(ax, prep_r, (split_x, 4))
ax.plot([split_x, split_x], [2.5, 5.5], color="black", lw=2) # Vertical split line
draw_arrow(ax, (split_x, 5.5), (7.5, 5.5))
draw_arrow(ax, (split_x, 2.5), (7.5, 2.5))

# 4. DenseNet-121 Branch
d_b, d_t, d_l, d_r = draw_box(ax, 7.5, 5, 2.5, 1, "DenseNet-121\n(Feature Extractor)", "#2ca02c", "white")
d_fc_b, d_fc_t, d_fc_l, d_fc_r = draw_box(ax, 10.5, 5, 1.5, 1, "FC Layer\n(2 classes)", "#ff7f0e", "white")
draw_arrow(ax, d_r, d_fc_l)

# 5. EfficientNet-B0 Branch
e_b, e_t, e_l, e_r = draw_box(ax, 7.5, 2, 2.5, 1, "EfficientNet-B0\n(Feature Extractor)", "#2ca02c", "white")
e_fc_b, e_fc_t, e_fc_l, e_fc_r = draw_box(ax, 10.5, 2, 1.5, 1, "FC Layer\n(2 classes)", "#ff7f0e", "white")
draw_arrow(ax, e_r, e_fc_l)

# 6. Ensemble Aggregation
agg_x = 12.5
ax.plot([agg_x, agg_x], [2.5, 5.5], color="black", lw=2) # Vertical merge line
draw_arrow(ax, d_fc_r, (agg_x, 5.5))
draw_arrow(ax, e_fc_r, (agg_x, 2.5))
draw_arrow(ax, (agg_x, 4), (13, 4))

# 7. Output
out_b, out_t, out_l, out_r = draw_box(ax, 13, 3.5, 1.5, 1, "Soft Voting\n(Average)\n\nOUTPUT", "#d62728", "white")

# Adding notations
ax.text(8.75, 6.2, "Bắt xuất đặc trưng (Feature Extraction)", fontsize=11, color="black", ha="center", style='italic')
ax.text(11.25, 6.2, "Phân loại (Classifier)", fontsize=11, color="black", ha="center", style='italic')

# Title
plt.title("SƠ ĐỒ CHI TIẾT KIẾN TRÚC MÔ HÌNH CHẾT-XRAY ENSEMBLE", fontsize=16, fontweight='bold', pad=20)

plt.tight_layout()
plt.savefig('plots/model_architecture.png', dpi=300, bbox_inches='tight')
print("Saved to plots/model_architecture.png")
