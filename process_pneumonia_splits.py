#!/usr/bin/env python3
import os
import shutil
import random
from pathlib import Path
from tqdm import tqdm

def main():
    raw_dir = Path("pneumonia_raw_data/chest_xray")
    if not raw_dir.exists():
        # Maybe it's in a subfolder
        raw_dir = Path("pneumonia_raw_data/chest_xray/chest_xray")
        if not raw_dir.exists():
            print("Could not find chest_xray directory.")
            return

    output_dir = Path("federated_data")
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)

    # Collect all images
    images = {"NORMAL": [], "PNEUMONIA": []}
    for split in ["train", "val", "test"]:
        for cls in ["NORMAL", "PNEUMONIA"]:
            cls_dir = raw_dir / split / cls
            if cls_dir.exists():
                images[cls].extend(list(cls_dir.glob("*.jpeg")))

    print(f"Total NORMAL: {len(images['NORMAL'])}")
    print(f"Total PNEUMONIA: {len(images['PNEUMONIA'])}")

    random.seed(42)
    random.shuffle(images["NORMAL"])
    random.shuffle(images["PNEUMONIA"])

    # 1. Global Test Set (20%)
    test_ratio = 0.2
    test_counts = {
        "NORMAL": int(len(images["NORMAL"]) * test_ratio),
        "PNEUMONIA": int(len(images["PNEUMONIA"]) * test_ratio)
    }

    test_images = {
        "NORMAL": images["NORMAL"][:test_counts["NORMAL"]],
        "PNEUMONIA": images["PNEUMONIA"][:test_counts["PNEUMONIA"]]
    }

    rem_images = {
        "NORMAL": images["NORMAL"][test_counts["NORMAL"]:],
        "PNEUMONIA": images["PNEUMONIA"][test_counts["PNEUMONIA"]:]
    }

    # 2. Clients Non-IID Split
    # Client 1: 50% of Normal, 10% of Pneumonia
    # Client 2: 25% of Normal, 40% of Pneumonia
    # Client 3: 25% of Normal, 50% of Pneumonia
    def get_client_counts(total, r1, r2, r3):
        c1 = int(total * r1)
        c2 = int(total * r2)
        c3 = total - c1 - c2
        return c1, c2, c3

    c1_n, c2_n, c3_n = get_client_counts(len(rem_images["NORMAL"]), 0.50, 0.25, 0.25)
    c1_p, c2_p, c3_p = get_client_counts(len(rem_images["PNEUMONIA"]), 0.10, 0.40, 0.50)

    client_splits = {
        "client_1_lung_hospital": {
            "NORMAL": rem_images["NORMAL"][:c1_n],
            "PNEUMONIA": rem_images["PNEUMONIA"][:c1_p]
        },
        "client_2_emergency_general": {
            "NORMAL": rem_images["NORMAL"][c1_n:c1_n+c2_n],
            "PNEUMONIA": rem_images["PNEUMONIA"][c1_p:c1_p+c2_p]
        },
        "client_3_screening_clinic": {
            "NORMAL": rem_images["NORMAL"][c1_n+c2_n:],
            "PNEUMONIA": rem_images["PNEUMONIA"][c1_p+c2_p:]
        }
    }

    def copy_files(img_list, dest_dir):
        dest_dir.mkdir(parents=True, exist_ok=True)
        for img_path in img_list:
            shutil.copy(img_path, dest_dir / img_path.name)

    # Write Global Test
    print("Creating global_test...")
    for cls in ["NORMAL", "PNEUMONIA"]:
        copy_files(test_images[cls], output_dir / "global_test" / cls)

    # Write Clients
    for client_name, splits in client_splits.items():
        print(f"Creating {client_name}...")
        for cls in ["NORMAL", "PNEUMONIA"]:
            # Further split into train/val (80/20) for local training
            cls_imgs = splits[cls]
            val_count = int(len(cls_imgs) * 0.2)
            val_imgs = cls_imgs[:val_count]
            train_imgs = cls_imgs[val_count:]

            copy_files(train_imgs, output_dir / client_name / "train" / cls)
            copy_files(val_imgs, output_dir / client_name / "val" / cls)
            
            print(f"  {client_name} - {cls}: {len(train_imgs)} train, {len(val_imgs)} val")

    print("\n✅ Dataset splitting complete! Old dataset replaced with Pneumonia Non-IID dataset.")

if __name__ == "__main__":
    main()
