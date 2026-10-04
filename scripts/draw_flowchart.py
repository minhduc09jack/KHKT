import matplotlib.pyplot as plt
import matplotlib.patches as patches

fig, ax = plt.subplots(figsize=(14, 10))
ax.set_xlim(0, 14)
ax.set_ylim(0, 10)
ax.axis('off')

# Hàm vẽ hộp
def draw_box(ax, x, y, width, height, text, bg_color, text_color, fontsize=12):
    rect = patches.FancyBboxPatch((x, y), width, height, boxstyle="round,pad=0.1", 
                                  linewidth=2, edgecolor='black', facecolor=bg_color)
    ax.add_patch(rect)
    ax.text(x + width/2, y + height/2, text, color=text_color, fontsize=fontsize, 
            ha='center', va='center', fontweight='bold')
    return (x + width/2, y), (x + width/2, y + height), (x, y + height/2), (x + width, y + height/2) # Bottom, Top, Left, Right

# Server
_, s_top, _, s_right = draw_box(ax, 5, 7.5, 4, 1.5, "GLOBAL SERVER\n(Hội đồng Trung ương)\nKhởi tạo Trọng số AI\nDenseNet-121 + EfficientNet", "#1f77b4", "white", 11)

# DP
dp_bottom, dp_top, _, _ = draw_box(ax, 5, 5.5, 4, 1, "BẢO MẬT VI PHÂN (DP)\nThêm Gaussian Noise (σ=0.01)\nL2-Norm Clipping", "#d62728", "white", 11)

# Clients
c1_bottom, c1_top, _, _ = draw_box(ax, 1, 2, 3.5, 1.5, "CLIENT 1 (BV Phổi)\n780 Ảnh (35% PN)\nThuật toán: FedProx", "#2ca02c", "white", 10)
c2_bottom, c2_top, _, _ = draw_box(ax, 5.25, 2, 3.5, 1.5, "CLIENT 2 (BV Cấp cứu)\n1347 Ảnh (81% PN)\nThuật toán: FedProx", "#2ca02c", "white", 10)
c3_bottom, c3_top, _, _ = draw_box(ax, 9.5, 2, 3.5, 1.5, "CLIENT 3 (PK Sàng lọc)\n1624 Ảnh (84% PN)\nThuật toán: FedProx", "#2ca02c", "white", 10)

# Aggregation
agg_bottom, agg_top, agg_left, _ = draw_box(ax, 9.5, 7.5, 3.5, 1.5, "TỔNG HỢP TRỌNG SỐ\n(FedAvg Aggregation)", "#ff7f0e", "white", 11)

# Test
draw_box(ax, 1, 7.5, 3, 1, "GLOBAL TEST\n(1170 Ảnh cách ly)", "#7f7f7f", "white", 11)

# Vẽ mũi tên
def draw_arrow(ax, start, end, text="", rad=0.0):
    ax.annotate("", xy=end, xytext=start,
                arrowprops=dict(arrowstyle="->", color="black", lw=2, connectionstyle=f"arc3,rad={rad}"))
    if text:
        mid_x = (start[0] + end[0]) / 2
        mid_y = (start[1] + end[1]) / 2
        ax.text(mid_x, mid_y, text, fontsize=9, ha='center', va='center', bbox=dict(facecolor='white', edgecolor='none', alpha=0.8))

# Từ Server tới DP
draw_arrow(ax, (7, 7.5), (7, 6.5))

# Từ DP tới Clients
draw_arrow(ax, (7, 5.5), (2.75, 3.5), "Broadcast\nTrọng số Bảo mật", rad=0.1)
draw_arrow(ax, (7, 5.5), (7, 3.5), "Broadcast\nTrọng số Bảo mật")
draw_arrow(ax, (7, 5.5), (11.25, 3.5), "Broadcast\nTrọng số Bảo mật", rad=-0.1)

# Từ Clients lên Agg
draw_arrow(ax, (2.75, 2), (11.25, 7.5), "Gửi Bản cập nhật AI", rad=-0.2)
draw_arrow(ax, (7, 2), (11.25, 7.5), "Gửi Bản cập nhật AI", rad=-0.1)
draw_arrow(ax, (11.25, 3.5), (11.25, 7.5), "Gửi Bản cập nhật AI")

# Từ Agg sang Server
draw_arrow(ax, (9.5, 8.25), (9, 8.25))

# Đánh dấu vòng lặp
ax.text(11.25, 9.5, "Lặp lại quá trình 30 Vòng (Rounds)", fontsize=12, color="blue", fontweight="bold", ha="center")

# Tiêu đề
plt.title("SƠ ĐỒ KIẾN TRÚC HỆ THỐNG FEDERATED LEARNING V5", fontsize=16, fontweight='bold', pad=20)

plt.tight_layout()
plt.savefig('plots/v5_architecture_flowchart.png', dpi=300)
print("Saved to plots/v5_architecture_flowchart.png")
