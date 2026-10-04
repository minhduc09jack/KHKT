import matplotlib.pyplot as plt
import numpy as np

# Data
models = ['Phiên bản V1\n(Mô hình Tập trung)', 'Phiên bản V2\n(FL Không DP)', 'Phiên bản V3\n(FL + DP)']
recall_scores = [97.31, 94.73, 98.36]
false_negatives = [23, 45, 14]
colors = ['#2ca02c', '#d62728', '#1f77b4'] # Green, Red, Blue

fig, ax1 = plt.subplots(figsize=(10, 6))

# Plot Recall as bar chart
bars = ax1.bar(models, recall_scores, color=colors, alpha=0.85, width=0.6, edgecolor='black', linewidth=1.2)

# Configure primary axis (Recall)
ax1.set_ylim(90, 100) # Phóng to khoảng để thấy rõ sự khác biệt
ax1.set_ylabel('Recall (%) - Khả năng phát hiện Viêm phổi', fontsize=12, fontweight='bold')
ax1.tick_params(axis='y', labelsize=11)
ax1.tick_params(axis='x', labelsize=12)
ax1.grid(axis='y', linestyle='--', alpha=0.7)

# Add data labels on top of bars
for bar, score in zip(bars, recall_scores):
    height = bar.get_height()
    ax1.text(bar.get_x() + bar.get_width()/2., height + 0.2,
            f'{score}%', ha='center', va='bottom', fontsize=13, fontweight='bold')

# Create secondary axis for False Negatives (Line plot)
ax2 = ax1.twinx()
ax2.set_ylim(0, 50)
ax2.set_ylabel('Số ca bị bỏ sót (False Negatives)', fontsize=12, fontweight='bold', color='black')
ax2.plot(models, false_negatives, color='#ff7f0e', marker='o', markersize=10, linewidth=3, linestyle='-', label='Số ca bị bỏ sót')
ax2.tick_params(axis='y', labelsize=11)

# Add data labels for False Negatives
for i, fn in enumerate(false_negatives):
    ax2.text(i, fn + 1.5, f'Bỏ sót {fn} ca', ha='center', va='bottom', fontsize=11, fontweight='bold', color='#d55e00',
             bbox=dict(facecolor='white', alpha=0.8, edgecolor='none', pad=1))

# Title
plt.title("SO SÁNH CHỈ SỐ RECALL (ĐỘ NHẠY)\nVÀ SỐ CA BỎ SÓT BỆNH NHÂN (FALSE NEGATIVES)", 
          fontsize=15, fontweight='bold', pad=20)

plt.tight_layout()
plt.savefig('plots/recall_comparison.png', dpi=300, bbox_inches='tight')
print("Saved to plots/recall_comparison.png")
