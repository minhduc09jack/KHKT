import json
import matplotlib.pyplot as plt
import numpy as np

def main():
    try:
        with open('federated_metrics_fedprox_v4.json', 'r') as f:
            v4_data = json.load(f)['history']
    except FileNotFoundError:
        print("V4 results file not found.")
        return

    rounds = sorted([int(k) for k in v4_data.keys()])
    v4_acc = [v4_data[str(r)]['accuracy'] * 100 for r in rounds]
    v4_f1 = [v4_data[str(r)]['macro_f1'] for r in rounds]

    plt.figure(figsize=(12, 5))

    # Plot Accuracy
    plt.subplot(1, 2, 1)
    plt.plot(rounds, v4_acc, 'go-', label='V4 (Ensemble DenseNet+EfficientNet)', linewidth=2, markersize=4)
    plt.title('Global Accuracy over FL Rounds')
    plt.xlabel('Round')
    plt.ylabel('Accuracy (%)')
    plt.grid(True, linestyle='--', alpha=0.7)
    plt.legend()
    plt.ylim(70, 100)

    # Plot Macro F1
    plt.subplot(1, 2, 2)
    plt.plot(rounds, v4_f1, 'mo-', label='V4 (Ensemble DenseNet+EfficientNet)', linewidth=2, markersize=4)
    plt.title('Global Macro F1-Score over FL Rounds')
    plt.xlabel('Round')
    plt.ylabel('Macro F1')
    plt.grid(True, linestyle='--', alpha=0.7)
    plt.legend()
    plt.ylim(0.5, 1.0)

    plt.tight_layout()
    plt.savefig('v4_results_plot.png', dpi=300)
    print("V4 plot saved successfully.")

if __name__ == '__main__':
    main()
