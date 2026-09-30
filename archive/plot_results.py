import json
import matplotlib.pyplot as plt
import numpy as np

def load_json(filepath):
    with open(filepath, 'r') as f:
        return json.load(f)

# 1. Load Data
centralized = load_json('centralized_output/centralized_baseline_metrics.json')
fedavg = load_json('federated_metrics_fedavg.json')
fedprox = load_json('federated_metrics_fedprox.json')

# 2. Extract Centralized (15 Epochs on Val)
cent_epochs = []
cent_acc = []
cent_f1 = []
for item in centralized['training_history']:
    cent_epochs.append(item['epoch'])
    cent_acc.append(item['val']['accuracy'])
    cent_f1.append(item['val']['macro_f1'])

# 3. Extract FL (20 Rounds on Global Test)
def extract_fl(fl_data):
    rounds = []
    acc = []
    f1 = []
    history = fl_data['history']
    # Sort keys as integers
    for r in sorted([int(k) for k in history.keys()]):
        if r == 0: continue # Skip round 0 (initial untrained model)
        rounds.append(r)
        acc.append(history[str(r)]['accuracy'])
        f1.append(history[str(r)]['macro_f1'])
    return rounds, acc, f1

fedavg_rounds, fedavg_acc, fedavg_f1 = extract_fl(fedavg)
fedprox_rounds, fedprox_acc, fedprox_f1 = extract_fl(fedprox)

# 4. Plot Settings
plt.style.use('seaborn-v0_8-darkgrid')
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

# Plot Accuracy
ax1.plot(cent_epochs, cent_acc, label='Centralized Baseline (Val)', color='blue', marker='o')
ax1.plot(fedavg_rounds, fedavg_acc, label='FedAvg (Global Test)', color='green', marker='s')
ax1.plot(fedprox_rounds, fedprox_acc, label='FedProx (Global Test)', color='red', marker='^', linestyle='--')
ax1.set_title('Model Accuracy Convergence')
ax1.set_xlabel('Epochs / Rounds')
ax1.set_ylabel('Accuracy')
ax1.legend()
ax1.set_ylim(0, 1.0)

# Plot F1 Score
ax2.plot(cent_epochs, cent_f1, label='Centralized Baseline (Val)', color='blue', marker='o')
ax2.plot(fedavg_rounds, fedavg_f1, label='FedAvg (Global Test)', color='green', marker='s')
ax2.plot(fedprox_rounds, fedprox_f1, label='FedProx (Global Test)', color='red', marker='^', linestyle='--')
ax2.set_title('Macro F1 Score Convergence')
ax2.set_xlabel('Epochs / Rounds')
ax2.set_ylabel('Macro F1 Score')
ax2.legend()
ax2.set_ylim(0, 0.4)

plt.tight_layout()
plt.savefig('federated_comparison_plot.png', dpi=300)
print("Plot saved to federated_comparison_plot.png")
