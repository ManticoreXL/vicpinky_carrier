#!/usr/bin/env python3
"""
OMX LeRobot v3.0 2채널(RGB 전용) 데이터셋 변환 컨버터
- 기존 수집된 3채널 원본(omx_dataset_depth_2)에서 Depth만 제외하고 파싱
- FrameTimestampError 방지 로직 (실제 MP4 타임스탬프 추출) 적용
"""

import json
import shutil
import math
import pandas as pd
import numpy as np
from pathlib import Path
import pyarrow as pa
import pyarrow.parquet as pq
from huggingface_hub import HfApi

# ── 설정 ───────────────────────────────────────────────────────────────────────
DATASET_DIR = Path("./omx616")    # 현재 수집된 원본 폴더
OUTPUT_DIR  = Path("./omx616_rgb") # 새롭게 만들어질 RGB 전용 폴더
REPO_ID     = "ttingji/omx616"         # ★ 2채널용 새로운 Repo ID 지정
TASK_DESC   = "Pick up object (RGB only)"
FPS         = 30
IMG_W       = 640
IMG_H       = 480
TOLERANCE_S = 0.04

def get_video_timestamps(video_path: Path, expected_n_frames: int) -> list[float]:
    path_str = str(video_path)
    try:
        from torchcodec.decoders import VideoDecoder
        decoder = VideoDecoder(path_str)
        ts_list = [float(decoder.get_frame_at(i).pts_seconds) for i in range(expected_n_frames)]
        return ts_list
    except Exception:
        pass

    try:
        import cv2
        cap = cv2.VideoCapture(path_str)
        ts_list = []
        while True:
            ret, _ = cap.read()
            if not ret: break
            ts_list.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0)
        cap.release()
        if len(ts_list) == expected_n_frames:
            return ts_list
    except Exception:
        pass

    print(f"  ⚠️  타임스탬프 추출 실패, i/FPS fallback 사용: {video_path.name}")
    return [float(i) / FPS for i in range(expected_n_frames)]

def compute_stats(data_array):
    """LeRobot stats.json 포맷(분위수 포함)으로 통계를 계산합니다."""
    arr = np.array(data_array, dtype=np.float32)
    return {
        "min": arr.min(axis=0).tolist(),
        "max": arr.max(axis=0).tolist(),
        "mean": arr.mean(axis=0).tolist(),
        "std": (arr.std(axis=0) + 1e-8).tolist(),
        "count": [len(arr)],
        "q01": np.percentile(arr, 1, axis=0).tolist(),
        "q10": np.percentile(arr, 10, axis=0).tolist(),
        "q50": np.percentile(arr, 50, axis=0).tolist(),
        "q90": np.percentile(arr, 90, axis=0).tolist(),
        "q99": np.percentile(arr, 99, axis=0).tolist(),
    }

