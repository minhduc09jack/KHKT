import json
import math
import matplotlib.pyplot as plt

def load_json(filepath):
    with open(filepath, 'r') as f:
        return json.load(f)

# Load data
try:
    cent_data = load_json('metrics/centralized_metrics_v1.json')
    v2_data = load_json('metrics/federated_metrics_fedprox_v2.json')
    v3_data = load_json('metrics/federated_metrics_v3_dp_sigma0.01.json')
except FileNotFoundError:
    cent_data = load_json('centralized_metrics_v1.json')
    v2_data = load_json('federated_metrics_fedprox_v2.json')
    v3_data = load_json('federated_metrics_v3_dp_sigma0.01.json')

# Process Centralized
cent_epochs = [int(k) for k in cent_data.keys()]
cent_f1 = [val['test_f1'] for val in cent_data.values()]
cent_loss = [-math.log(max(val['test_f1'], 0.1)) * 0.9 for val in cent_data.values()] # Estimated

# Process FL V2
v2_rounds = [int(k) for k in v2_data['history'].keys()]
v2_f1 = [val['macro_f1'] for val in v2_data['history'].values()]
v2_loss = [val['loss'] for val in v2_data['history'].values()]

# Process FL V3 (DP)
v3_rounds = [item[0] for item in v3_data['history']]
v3_f1 = [item[1]['macro_f1'] for item in v3_data['history']]
v3_loss = [item[1]['loss'] for item in v3_data['history']]

# Plotting settings
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 6))

colors = {
    'cent': '#2ca02c', # Green
    'v2': '#1f77b4',   # Blue
    'v3': '#d62728'    # Red
}

labels = {
    'v3': r'Phiên bản V3 (FL + DP) ($\sigma=0.01$)'
}

# ----------------------------------------------------
# 1. Macro F1-Score Plot
# ----------------------------------------------------
ax1.plot(v3_rounds, v3_f1, label=labels['v3'], color=colors['v3'], linewidth=2.5, linestyle='-')

# Max points for F1

max_v3_idx = v3_f1.index(max(v3_f1))
ax1.scatter(v3_rounds[max_v3_idx], max(v3_f1), color=colors['v3'], s=80, zorder=5)
ax1.annotate(f"{max(v3_f1)*100:.2f}%", (v3_rounds[max_v3_idx], max(v3_f1)), textcoords="offset points", xytext=(0,-20), ha='center', color=colors['v3'], fontweight='bold')

ax1.set_title('Chỉ số Macro F1-Score (Test F1-Score)', fontsize=14, pad=15)
ax1.set_xlabel('Vòng giao tiếp / Epoch', fontsize=12)
ax1.set_ylabel('Macro F1-Score', fontsize=12)
ax1.grid(True, linestyle='--', alpha=0.6)
ax1.legend(loc='lower right', fontsize=10)
ax1.set_ylim(0, 1.05)

# ----------------------------------------------------
# 2. Loss Plot
# ----------------------------------------------------
ax2.plot(v3_rounds, v3_loss, label=labels['v3'], color=colors['v3'], linewidth=2.5, linestyle='-')

# Min points for Loss

min_v3_idx = v3_loss.index(min(v3_loss))
ax2.scatter(v3_rounds[min_v3_idx], min(v3_loss), color=colors['v3'], s=80, zorder=5)
ax2.annotate(f"{min(v3_loss):.4f}", (v3_rounds[min_v3_idx], min(v3_loss)), textcoords="offset points", xytext=(0,10), ha='center', color=colors['v3'], fontweight='bold')

ax2.set_title('Chỉ số mất mát (Test Loss)', fontsize=14, pad=15)
ax2.set_xlabel('Vòng giao tiếp / Epoch', fontsize=12)
ax2.set_ylabel('Loss', fontsize=12)
ax2.grid(True, linestyle='--', alpha=0.6)
ax2.legend(loc='upper right', fontsize=10)
max_loss = max(v3_loss)
ax2.set_ylim(0, max_loss * 1.1)

plt.tight_layout()
plt.savefig('plots/final_vietnamese_v3_only.png', dpi=300, bbox_inches='tight')
print("Saved clean Vietnamese plot to plots/final_vietnamese_v3_only.png")
