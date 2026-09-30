#!/usr/bin/env python3
"""
process_nih_splits.py — NIH ChestX-ray14 → 3 Non-IID Federated Clients + Global Test Set
========================================================================================

Pipeline xử lý dữ liệu ảnh NIH ChestX-ray14 phục vụ Federated Learning:
  • Lọc 4 nhãn mục tiêu: Pneumonia, Infiltration, Atelectasis, No Finding
  • Phân tách Patient-Level (chống rò rỉ dữ liệu)
  • Tạo 3 Client Non-IID mô phỏng bệnh viện thực tế + 1 Global Test Set
  • Copy / Symlink song song tối ưu SSD
  • Xuất báo cáo JSON + CSV

Tác giả : KHKT Research Team
Phiên bản: 1.0.0
Seed mặc định: 42 (reproducibility)
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import os
import platform
import shutil
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

try:
    from tqdm import tqdm
except ImportError:
    print("[CẢNH BÁO] Thư viện `tqdm` chưa cài đặt. Cài bằng: pip install tqdm")
    print("           Script sẽ chạy không có thanh tiến trình.")

    class tqdm:  # type: ignore[no-redef]
        """Fallback stub khi tqdm chưa được cài đặt."""

        def __init__(self, iterable=None, *args, **kwargs):
            self.iterable = iterable
            self.total = kwargs.get("total", None)

        def __iter__(self):
            return iter(self.iterable) if self.iterable else iter([])

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def update(self, n: int = 1) -> None:
            pass

        def set_postfix_str(self, s: str) -> None:
            pass


# ═══════════════════════════════════════════════════════════════════════════════
# HẰNG SỐ VÀ CẤU HÌNH
# ═══════════════════════════════════════════════════════════════════════════════

TARGET_LABELS: List[str] = ["Pneumonia", "Infiltration", "Atelectasis", "No Finding"]

# Ma trận phân phối Non-IID: Xác suất gán patient vào từng client
# theo nhãn chủ đạo (dominant label) của patient đó.
# Hàng = dominant label, Cột = [Client1, Client2, Client3]
NON_IID_DISTRIBUTION: Dict[str, List[float]] = {
    #                        Client1   Client2   Client3
    #                        BV Phổi   Đa khoa   Tầm soát
    "Pneumonia":            [0.65,     0.20,     0.15],
    "Infiltration":         [0.60,     0.25,     0.15],
    "Atelectasis":          [0.15,     0.65,     0.20],
    "No Finding":           [0.10,     0.15,     0.75],
}

CLIENT_NAMES: Dict[int, str] = {
    0: "client_1_lung_hospital",      # Bệnh viện Phổi / Tuyến TW
    1: "client_2_emergency_general",   # Trung tâm Cấp cứu / Đa khoa
    2: "client_3_screening_clinic",    # Phòng khám Tầm soát
}

CLIENT_DESCRIPTIONS: Dict[int, str] = {
    0: "Bệnh viện Phổi / Tuyến Trung ương — Tỷ lệ cao Pneumonia & Infiltration",
    1: "Trung tâm Cấp cứu / Đa khoa — Tỷ lệ cao Atelectasis",
    2: "Phòng khám Tầm soát ban đầu — Tỷ lệ cao No Finding",
}

GLOBAL_TEST_FRACTION: float = 0.125  # ~12.5% bệnh nhân → global test

DEFAULT_SEED: int = 42
DEFAULT_WORKERS: int = 8
DEFAULT_MIN_IMAGES: int = 12000
DEFAULT_MAX_IMAGES: int = 15000

# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════════

LOG_FORMAT = "%(asctime)s │ %(levelname)-8s │ %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def setup_logging(verbose: bool = False) -> logging.Logger:
    """Khởi tạo logger với format đẹp cho terminal."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format=LOG_FORMAT, datefmt=DATE_FORMAT)
    logger = logging.getLogger("nih_pipeline")
    logger.setLevel(level)
    return logger


