import json
import matplotlib.pyplot as plt
import numpy as np

def load_json(filepath):
    with open(filepath, 'r') as f:
        return json.load(f)

# Load data
centralized = load_json('centralized_output/centralized_baseline_metrics.json')
fedavg_v1 = load_json('federated_metrics_fedavg.json')
fedprox_v2 = load_json('federated_metrics_fedprox_v2.json')

# Centralized
cent_epochs = [item['epoch'] for item in centralized['training_history']]
cent_acc = [item['val']['accuracy'] for item in centralized['training_history']]
cent_f1 = [item['val']['macro_f1'] for item in centralized['training_history']]

def extract_fl(fl_data):
    rounds = []
    acc = []
    f1 = []
    history = fl_data['history']
    for r in sorted([int(k) for k in history.keys()]):
        if r == 0: continue
        rounds.append(r)
        acc.append(history[str(r)]['accuracy'])
        f1.append(history[str(r)]['macro_f1'])
    return rounds, acc, f1

# FL
v1_rounds, v1_acc, v1_f1 = extract_fl(fedavg_v1)
v2_rounds, v2_acc, v2_f1 = extract_fl(fedprox_v2)

# Plot
plt.style.use('seaborn-v0_8-darkgrid')
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

# Plot Accuracy
ax1.plot(cent_epochs, cent_acc, label='Centralized (15 Epochs)', color='#1f77b4', marker='o')
ax1.plot(v1_rounds, v1_acc, label='FedAvg V1 (20 Rounds)', color='#2ca02c', marker='s')
ax1.plot(v2_rounds, v2_acc, label='FedProx V2 (50 Rounds)', color='#d62728', linestyle='--', linewidth=2)
ax1.set_title('Model Accuracy Convergence')
ax1.set_xlabel('Epochs / Rounds')
ax1.set_ylabel('Global Test Accuracy')
ax1.legend()
ax1.set_ylim(0, 1.0)

# Plot F1 Score
ax2.plot(cent_epochs, cent_f1, label='Centralized (15 Epochs)', color='#1f77b4', marker='o')
ax2.plot(v1_rounds, v1_f1, label='FedAvg V1 (20 Rounds)', color='#2ca02c', marker='s')
ax2.plot(v2_rounds, v2_f1, label='FedProx V2 (50 Rounds)', color='#d62728', linestyle='--', linewidth=2)
ax2.set_title('Macro F1 Score (The Overfitting Paradox)')
ax2.set_xlabel('Epochs / Rounds')
ax2.set_ylabel('Global Test Macro F1 Score')
ax2.legend()
ax2.set_ylim(0, 0.4)

plt.tight_layout()
plt.savefig('v1_vs_v2_comparison.png', dpi=300)
print("Plot saved.")
