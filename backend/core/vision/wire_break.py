import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np


@dataclass
class WireBreakResult:
    wire_mask: np.ndarray
    wire_bbox: Optional[Tuple[int, int, int, int]]
    break_bbox: Optional[Tuple[int, int, int, int]]
    is_broken: bool
    confidence: float
    process_time_ms: float


class WireBreakDetector:
    def __init__(self, device: str = "cpu"):
        self.device = (device or "cpu").strip().lower()
        self.model_path = self._resolve_model_path()

    def _resolve_model_path(self) -> Optional[str]:
        p = (os.environ.get("WIRE_BREAK_MODEL_PATH") or "").strip()
        if p:
            return p
        project_root = Path(__file__).resolve().parents[3]
        candidate = project_root / "data" / "models" / "wire_break_seg.pt"
        return str(candidate) if candidate.exists() else None

    def _simple_wire_mask(self, img_bgr: np.ndarray) -> np.ndarray:
        h, w = img_bgr.shape[:2]
        if h <= 0 or w <= 0:
            return np.zeros((0, 0), dtype=np.uint8)
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        mask = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            21,
            6,
        )
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
        mask = cv2.dilate(mask, kernel, iterations=1)
        try:
            mx = int(max(2, round(w * 0.06)))
            my = int(max(2, round(h * 0.06)))
            mask[:my, :] = 0
            mask[h - my :, :] = 0
            mask[:, :mx] = 0
            mask[:, w - mx :] = 0
        except Exception:
            pass
        frac = float((mask > 0).mean())
        if frac < 0.002 or frac > 0.25:
            return np.zeros((h, w), dtype=np.uint8)
        return mask

    def detect_break(self, img_bgr: np.ndarray, suppress_overlay: bool = False) -> WireBreakResult:
        t0 = time.time()
        h, w = img_bgr.shape[:2]
        mask = self._simple_wire_mask(img_bgr)
        wire_bbox = None
        break_bbox = None
        is_broken = False
        confidence = 0.15

        if mask.size > 0 and mask.any():
            try:
                n, _labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), connectivity=8)
                comps = []
                min_area = int(max(60, 0.0012 * (h * w)))
                mx = int(max(2, round(w * 0.06)))
                my = int(max(2, round(h * 0.06)))
                for i in range(1, int(n)):
                    area = int(stats[i, cv2.CC_STAT_AREA])
                    if area < min_area:
                        continue
                    x = int(stats[i, cv2.CC_STAT_LEFT])
                    y = int(stats[i, cv2.CC_STAT_TOP])
                    cw = int(stats[i, cv2.CC_STAT_WIDTH])
                    ch = int(stats[i, cv2.CC_STAT_HEIGHT])
                    x2 = x + cw
                    y2 = y + ch
                    if x <= mx or y <= my or x2 >= (w - mx) or y2 >= (h - my):
                        continue
                    comps.append((area, (x, y, x2, y2)))

                comps.sort(key=lambda x: x[0], reverse=True)
                if not comps:
                    raise RuntimeError("no components")

                union = [10**9, 10**9, -1, -1]
                picked = comps[: min(3, len(comps))]
                for _area, (x1, y1, x2, y2) in picked:
                    union[0] = min(union[0], x1)
                    union[1] = min(union[1], y1)
                    union[2] = max(union[2], x2)
                    union[3] = max(union[3], y2)
                x1, y1, x2, y2 = [int(v) for v in union]
                if x2 > x1 and y2 > y1:
                    wire_bbox = (x1, y1, x2, y2)

                if wire_bbox is not None:
                    ux1, uy1, ux2, uy2 = wire_bbox
                    bbox_area = float(max(1, (ux2 - ux1) * (uy2 - uy1)))
                    if bbox_area / float(h * w) <= 0.65:
                        crop = (mask[uy1:uy2, ux1:ux2] > 0).astype(np.uint8)
                        n2, _labels2, stats2, _ = cv2.connectedComponentsWithStats(crop, connectivity=8)
                        comps2 = []
                        min_area2 = int(max(40, 0.015 * bbox_area))
                        for j in range(1, int(n2)):
                            area2 = int(stats2[j, cv2.CC_STAT_AREA])
                            if area2 < min_area2:
                                continue
                            x = int(stats2[j, cv2.CC_STAT_LEFT])
                            y = int(stats2[j, cv2.CC_STAT_TOP])
                            cw = int(stats2[j, cv2.CC_STAT_WIDTH])
                            ch = int(stats2[j, cv2.CC_STAT_HEIGHT])
                            comps2.append((area2, (ux1 + x, uy1 + y, ux1 + x + cw, uy1 + y + ch)))
                        comps2.sort(key=lambda x: x[0], reverse=True)
                        if len(comps2) >= 2:
                            is_broken = True
                            break_bbox = comps2[1][1]

                if wire_bbox is not None:
                    fill = float((mask > 0).sum()) / float(max(1, h * w))
                    base = 0.35 if fill >= 0.003 else 0.2
                    if is_broken:
                        confidence = min(0.9, base + 0.25 + 0.05 * min(6, len(comps)))
                    else:
                        confidence = min(0.75, base + 0.15)
            except Exception:
                pass

        ms = (time.time() - t0) * 1000.0
        return WireBreakResult(
            wire_mask=mask,
            wire_bbox=wire_bbox,
            break_bbox=break_bbox,
            is_broken=is_broken,
            confidence=float(confidence),
            process_time_ms=float(ms),
        )


_instances: dict[str, WireBreakDetector] = {}


def get_wire_break_detector(device: str = "cpu") -> WireBreakDetector:
    key = (device or "cpu").strip().lower() or "cpu"
    inst = _instances.get(key)
    if inst is None:
        inst = WireBreakDetector(device=key)
        _instances[key] = inst
    return inst


def annotate_wire_break(img_bgr: np.ndarray, wr: WireBreakResult) -> np.ndarray:
    canvas = img_bgr.copy()
    h, w = canvas.shape[:2]

    # 不再绘制蓝色的 wire_mask，因为这个粗略的 mask 经常会包含背景噪点（蓝线）
    # if isinstance(wr.wire_mask, np.ndarray) and wr.wire_mask.shape[:2] == (h, w) and wr.wire_mask.any():
    #     overlay = canvas.copy()
    #     overlay[wr.wire_mask > 0] = (255, 0, 0)
    #     canvas = cv2.addWeighted(overlay, 0.35, canvas, 0.65, 0)

    if wr.wire_bbox is not None:
        x1, y1, x2, y2 = [int(v) for v in wr.wire_bbox]
        cv2.rectangle(canvas, (x1, y1), (x2, y2), (0, 255, 0), 2)

    if wr.is_broken and wr.break_bbox is not None:
        x1, y1, x2, y2 = [int(v) for v in wr.break_bbox]
        cv2.rectangle(canvas, (x1, y1), (x2, y2), (0, 0, 255), 2)

    return canvas