# ═══════════════════════════════════════════════════════════════════════════════
# DATA CLASSES
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class PatientRecord:
    """Thông tin tổng hợp của một bệnh nhân."""

    patient_id: int
    image_files: List[str] = field(default_factory=list)
    label_counts: Counter = field(default_factory=Counter)
    dominant_label: str = ""

    def finalize(self) -> None:
        """Xác định nhãn chủ đạo sau khi đã gom đủ ảnh."""
        if self.label_counts:
            self.dominant_label = self.label_counts.most_common(1)[0][0]


@dataclass
class SplitStats:
    """Thống kê của một split (client hoặc test set)."""

    split_name: str
    description: str
    num_patients: int
    num_images: int
    label_distribution: Dict[str, int] = field(default_factory=dict)
    label_percentages: Dict[str, float] = field(default_factory=dict)


# ═══════════════════════════════════════════════════════════════════════════════
# BƯỚC 1: ĐỌC VÀ LỌC METADATA
# ═══════════════════════════════════════════════════════════════════════════════


def load_and_filter_metadata(
    csv_path: Path,
    image_root: Path,
    target_labels: List[str],
    logger: logging.Logger,
) -> Tuple[List[Dict[str, Any]], Set[str]]:
    """
    Đọc Data_Entry_2017.csv, lọc các ảnh chỉ chứa ĐÚNG 1 nhãn mục tiêu
    (single-label) để đảm bảo tính rõ ràng khi phân phối Non-IID.

    Returns:
        filtered_rows: Danh sách dict {image_index, finding_label, patient_id}
        valid_images:   Tập hợp tên file ảnh đã xác minh tồn tại trên đĩa
    """
    logger.info("═" * 70)
    logger.info("BƯỚC 1: Đọc metadata từ %s", csv_path)

    if not csv_path.exists():
        raise FileNotFoundError(f"Không tìm thấy file CSV: {csv_path}")

    target_set = set(target_labels)
    filtered_rows: List[Dict[str, Any]] = []
    total_rows = 0
    skipped_multi = 0
    skipped_other = 0

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)

        # Kiểm tra cột bắt buộc
        required_cols = {"Image Index", "Finding Labels", "Patient ID"}
        if reader.fieldnames is None:
            raise ValueError("File CSV không có header.")
        missing = required_cols - set(reader.fieldnames)
        if missing:
            raise ValueError(f"CSV thiếu các cột bắt buộc: {missing}")

        for row in reader:
            total_rows += 1
            labels = [lb.strip() for lb in row["Finding Labels"].split("|")]

            # Chỉ lấy ảnh single-label thuộc target
            target_matches = [lb for lb in labels if lb in target_set]

            if len(target_matches) == 1 and len(labels) == 1:
                filtered_rows.append(
                    {
                        "image_index": row["Image Index"].strip(),
                        "finding_label": target_matches[0],
                        "patient_id": int(row["Patient ID"]),
                    }
                )
            elif len(target_matches) > 1 or len(labels) > 1:
                skipped_multi += 1
            else:
                skipped_other += 1

    logger.info("  Tổng số dòng CSV       : %d", total_rows)
    logger.info("  Ảnh single-label phù hợp: %d", len(filtered_rows))
    logger.info("  Bỏ qua (multi-label)    : %d", skipped_multi)
    logger.info("  Bỏ qua (nhãn ngoài)     : %d", skipped_other)

    # Kiểm tra file ảnh tồn tại thực tế trên đĩa
    logger.info("  Đang xác minh file ảnh trên đĩa...")
    valid_images: Set[str] = set()
    missing_count = 0

    image_names = {row["image_index"] for row in filtered_rows}

    # Xây dựng cache lookup nhanh: quét thư mục con một lần
    existing_files: Set[str] = set()
    for dirpath, _, filenames in os.walk(image_root):
        for fname in filenames:
            existing_files.add(fname)

    for img_name in image_names:
        if img_name in existing_files:
            valid_images.add(img_name)
        else:
            missing_count += 1

    # Lọc lại chỉ giữ ảnh tồn tại
    before = len(filtered_rows)
    filtered_rows = [r for r in filtered_rows if r["image_index"] in valid_images]
    logger.info("  Ảnh tồn tại trên đĩa    : %d / %d", len(valid_images), len(image_names))
    if missing_count > 0:
        logger.warning("  ⚠ %d ảnh trong CSV không tìm thấy trên đĩa — đã loại bỏ.", missing_count)
    logger.info("  Kết quả sau xác minh     : %d ảnh", len(filtered_rows))

    return filtered_rows, valid_images