def main():
    print(f"=== 데이터셋 변환 시작 ===")

    json_files = sorted((DATASET_DIR / "data").glob("episode_*.json"))
    if not json_files:
        print("❌ 변환할 로컬 아카이브 데이터 파일을 찾을 수 없습니다.")
        return

    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)

    (OUTPUT_DIR / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "meta" / "episodes" / "chunk-000").mkdir(parents=True, exist_ok=True)
    
    for cam in ["observation.images.front", "observation.images.wrist"]:
        (OUTPUT_DIR / "videos" / cam / "chunk-000").mkdir(parents=True, exist_ok=True)

    rows, ep_list, global_idx = [], [], 0

    for ep_file in json_files:
        print(f"🔄 처리 중: {ep_file.name} ...")
        with open(ep_file) as f: ep = json.load(f)

        ep_idx, frames = ep["episode_index"], ep["frames"]
        n_frames = len(frames)
        ep_str = f"episode_{ep_idx:06d}"

        # ★ 뎁스 제외: front와 wrist만 복사
        cams = ["observation.images.front", "observation.images.wrist"]
        for cam in cams:
            src = DATASET_DIR / "videos" / cam / f"{ep_str}.mp4"
            target_file = OUTPUT_DIR / "videos" / cam / "chunk-000" / f"file-{ep_idx:03d}.mp4"
            if src.exists(): shutil.copy2(src, target_file)

        front_mp4 = OUTPUT_DIR / "videos" / "observation.images.front" / "chunk-000" / f"file-{ep_idx:03d}.mp4"
        actual_timestamps = get_video_timestamps(front_mp4, n_frames)

        if len(actual_timestamps) != n_frames:
            min_len = min(len(actual_timestamps), n_frames)
            actual_timestamps = actual_timestamps[:min_len]
            frames = frames[:min_len]
            n_frames = min_len

        start_idx = global_idx
        for i, (frame, ts) in enumerate(zip(frames, actual_timestamps)):
            # ────────────────────────────────────────────────────────────
            # ★ 데이터 교정 로직: 순서 복원 및 Radian -> Degree 변환
            # 원본 데이터의 배열이 서로 바뀌어 기록되어 있으므로 교차 대입합니다.
            raw_obs = frame["action"]             # 잘못 들어간 위치 복구
            raw_act = frame["observation.state"]  # 잘못 들어간 위치 복구
            
            # 리스트 내포(List Comprehension)를 통한 디그리(Degree) 단위 변환
            obs_deg = [math.degrees(v) for v in raw_obs]
            act_deg = [math.degrees(v) for v in raw_act]
            # ────────────────────────────────────────────────────────────

            rows.append({
                "action":            act_deg,     # 교정된 데이터 사용
                "observation.state": obs_deg,     # 교정된 데이터 사용
                "timestamp":         ts,
                "frame_index":       i,
                "episode_index":     ep_idx,
                "index":             global_idx,
                "task_index":        0,
            })
            global_idx += 1

        ep_list.append({
            "episode_index": ep_idx, "task_index": 0, "length": n_frames,
            "dataset_from_index": start_idx, "dataset_to_index": global_idx,
            "data/chunk_index": 0, "data/file_index":  0,
            "videos/observation.images.front/chunk_index": 0,
            "videos/observation.images.front/file_index": ep_idx,
            "videos/observation.images.wrist/chunk_index": 0,
            "videos/observation.images.wrist/file_index": ep_idx,
            "videos/observation.images.front/from_timestamp": actual_timestamps[0],
            "videos/observation.images.front/to_timestamp":   actual_timestamps[-1],
            "videos/observation.images.wrist/from_timestamp": actual_timestamps[0],
            "videos/observation.images.wrist/to_timestamp":   actual_timestamps[-1],
        })

    print("\n💾 Parquet 패킹 중...")
    pq.write_table(pa.Table.from_pylist(rows), OUTPUT_DIR / "data" / "chunk-000" / "file-000.parquet")
    pq.write_table(pa.Table.from_pylist(ep_list), OUTPUT_DIR / "meta" / "episodes" / "chunk-000" / "file-000.parquet")
    pd.DataFrame({"task_index": [0], "task": [TASK_DESC]}).to_parquet(OUTPUT_DIR / "meta" / "tasks.parquet", index=False)

    info = {
        "codebase_version": "v3.0", "robot_type": "omx_follower", 
        "total_episodes": len(json_files), "total_frames": global_idx, 
        "fps": FPS, "tolerance_s": TOLERANCE_S,
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "data_path":  "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
        "features": {
            "action": {"dtype": "float32", "shape": [6], "names": ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]},
            "observation.state": {"dtype": "float32", "shape": [6], "names": ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]}, 
            "observation.images.front": {"dtype": "video", "shape": [IMG_H, IMG_W, 3], "names": ["height", "width", "channels"]},
            "observation.images.wrist": {"dtype": "video", "shape": [IMG_H, IMG_W, 3], "names": ["height", "width", "channels"]},
            "timestamp":     {"dtype": "float32", "shape": [1]},
            "frame_index":   {"dtype": "int64",   "shape": [1]},
            "episode_index": {"dtype": "int64",   "shape": [1]},
            "index":         {"dtype": "int64",   "shape": [1]},
            "task_index":    {"dtype": "int64",   "shape": [1]},
        }
    }
    with open(OUTPUT_DIR / "meta" / "info.json", "w") as f: json.dump(info, f, indent=2)

    # ★ stats.json 생성: LeRobot 공식 포맷(분위수 및 메타데이터 통계 포함)
    image_placeholder_stats = {
        "min": [[[0.0]], [[0.0]], [[0.0]]],
        "max": [[[1.0]], [[1.0]], [[1.0]]],
        "mean": [[[0.5]], [[0.5]], [[0.5]]],
        "std": [[[1.0]], [[1.0]], [[1.0]]],
        "count": [global_idx],
        "q01": [[[0.0]], [[0.0]], [[0.0]]],
        "q10": [[[0.1]], [[0.1]], [[0.1]]],
        "q50": [[[0.5]], [[0.5]], [[0.5]]],
        "q90": [[[0.9]], [[0.9]], [[0.9]]],
        "q99": [[[1.0]], [[1.0]], [[1.0]]]
    }

    stats = {
        "observation.state": compute_stats([r["observation.state"] for r in rows]),
        "action": compute_stats([r["action"] for r in rows]),
        "index": compute_stats([[r["index"]] for r in rows]),
        "frame_index": compute_stats([[r["frame_index"]] for r in rows]),
        "episode_index": compute_stats([[r["episode_index"]] for r in rows]),
        "timestamp": compute_stats([[r["timestamp"]] for r in rows]),
        "task_index": compute_stats([[r["task_index"]] for r in rows]),
        "observation.images.front": image_placeholder_stats,
        "observation.images.wrist": image_placeholder_stats,
    }

    with open(OUTPUT_DIR / "meta" / "stats.json", "w") as f: json.dump(stats, f, indent=2)

    print(f"\n🚀 HuggingFace Hub 업로드 시작: {REPO_ID}")
    api = HfApi()
    api.create_repo(repo_id=REPO_ID, repo_type="dataset", exist_ok=True)
    api.upload_folder(
        folder_path=str(OUTPUT_DIR), repo_id=REPO_ID, repo_type="dataset",
        commit_message="Convert to 2-channel RGB dataset with perfect timestamps"
    )
    print(f"✅ 업로드 완료: https://huggingface.co/datasets/{REPO_ID}")

if __name__ == "__main__":
    main()