import json
import matplotlib.pyplot as plt
import numpy as np

def main():
    # Load Federated V4 Data
    try:
        with open('federated_metrics_fedprox_v4.json', 'r') as f:
            fed_data = json.load(f)['history']
    except:
        print("Fed V4 data not found.")
        return

    # Load Centralized V4 Data
    try:
        with open('centralized_metrics_v4.json', 'r') as f:
            cen_data = json.load(f)
    except:
        print("Cen V4 data not found.")
        return

    fed_rounds = sorted([int(k) for k in fed_data.keys()])
    fed_f1 = [fed_data[str(r)]['macro_f1'] for r in fed_rounds]
    fed_acc = [fed_data[str(r)]['accuracy'] for r in fed_rounds]

    cen_epochs = sorted([int(k) for k in cen_data.keys()])
    cen_f1 = [cen_data[str(e)]['test_f1'] for e in cen_epochs]
    cen_acc = [cen_data[str(e)]['test_acc'] for e in cen_epochs]

    # We will plot both on the same X-axis, scaling Epochs to Rounds to match visually
    # Cen has 15 epochs, Fed has 30 rounds. We can just plot them as "Communication Rounds / Epochs"
    
    plt.figure(figsize=(14, 6))

    # Plot F1 Score
    plt.subplot(1, 2, 1)
    plt.plot(cen_epochs, cen_f1, 'b^-', label='Centralized Baseline (Gold Standard)', linewidth=2, markersize=6)
    plt.plot(fed_rounds, fed_f1, 'go-', label='Federated Learning V4 (FedProx)', linewidth=2, markersize=4)
    plt.title('Macro F1-Score: Federated vs Centralized')
    plt.xlabel('Training Steps (Epochs / Rounds)')
    plt.ylabel('Macro F1 Score')
    plt.grid(True, linestyle='--', alpha=0.7)
    plt.legend()
    plt.ylim(0.8, 1.0)
    
    # Annotate Max F1
    max_cen_f1 = max(cen_f1)
    max_fed_f1 = max(fed_f1)
    plt.annotate(f'Max: {max_cen_f1:.4f}', xy=(cen_f1.index(max_cen_f1)+1, max_cen_f1), xytext=(5, 10), 
                 textcoords='offset points', color='blue', fontweight='bold')
    plt.annotate(f'Max: {max_fed_f1:.4f}', xy=(fed_f1.index(max_fed_f1)+1, max_fed_f1), xytext=(5, -15), 
                 textcoords='offset points', color='green', fontweight='bold')

    # Plot Accuracy
    plt.subplot(1, 2, 2)
    plt.plot(cen_epochs, cen_acc, 'b^-', label='Centralized Baseline', linewidth=2, markersize=6)
    plt.plot(fed_rounds, fed_acc, 'go-', label='Federated Learning V4', linewidth=2, markersize=4)
    plt.title('Accuracy: Federated vs Centralized')
    plt.xlabel('Training Steps (Epochs / Rounds)')
    plt.ylabel('Accuracy')
    plt.grid(True, linestyle='--', alpha=0.7)
    plt.legend()
    plt.ylim(0.85, 1.0)

    plt.tight_layout()
    plt.savefig('v4_comparison_plot.png', dpi=300)
    print("Plot saved.")

if __name__ == '__main__':
    main()