# ═══════════════════════════════════════════════════════════════════════════════
# BƯỚC 2: GOM NHÓM THEO PATIENT ID
# ═══════════════════════════════════════════════════════════════════════════════


def group_by_patient(
    rows: List[Dict[str, Any]],
    logger: logging.Logger,
) -> Dict[int, PatientRecord]:
    """Gom nhóm các ảnh theo Patient ID và xác định dominant label."""
    logger.info("═" * 70)
    logger.info("BƯỚC 2: Gom nhóm theo Patient ID")

    patients: Dict[int, PatientRecord] = {}

    for row in rows:
        pid = row["patient_id"]
        if pid not in patients:
            patients[pid] = PatientRecord(patient_id=pid)
        patients[pid].image_files.append(row["image_index"])
        patients[pid].label_counts[row["finding_label"]] += 1

    for p in patients.values():
        p.finalize()

    # Thống kê phân bổ dominant label
    dominant_dist = Counter(p.dominant_label for p in patients.values())
    logger.info("  Tổng số bệnh nhân       : %d", len(patients))
    logger.info("  Phân bổ dominant label:")
    for label in TARGET_LABELS:
        count = dominant_dist.get(label, 0)
        logger.info("    %-15s : %5d bệnh nhân", label, count)

    return patients


# ═══════════════════════════════════════════════════════════════════════════════
# BƯỚC 3: LẤY MẪU ĐẠT MỤC TIÊU SỐ LƯỢNG ẢNH
# ═══════════════════════════════════════════════════════════════════════════════


def subsample_patients(
    patients: Dict[int, PatientRecord],
    min_images: int,
    max_images: int,
    rng: np.random.Generator,
    logger: logging.Logger,
) -> Dict[int, PatientRecord]:
    """
    Lấy mẫu phân tầng (stratified) theo dominant label
    để tổng số ảnh nằm trong khoảng [min_images, max_images].
    Nếu tổng ảnh hiện tại đã nằm trong khoảng, giữ nguyên.
    """
    logger.info("═" * 70)
    logger.info("BƯỚC 3: Điều chỉnh quy mô dataset (%d–%d ảnh)", min_images, max_images)

    total_images = sum(len(p.image_files) for p in patients.values())
    logger.info("  Tổng ảnh hiện tại: %d", total_images)

    if min_images <= total_images <= max_images:
        logger.info("  ✓ Đã nằm trong khoảng mục tiêu — giữ nguyên.")
        return patients

    # Gom patient theo dominant label
    label_groups: Dict[str, List[int]] = defaultdict(list)
    for pid, p in patients.items():
        label_groups[p.dominant_label].append(pid)

    if total_images > max_images:
        # Cần giảm: lấy mẫu tỷ lệ thuận từ mỗi nhóm label
        target = max_images
        ratio = target / total_images
        selected: Dict[int, PatientRecord] = {}

        for label, pids in label_groups.items():
            rng.shuffle(pids)  # type: ignore[arg-type]
            cum_images = 0
            group_target = int(
                sum(len(patients[p].image_files) for p in pids) * ratio
            )
            for pid in pids:
                if cum_images >= group_target:
                    break
                selected[pid] = patients[pid]
                cum_images += len(patients[pid].image_files)

        new_total = sum(len(p.image_files) for p in selected.values())
        logger.info(
            "  Đã giảm từ %d → %d ảnh (%d bệnh nhân)",
            total_images,
            new_total,
            len(selected),
        )
        return selected

    else:
        # Tổng ảnh < min_images: giữ nguyên và cảnh báo
        logger.warning(
            "  ⚠ Tổng ảnh (%d) < mục tiêu tối thiểu (%d). "
            "Giữ nguyên toàn bộ — hãy kiểm tra lại dữ liệu nguồn.",
            total_images,
            min_images,
        )
        return patients


