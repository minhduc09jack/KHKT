#!/usr/bin/env python3
import time
import os
import re
import sys

LOG_FILE = "/Users/maulen/.gemini/antigravity-ide/brain/e7f3e836-af95-4c02-b7f1-d0e58221c105/.system_generated/tasks/task-890.log"
TOTAL_ROUNDS = 30

def print_progress(current, total, bar_length=50):
    percent = float(current) / total
    arrow = '█' * int(round(percent * bar_length))
    spaces = '░' * (bar_length - len(arrow))
    sys.stdout.write(f"\r🚀 V5 (DP) Progress: [{arrow}{spaces}] {current}/{total} Rounds ({percent*100:.1f}%)")
    sys.stdout.flush()

def monitor():
    print(f"📡 Đang kết nối tới Server log...")
    if not os.path.exists(LOG_FILE):
        print(f"Đang chờ file log được khởi tạo...")
        while not os.path.exists(LOG_FILE):
            time.sleep(1)
            
    current_round = 0
    print_progress(current_round, TOTAL_ROUNDS)
    
    with open(LOG_FILE, "r") as f:
        while current_round < TOTAL_ROUNDS:
            line = f.readline()
            if not line:
                time.sleep(1)
                continue
            
            # Tìm kiếm keyword [ROUND X] trong log của Server
            match = re.search(r'\[ROUND (\d+)\]', line)
            if match:
                round_num = int(match.group(1))
                if round_num > current_round:
                    current_round = round_num
                    print_progress(current_round, TOTAL_ROUNDS)
                    
            if "Federated Learning completed" in line or "Simulation finished" in line:
                current_round = TOTAL_ROUNDS
                print_progress(current_round, TOTAL_ROUNDS)
                break
                
    print("\n\n🎉 Toàn bộ mô phỏng V5 DP đã hoàn thành! Bạn có thể kiểm tra file JSON kết quả.")

if __name__ == "__main__":
    try:
        monitor()
    except KeyboardInterrupt:
        print("\n\nĐã thoát trình theo dõi (Tiến trình ngầm vẫn đang chạy).")
