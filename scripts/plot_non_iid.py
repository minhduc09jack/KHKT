import matplotlib.pyplot as plt
import numpy as np
from pathlib import Path
import os

# Đường dẫn dữ liệu
data_root = Path("federated_data")
clients = ["client_1_lung_hospital", "client_2_emergency_general", "client_3_screening_clinic"]
client_labels = ["Client 1\n(BV Phổi)", "Client 2\n(BV Đa khoa)", "Client 3\n(PK Sàng lọc)"]

# Khởi tạo mảng đếm
normals = []
pneumonias = []

# Đếm số lượng file trong từng thư mục
for client in clients:
    normal_dir = data_root / client / "train" / "NORMAL"
    pneumonia_dir = data_root / client / "train" / "PNEUMONIA"
    
    n_count = len(list(normal_dir.glob("*.jpeg"))) if normal_dir.exists() else 0
    p_count = len(list(pneumonia_dir.glob("*.jpeg"))) if pneumonia_dir.exists() else 0
    
    normals.append(n_count)
    pneumonias.append(p_count)

print("Normals:", normals)
print("Pneumonias:", pneumonias)

# --- VẼ BIỂU ĐỒ ---
fig, ax = plt.subplots(figsize=(10, 6))

x = np.arange(len(clients))
width = 0.6

# Biểu đồ cột chồng (Stacked Bar Chart)
p1 = ax.bar(x, normals, width, label='Bình thường (NORMAL)', color='#2ca02c', edgecolor='black', linewidth=1.2)
p2 = ax.bar(x, pneumonias, width, bottom=normals, label='Viêm phổi (PNEUMONIA)', color='#d62728', edgecolor='black', linewidth=1.2)

# Hiển thị số liệu trực tiếp trên cột
for i, (n, p) in enumerate(zip(normals, pneumonias)):
    # Text cho NORMAL
    if n > 0:
        ax.text(i, n / 2, str(n), ha='center', va='center', color='white', fontweight='bold', fontsize=12)
    # Text cho PNEUMONIA
    if p > 0:
        ax.text(i, n + p / 2, str(p), ha='center', va='center', color='white', fontweight='bold', fontsize=12)
    # Text Tổng cộng trên đỉnh cột
    ax.text(i, n + p + 50, f"Tổng: {n+p}", ha='center', va='bottom', color='black', fontweight='bold', fontsize=12)

# Cấu hình biểu đồ
ax.set_ylabel('Số lượng ảnh X-quang', fontsize=12, fontweight='bold')
ax.set_xticks(x)
ax.set_xticklabels(client_labels, fontsize=12, fontweight='bold')
ax.legend(fontsize=11, loc='upper left')



plt.ylim(0, max([n+p for n, p in zip(normals, pneumonias)]) + 300)
plt.tight_layout()

# Lưu ảnh
os.makedirs("plots", exist_ok=True)
plt.savefig('plots/non_iid_distribution.png', dpi=300, bbox_inches='tight')
print("Saved to plots/non_iid_distribution.png")
