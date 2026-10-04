import json
import matplotlib.pyplot as plt

def load_json(filepath):
    with open(filepath, 'r') as f:
        return json.load(f)

# Tải dữ liệu
cent_data = load_json('centralized_metrics_v2.json')
v2_data = load_json('federated_metrics_fedprox_v2.json')
v3_data = load_json('federated_metrics_v3_dp_sigma0.01.json')

# Xử lý Centralized
cent_epochs = [int(k) for k in cent_data.keys()]
cent_f1 = [val['test_f1'] for val in cent_data.values()]

# Xử lý Federated V2
v2_rounds = [int(k) for k in v2_data['history'].keys()]
v2_f1 = [val['macro_f1'] for val in v2_data['history'].values()]

# Xử lý Federated V3 (DP)
v3_rounds = [item[0] for item in v3_data['history']]
v3_f1 = [item[1]['macro_f1'] for item in v3_data['history']]

# Vẽ đồ thị
plt.figure(figsize=(12, 7))
plt.plot(cent_epochs, cent_f1, label='Upper Bound (Gộp dữ liệu)', color='#2ca02c', linewidth=2.5, linestyle='--')
plt.plot(v2_rounds, v2_f1, label='FL V2 (FedProx - Không bảo mật)', color='#1f77b4', linewidth=3)
plt.plot(v3_rounds, v3_f1, label='FL V3 (FedProx + Differential Privacy)', color='#d62728', linewidth=2.5, linestyle='-')

# Điểm cao nhất
max_cent_idx = cent_f1.index(max(cent_f1))
plt.scatter(cent_epochs[max_cent_idx], max(cent_f1), color='green', s=100, zorder=5)
plt.annotate(f"Max: {max(cent_f1)*100:.2f}%", (cent_epochs[max_cent_idx], max(cent_f1)), textcoords="offset points", xytext=(0,10), ha='center', color='green', fontweight='bold')

max_v2_idx = v2_f1.index(max(v2_f1))
plt.scatter(v2_rounds[max_v2_idx], max(v2_f1), color='blue', s=100, zorder=5)
plt.annotate(f"Max: {max(v2_f1)*100:.2f}%", (v2_rounds[max_v2_idx], max(v2_f1)), textcoords="offset points", xytext=(0,10), ha='center', color='blue', fontweight='bold')

max_v3_idx = v3_f1.index(max(v3_f1))
plt.scatter(v3_rounds[max_v3_idx], max(v3_f1), color='red', s=100, zorder=5)
plt.annotate(f"Max: {max(v3_f1)*100:.2f}%", (v3_rounds[max_v3_idx], max(v3_f1)), textcoords="offset points", xytext=(0,-20), ha='center', color='red', fontweight='bold')

plt.title('ĐÁNH ĐỔI BẢO MẬT & HIỆU SUẤT (PRIVACY-UTILITY TRADE-OFF)', fontsize=14, fontweight='bold', pad=20)
plt.xlabel('Vòng huấn luyện (Communication Round / Epoch)', fontsize=12)
plt.ylabel('Macro F1-Score', fontsize=12)
plt.grid(True, linestyle='--', alpha=0.7)
plt.legend(loc='lower right', fontsize=11, framealpha=0.9, shadow=True)
plt.ylim(0, 1.05)

# Đánh dấu "Khoảng cách Trade-off"
plt.axhspan(max(v3_f1), max(v2_f1), color='gray', alpha=0.1)
plt.text(15, (max(v3_f1) + max(v2_f1))/2, "Đánh đổi Bảo mật (Chưa tới 1%)", color='black', fontsize=10, style='italic', ha='center', va='center')

plt.tight_layout()
plt.savefig('v3_final_tradeoff_plot.png', dpi=300)
print("Đã lưu biểu đồ thành v3_final_tradeoff_plot.png")
