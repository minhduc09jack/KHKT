import json
import re

log_file = "/Users/maulen/.gemini/antigravity-ide/brain/e7f3e836-af95-4c02-b7f1-d0e58221c105/.system_generated/tasks/task-890.log"
json_file = "federated_metrics_v5_dp_sigma0.01.json"

history = []
with open(log_file, "r") as f:
    for line in f:
        # Looking for lines like: fit progress: (29, 0.1999, {'accuracy': 0.9085, 'macro_f1': 0.8929}
        if "fit progress:" in line:
            match = re.search(r"fit progress: \((\d+), ([0-9\.]+), \{'accuracy': ([0-9\.]+), 'macro_f1': ([0-9\.]+)\}", line)
            if match:
                rnd = int(match.group(1))
                loss = float(match.group(2))
                acc = float(match.group(3))
                f1 = float(match.group(4))
                # Add if not already present
                if not any(item[0] == rnd for item in history):
                    history.append((rnd, {"accuracy": acc, "macro_f1": f1}))

data = {
    "rounds": 30,
    "sigma": 0.01,
    "history": history
}

with open(json_file, "w") as f:
    json.dump(data, f, indent=2)

print(f"Successfully recovered {len(history)} rounds into {json_file}")