# ═══════════════════════════════════════════════════════════════════════════════
# BƯỚC 4: PHÂN TÁCH GLOBAL TEST SET + 3 CLIENTS
# ═══════════════════════════════════════════════════════════════════════════════


def split_patients(
    patients: Dict[int, PatientRecord],
    test_fraction: float,
    distribution: Dict[str, List[float]],
    rng: np.random.Generator,
    logger: logging.Logger,
) -> Tuple[Dict[str, List[int]], Dict[int, PatientRecord]]:
    """
    Phân tách bệnh nhân:
      1) Global Test Set: ~test_fraction bệnh nhân, phân bổ đều theo label
      2) 3 Clients: phân phối Non-IID theo ma trận distribution

    Returns:
        assignments: {"global_test": [...], "client_0": [...], ...}
        patients:    dict gốc (không thay đổi)
    """
    logger.info("═" * 70)
    logger.info("BƯỚC 4: Phân tách Global Test + 3 Clients (Patient-Level)")
    logger.info("  Tỷ lệ test: %.1f%%", test_fraction * 100)

    assignments: Dict[str, List[int]] = {
        "global_test": [],
        "client_0": [],
        "client_1": [],
        "client_2": [],
    }

    # Gom patient theo dominant label
    label_groups: Dict[str, List[int]] = defaultdict(list)
    for pid, p in patients.items():
        label_groups[p.dominant_label].append(pid)

    for label in TARGET_LABELS:
        pids = label_groups.get(label, [])
        rng.shuffle(pids)  # type: ignore[arg-type]

        n_test = max(1, int(len(pids) * test_fraction))
        test_pids = pids[:n_test]
        train_pids = pids[n_test:]

        assignments["global_test"].extend(test_pids)

        # Phân phối train patients theo xác suất Non-IID
        probs = distribution.get(label, [1 / 3, 1 / 3, 1 / 3])
        probs_arr = np.array(probs, dtype=np.float64)
        probs_arr /= probs_arr.sum()  # chuẩn hóa

        if len(train_pids) > 0:
            client_indices = rng.choice(3, size=len(train_pids), p=probs_arr)
            for pid, cidx in zip(train_pids, client_indices):
                assignments[f"client_{cidx}"].append(pid)

    # Xác minh không có patient overlap
    all_assigned = set()
    for split_name, pids in assignments.items():
        pid_set = set(pids)
        overlap = all_assigned & pid_set
        if overlap:
            raise RuntimeError(
                f"⛔ PATIENT LEAKAGE DETECTED! {len(overlap)} patient(s) "
                f"xuất hiện ở nhiều split. IDs: {list(overlap)[:5]}..."
            )
        all_assigned.update(pid_set)

    logger.info("  ✓ Xác minh: KHÔNG có patient leakage.")

    for split_name, pids in assignments.items():
        n_imgs = sum(len(patients[pid].image_files) for pid in pids)
        logger.info(
            "  %-30s : %5d bệnh nhân │ %5d ảnh",
            split_name,
            len(pids),
            n_imgs,
        )

    return assignments, patients


# ═══════════════════════════════════════════════════════════════════════════════
# BƯỚC 5: TẠO THƯ MỤC VÀ COPY / SYMLINK ẢNH
# ═══════════════════════════════════════════════════════════════════════════════


def _find_image_path(image_name: str, image_root: Path) -> Optional[Path]:
    """Tìm đường dẫn thực tế của ảnh trong thư mục gốc (hỗ trợ thư mục con)."""
    # Thử trực tiếp
    direct = image_root / image_name
    if direct.exists():
        return direct

    # Quét thư mục con (images_001, images_002, ...)
    for subdir in sorted(image_root.iterdir()):
        if subdir.is_dir():
            candidate = subdir / image_name
            if candidate.exists():
                return candidate

    return None


