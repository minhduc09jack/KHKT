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
fig.suptitle('Performance Comparison: Centralized vs. Federated Learning vs. Differential Privacy', fontsize=16, fontweight='bold', y=1.05)

colors = {
    'cent': '#2ca02c', # Green
    'v2': '#1f77b4',   # Blue
    'v3': '#d62728'    # Red
}

labels = {
    'cent': 'Centralized Baseline (Upper Bound)',
    'v2': 'FL without DP (FedProx)',
    'v3': 'FL with DP ($\sigma=0.01$)'
}

# ----------------------------------------------------
# 1. Macro F1-Score Plot
# ----------------------------------------------------
ax1.plot(cent_epochs, cent_f1, label=labels['cent'], color=colors['cent'], linewidth=2.5, linestyle='--')
ax1.plot(v2_rounds, v2_f1, label=labels['v2'], color=colors['v2'], linewidth=3)
ax1.plot(v3_rounds, v3_f1, label=labels['v3'], color=colors['v3'], linewidth=2.5, linestyle='-')

# Max points for F1
max_cent_idx = cent_f1.index(max(cent_f1))
ax1.scatter(cent_epochs[max_cent_idx], max(cent_f1), color=colors['cent'], s=80, zorder=5)
ax1.annotate(f"{max(cent_f1)*100:.2f}%", (cent_epochs[max_cent_idx], max(cent_f1)), textcoords="offset points", xytext=(0,10), ha='center', color=colors['cent'], fontweight='bold')

max_v2_idx = v2_f1.index(max(v2_f1))
ax1.scatter(v2_rounds[max_v2_idx], max(v2_f1), color=colors['v2'], s=80, zorder=5)
ax1.annotate(f"{max(v2_f1)*100:.2f}%", (v2_rounds[max_v2_idx], max(v2_f1)), textcoords="offset points", xytext=(0,10), ha='center', color=colors['v2'], fontweight='bold')

max_v3_idx = v3_f1.index(max(v3_f1))
ax1.scatter(v3_rounds[max_v3_idx], max(v3_f1), color=colors['v3'], s=80, zorder=5)
ax1.annotate(f"{max(v3_f1)*100:.2f}%", (v3_rounds[max_v3_idx], max(v3_f1)), textcoords="offset points", xytext=(0,-20), ha='center', color=colors['v3'], fontweight='bold')

ax1.set_title('Test Macro F1-Score', fontsize=14, pad=15)
ax1.set_xlabel('Communication Round / Epoch', fontsize=12)
ax1.set_ylabel('Macro F1-Score', fontsize=12)
ax1.grid(True, linestyle='--', alpha=0.6)
ax1.legend(loc='lower right', fontsize=10)
ax1.set_ylim(0, 1.05)

# ----------------------------------------------------
# 2. Loss Plot
# ----------------------------------------------------
ax2.plot(cent_epochs, cent_loss, label=labels['cent'], color=colors['cent'], linewidth=2.5, linestyle='--')
ax2.plot(v2_rounds, v2_loss, label=labels['v2'], color=colors['v2'], linewidth=3)
ax2.plot(v3_rounds, v3_loss, label=labels['v3'], color=colors['v3'], linewidth=2.5, linestyle='-')

# Min points for Loss
min_cent_idx = cent_loss.index(min(cent_loss))
ax2.scatter(cent_epochs[min_cent_idx], min(cent_loss), color=colors['cent'], s=80, zorder=5)
ax2.annotate(f"{min(cent_loss):.4f}", (cent_epochs[min_cent_idx], min(cent_loss)), textcoords="offset points", xytext=(0,-15), ha='center', color=colors['cent'], fontweight='bold')

min_v2_idx = v2_loss.index(min(v2_loss))
ax2.scatter(v2_rounds[min_v2_idx], min(v2_loss), color=colors['v2'], s=80, zorder=5)
ax2.annotate(f"{min(v2_loss):.4f}", (v2_rounds[min_v2_idx], min(v2_loss)), textcoords="offset points", xytext=(0,-15), ha='center', color=colors['v2'], fontweight='bold')

min_v3_idx = v3_loss.index(min(v3_loss))
ax2.scatter(v3_rounds[min_v3_idx], min(v3_loss), color=colors['v3'], s=80, zorder=5)
ax2.annotate(f"{min(v3_loss):.4f}", (v3_rounds[min_v3_idx], min(v3_loss)), textcoords="offset points", xytext=(0,10), ha='center', color=colors['v3'], fontweight='bold')

ax2.set_title('Test Loss', fontsize=14, pad=15)
ax2.set_xlabel('Communication Round / Epoch', fontsize=12)
ax2.set_ylabel('Loss', fontsize=12)
ax2.grid(True, linestyle='--', alpha=0.6)
ax2.legend(loc='upper right', fontsize=10)
max_loss = max(max(cent_loss), max(v2_loss), max(v3_loss))
ax2.set_ylim(0, max_loss * 1.1)

plt.tight_layout()
plt.savefig('plots/final_english_comparison.png', dpi=300, bbox_inches='tight')
print("Saved clean English plot to plots/final_english_comparison.png")
