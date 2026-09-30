#!/usr/bin/env python3
import time
import re
import os

LOG_FILE = "/Users/maulen/.gemini/antigravity-ide/brain/e7f3e836-af95-4c02-b7f1-d0e58221c105/.system_generated/tasks/task-815.log"
HTML_FILE = "dashboard/index.html"
TOTAL_ROUNDS = 30

os.makedirs("dashboard", exist_ok=True)

HTML_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="5">
    <title>AI Training Dashboard</title>
    <style>
        body {{ font-family: -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; text-align: center; padding: 10vh 5vw; margin: 0; }}
        .card {{ background: #161b22; border: 1px solid #30363d; border-radius: 15px; padding: 30px 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }}
        h1 {{ color: #58a6ff; font-size: 1.5em; margin-bottom: 5px; }}
        h2 {{ color: #8b949e; font-size: 1.2em; font-weight: normal; margin-top: 0; }}
        .progress-bar {{ width: 100%; background: #21262d; border-radius: 20px; overflow: hidden; margin: 25px 0; height: 25px; border: 1px solid #30363d; }}
        .progress {{ width: {percent}%; background: linear-gradient(90deg, #238636, #2ea043); height: 100%; transition: width 0.5s ease-in-out; }}
        .percent-text {{ font-size: 2em; font-weight: bold; color: #ffffff; margin-bottom: 20px; }}
        .metrics {{ margin-top: 25px; padding: 15px; background: #0d1117; border-radius: 10px; font-size: 1.1em; color: #7ee787; border: 1px dashed #30363d; }}
    </style>
</head>
<body>
    <div class="card">
        <h1>🚀 Federated Learning V5 (DP)</h1>
        <h2>Ensemble + Differential Privacy</h2>
        
        <div class="progress-bar">
            <div class="progress"></div>
        </div>
        
        <div class="percent-text">{percent:.1f}%</div>
        <h2 style="color: #c9d1d9;">Round {current} / {total}</h2>
        
        <div class="metrics">
            {metrics}
        </div>
    </div>
</body>
</html>
"""

def main():
    while True:
        current = 0
        metrics_text = "Đang chờ hoàn thành Round 1..."
        if os.path.exists(LOG_FILE):
            with open(LOG_FILE, "r") as f:
                content = f.read()
                matches = re.findall(r'\[ROUND (\d+)\]', content)
                if matches:
                    current = int(matches[-1])
                
                # Check for metrics
                metrics_match = re.findall(r'Global Test │ Loss: ([\d.]+) │ Acc: ([\d.]+)% │ F1: ([\d.]+)', content)
                if metrics_match:
                    loss, acc, f1 = metrics_match[-1]
                    metrics_text = f"🎯 Đánh giá gần nhất:<br><br><b>Accuracy:</b> {acc}%<br><b>Macro F1:</b> {f1}"
        
        percent = (current / TOTAL_ROUNDS) * 100
        
        with open(HTML_FILE, "w") as f:
            f.write(HTML_TEMPLATE.format(current=current, total=TOTAL_ROUNDS, percent=percent, metrics=metrics_text))
            
        time.sleep(3)

if __name__ == "__main__":
    main()