def _build_image_lookup(image_root: Path, logger: logging.Logger) -> Dict[str, Path]:
    """
    Xây dựng bảng tra nhanh filename → full path bằng cách quét
    toàn bộ thư mục ảnh một lần duy nhất.
    """
    logger.info("  Đang quét thư mục ảnh để xây dựng bảng tra cứu...")
    lookup: Dict[str, Path] = {}
    for dirpath, _, filenames in os.walk(image_root):
        dp = Path(dirpath)
        for fname in filenames:
            if fname.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")):
                lookup[fname] = dp / fname
    logger.info("  Đã lập chỉ mục %d file ảnh.", len(lookup))
    return lookup


def _copy_or_link_file(
    src: Path,
    dst: Path,
    mode: str,
) -> Tuple[bool, str]:
    """
    Copy hoặc tạo symlink/hardlink cho một file ảnh.

    Returns:
        (success, message)
    """
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)

        if dst.exists() or dst.is_symlink():
            return True, "already_exists"

        if mode == "symlink":
            os.symlink(src.resolve(), dst)
        elif mode == "hardlink":
            os.link(src, dst)
        else:  # copy
            shutil.copy2(src, dst)

        return True, "ok"

    except OSError as e:
        return False, str(e)


def distribute_images(
    assignments: Dict[str, List[int]],
    patients: Dict[int, PatientRecord],
    image_root: Path,
    output_dir: Path,
    mode: str,
    num_workers: int,
    logger: logging.Logger,
) -> Dict[str, int]:
    """
    Phân phối ảnh vào các thư mục output theo assignments.
    Sử dụng ThreadPoolExecutor cho I/O song song.

    Cấu trúc output:
        output_dir/
        ├── global_test/
        │   ├── Pneumonia/
        │   ├── Infiltration/
        │   ├── Atelectasis/
        │   └── No_Finding/
        ├── client_1_lung_hospital/
        │   ├── train/
        │   │   ├── Pneumonia/
        │   │   └── ...
        │   └── val/
        │       └── ...
        └── ...

    Returns:
        Số lượng ảnh đã xử lý thành công theo từng split.
    """
    logger.info("═" * 70)
    logger.info("BƯỚC 5: Phân phối ảnh (%s mode, %d workers)", mode.upper(), num_workers)

    # Xây dựng lookup table một lần
    image_lookup = _build_image_lookup(image_root, logger)

    # Chuẩn bị danh sách task (src, dst)
    tasks: List[Tuple[Path, Path, str]] = []
    split_counts: Dict[str, int] = {}

    for split_key, pids in assignments.items():
        if split_key == "global_test":
            dir_name = "global_test"
            # Global test: flat structure theo label
            for pid in pids:
                p = patients[pid]
                for img_name in p.image_files:
                    label_dir = p.dominant_label.replace(" ", "_")
                    src = image_lookup.get(img_name)
                    if src is None:
                        continue
                    dst = output_dir / dir_name / label_dir / img_name
                    tasks.append((src, dst, mode))
        else:
            # Client: chia train/val (85/15) theo patient
            client_idx = int(split_key.split("_")[1])
            dir_name = CLIENT_NAMES[client_idx]
            client_pids = list(pids)

            # Chia train/val (vẫn theo patient-level!)
            n_val = max(1, int(len(client_pids) * 0.15))
            val_pids = set(client_pids[:n_val])
            train_pids = set(client_pids[n_val:])

            for pid in client_pids:
                p = patients[pid]
                subset = "val" if pid in val_pids else "train"
                for img_name in p.image_files:
                    label_dir = p.dominant_label.replace(" ", "_")
                    src = image_lookup.get(img_name)
                    if src is None:
                        continue
                    dst = output_dir / dir_name / subset / label_dir / img_name
                    tasks.append((src, dst, mode))

        split_counts[split_key] = sum(
            len(patients[pid].image_files) for pid in pids
        )

    logger.info("  Tổng số tác vụ I/O: %d", len(tasks))

    # Thực hiện song song
    success_count = 0
    error_count = 0

    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = {
            executor.submit(_copy_or_link_file, src, dst, m): (src, dst)
            for src, dst, m in tasks
        }

        with tqdm(total=len(futures), desc="📁 Phân phối ảnh", unit="file",
                   ncols=100, colour="green") as pbar:
            for future in as_completed(futures):
                ok, msg = future.result()
                if ok:
                    success_count += 1
                else:
                    error_count += 1
                    src, dst = futures[future]
                    logger.debug("  ✗ Lỗi: %s → %s : %s", src, dst, msg)
                pbar.update(1)

    logger.info("  ✓ Hoàn thành: %d thành công, %d lỗi", success_count, error_count)
    if error_count > 0:
        logger.warning("  ⚠ %d file gặp lỗi I/O — kiểm tra log ở chế độ --verbose.", error_count)

    return split_counts


# ═══════════════════════════════════════════════════════════════════════════════
# BƯỚC 6: XUẤT BÁO CÁO THỐNG KÊ
# ═══════════════════════════════════════════════════════════════════════════════


def compute_split_stats(
    split_name: str,
    description: str,
    patient_ids: List[int],
    patients: Dict[int, PatientRecord],
) -> SplitStats:
    """Tính thống kê chi tiết cho một split."""
    label_counts: Counter = Counter()
    for pid in patient_ids:
        label_counts.update(patients[pid].label_counts)

    total = sum(label_counts.values())
    percentages = {
        label: round(label_counts.get(label, 0) / total * 100, 2) if total > 0 else 0.0
        for label in TARGET_LABELS
    }
    distribution = {label: label_counts.get(label, 0) for label in TARGET_LABELS}

    return SplitStats(
        split_name=split_name,
        description=description,
        num_patients=len(patient_ids),
        num_images=total,
        label_distribution=distribution,
        label_percentages=percentages,
    )


def export_statistics(
    assignments: Dict[str, List[int]],
    patients: Dict[int, PatientRecord],
    output_dir: Path,
    elapsed_seconds: float,
    mode: str,
    seed: int,
    logger: logging.Logger,
) -> None:
    """Xuất dataset_summary.json và client_distribution.csv."""
    logger.info("═" * 70)
    logger.info("BƯỚC 6: Xuất báo cáo thống kê")

    all_stats: List[SplitStats] = []

    # Global test stats
    all_stats.append(
        compute_split_stats(
            "global_test",
            "Tập kiểm tra chung — phân bổ đều các nhãn",
            assignments["global_test"],
            patients,
        )
    )

    # Client stats
    for i in range(3):
        key = f"client_{i}"
        all_stats.append(
            compute_split_stats(
                CLIENT_NAMES[i],
                CLIENT_DESCRIPTIONS[i],
                assignments[key],
                patients,
            )
        )

    # ── JSON Report ──
    report = {
        "pipeline": "process_nih_splits.py",
        "version": "1.0.0",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "config": {
            "seed": seed,
            "mode": mode,
            "target_labels": TARGET_LABELS,
            "test_fraction": GLOBAL_TEST_FRACTION,
            "non_iid_distribution": NON_IID_DISTRIBUTION,
        },
        "performance": {
            "elapsed_seconds": round(elapsed_seconds, 2),
            "platform": platform.platform(),
        },
        "splits": [asdict(s) for s in all_stats],
        "total_patients": sum(s.num_patients for s in all_stats),
        "total_images": sum(s.num_images for s in all_stats),
    }

    json_path = output_dir / "dataset_summary.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    logger.info("  ✓ Đã ghi: %s", json_path)

    # ── CSV Report ──
    csv_path = output_dir / "client_distribution.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        header = [
            "Split",
            "Description",
            "Num_Patients",
            "Num_Images",
        ]
        for label in TARGET_LABELS:
            header.extend([f"{label}_Count", f"{label}_%"])
        writer.writerow(header)

        for s in all_stats:
            row = [
                s.split_name,
                s.description,
                s.num_patients,
                s.num_images,
            ]
            for label in TARGET_LABELS:
                row.append(s.label_distribution.get(label, 0))
                row.append(s.label_percentages.get(label, 0.0))
            writer.writerow(row)

    logger.info("  ✓ Đã ghi: %s", csv_path)

    # ── In tóm tắt ra terminal ──
    logger.info("═" * 70)
    logger.info("📊 TÓM TẮT KẾT QUẢ")
    logger.info("═" * 70)
    logger.info(
        "  %-35s │ %8s │ %8s │ %s",
        "SPLIT", "PATIENTS", "IMAGES", "PHÂN BỔ NHÃN (%)",
    )
    logger.info("  " + "─" * 95)
    for s in all_stats:
        pct_str = " │ ".join(
            f"{label[:4]}:{s.label_percentages.get(label, 0):5.1f}%"
            for label in TARGET_LABELS
        )
        logger.info(
            "  %-35s │ %8d │ %8d │ %s",
            s.split_name,
            s.num_patients,
            s.num_images,
            pct_str,
        )
    logger.info("  " + "─" * 95)
    total_p = sum(s.num_patients for s in all_stats)
    total_i = sum(s.num_images for s in all_stats)
    logger.info("  %-35s │ %8d │ %8d │", "TỔNG CỘNG", total_p, total_i)
    logger.info("═" * 70)
    logger.info("⏱  Thời gian xử lý: %.2f giây", elapsed_seconds)
    logger.info("═" * 70)


# ═══════════════════════════════════════════════════════════════════════════════
# BƯỚC 7: XUẤT MANIFEST PER-CLIENT (OPTIONAL)
# ═══════════════════════════════════════════════════════════════════════════════


def export_manifests(
    assignments: Dict[str, List[int]],
    patients: Dict[int, PatientRecord],
    output_dir: Path,
    logger: logging.Logger,
) -> None:
    """
    Xuất file manifest CSV cho mỗi split, liệt kê: image_index, label, patient_id.
    Phục vụ DataLoader PyTorch / TensorFlow.
    """
    logger.info("  Xuất manifest CSV cho từng split...")

    for split_key, pids in assignments.items():
        if split_key == "global_test":
            name = "global_test"
        else:
            idx = int(split_key.split("_")[1])
            name = CLIENT_NAMES[idx]

        manifest_path = output_dir / name / "manifest.csv"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)

        with open(manifest_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["image_index", "finding_label", "patient_id"])
            for pid in sorted(pids):
                p = patients[pid]
                for img in sorted(p.image_files):
                    writer.writerow([img, p.dominant_label, pid])

        logger.info("    ✓ %s (%d entries)", manifest_path.name, sum(len(patients[pid].image_files) for pid in pids))


# ═══════════════════════════════════════════════════════════════════════════════
# ARGPARSE & MAIN
# ═══════════════════════════════════════════════════════════════════════════════


def build_parser() -> argparse.ArgumentParser:
    """Xây dựng CLI parser với các tham số cần thiết."""
    parser = argparse.ArgumentParser(
        prog="process_nih_splits",
        description=(
            "🏥 NIH ChestX-ray14 → 3 Non-IID Federated Clients + Global Test Set\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "Pipeline phân tách dữ liệu y sinh phục vụ Federated Learning.\n"
            "Đảm bảo Patient-Level Split để chống rò rỉ dữ liệu."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Ví dụ sử dụng:\n"
            "  python process_nih_splits.py \\\n"
            "    --csv ./Data_Entry_2017.csv \\\n"
            "    --image-root ./images \\\n"
            "    --output ./federated_data \\\n"
            "    --mode symlink \\\n"
            "    --workers 12\n"
        ),
    )

    parser.add_argument(
        "--csv",
        type=str,
        required=True,
        help="Đường dẫn tới file Data_Entry_2017.csv",
    )
    parser.add_argument(
        "--image-root",
        type=str,
        required=True,
        help="Thư mục gốc chứa ảnh NIH (có thể chứa thư mục con images_001, images_002, ...)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="./federated_data",
        help="Thư mục output (mặc định: ./federated_data)",
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["copy", "symlink", "hardlink"],
        default="symlink",
        help="Chế độ phân phối ảnh: copy | symlink | hardlink (mặc định: symlink)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"Random seed để tái lập kết quả (mặc định: {DEFAULT_SEED})",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Số luồng I/O song song (mặc định: {DEFAULT_WORKERS})",
    )
    parser.add_argument(
        "--min-images",
        type=int,
        default=DEFAULT_MIN_IMAGES,
        help=f"Số ảnh tối thiểu mục tiêu (mặc định: {DEFAULT_MIN_IMAGES})",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=DEFAULT_MAX_IMAGES,
        help=f"Số ảnh tối đa mục tiêu (mặc định: {DEFAULT_MAX_IMAGES})",
    )
    parser.add_argument(
        "--test-fraction",
        type=float,
        default=GLOBAL_TEST_FRACTION,
        help=f"Tỷ lệ bệnh nhân cho Global Test Set (mặc định: {GLOBAL_TEST_FRACTION})",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Hiển thị log chi tiết (DEBUG level)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Chỉ chạy phân tích và xuất báo cáo, KHÔNG copy/symlink ảnh",
    )

    return parser


def main() -> None:
    """Entry point chính của pipeline."""
    parser = build_parser()
    args = parser.parse_args()

    logger = setup_logging(verbose=args.verbose)

    logger.info("╔══════════════════════════════════════════════════════════════════════╗")
    logger.info("║  🏥 NIH ChestX-ray14 → Federated Learning Data Pipeline            ║")
    logger.info("║  Patient-Level Split │ Non-IID │ 3 Clients + Global Test            ║")
    logger.info("╚══════════════════════════════════════════════════════════════════════╝")

    csv_path = Path(args.csv).resolve()
    image_root = Path(args.image_root).resolve()
    output_dir = Path(args.output).resolve()

    logger.info("  CSV         : %s", csv_path)
    logger.info("  Image Root  : %s", image_root)
    logger.info("  Output      : %s", output_dir)
    logger.info("  Mode        : %s", args.mode)
    logger.info("  Seed        : %d", args.seed)
    logger.info("  Workers     : %d", args.workers)
    logger.info("  Dry Run     : %s", args.dry_run)

    if not image_root.exists():
        logger.error("⛔ Thư mục ảnh không tồn tại: %s", image_root)
        sys.exit(1)

    # Tạo thư mục output
    output_dir.mkdir(parents=True, exist_ok=True)

    start_time = time.time()
    rng = np.random.default_rng(seed=args.seed)

    try:
        # Bước 1: Đọc và lọc metadata
        rows, valid_images = load_and_filter_metadata(
            csv_path, image_root, TARGET_LABELS, logger
        )

        if len(rows) == 0:
            logger.error("⛔ Không có ảnh nào phù hợp sau khi lọc. Dừng pipeline.")
            sys.exit(1)

        # Bước 2: Gom nhóm theo Patient ID
        patients = group_by_patient(rows, logger)

        # Bước 3: Điều chỉnh quy mô
        patients = subsample_patients(
            patients, args.min_images, args.max_images, rng, logger
        )

        # Bước 4: Phân tách Global Test + 3 Clients
        assignments, patients = split_patients(
            patients, args.test_fraction, NON_IID_DISTRIBUTION, rng, logger
        )

        # Bước 5: Copy/Symlink ảnh (trừ khi dry-run)
        if not args.dry_run:
            distribute_images(
                assignments, patients, image_root, output_dir,
                args.mode, args.workers, logger,
            )
        else:
            logger.info("═" * 70)
            logger.info("BƯỚC 5: [DRY RUN] Bỏ qua phân phối ảnh.")

        # Xuất manifests
        export_manifests(assignments, patients, output_dir, logger)

        elapsed = time.time() - start_time

        # Bước 6: Xuất báo cáo thống kê
        export_statistics(
            assignments, patients, output_dir, elapsed, args.mode, args.seed, logger
        )

        logger.info("🎉 PIPELINE HOÀN THÀNH THÀNH CÔNG!")
        logger.info("   Output: %s", output_dir)

    except FileNotFoundError as e:
        logger.error("⛔ File không tìm thấy: %s", e)
        sys.exit(1)
    except ValueError as e:
        logger.error("⛔ Lỗi dữ liệu: %s", e)
        sys.exit(1)
    except KeyboardInterrupt:
        logger.warning("\n⚠ Pipeline bị hủy bởi người dùng (Ctrl+C).")
        sys.exit(130)
    except Exception as e:
        logger.exception("⛔ Lỗi không mong muốn: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
