"""
实时帧分析调度器

负责：
1. 接收前端通过 WebSocket 上传的视频帧；
2. 调用视觉检测器（YOLO / 传统 CV）得到检测摘要；
3. 维护异常变化窗口，避免重复告警；
4. 结合用户问题、历史消息、检测摘要，调用 LLM 生成诊断回复；
5. 返回结构化的分析结果，供 realtime WebSocket 推送给前端。
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Any, Optional

from backend.config import settings
from backend.core.realtime.session_state import RealtimeSessionState
from backend.api.vision import (
    _run_detection_from_image_data,
    _summarize_detection,
    _generate_ai_reply,
    _extract_base64_from_data_url,
    DetectionResultResponse,
)


def _extract_pure_base64(image_data: str) -> str:
    raw = str(image_data or "").strip()
    if raw.startswith("data:") and "," in raw:
        return raw.split(",", 1)[1]
    return raw

logger = logging.getLogger(__name__)


class RealtimeFrameAnalyzer:
    """
    实时帧分析器。

    配置项（来自 settings）：
    - REALTIME_FRAME_MODEL_KEY: 默认检测模型，默认 "auto"
    - REALTIME_FRAME_CONF: 检测置信度阈值，默认 0.15
    - REALTIME_FRAME_DEVICE: 推理设备，默认 "cpu"
    - REALTIME_MIN_ANOMALY_FRAMES: 连续异常帧阈值，默认 2
    - REALTIME_ALERT_COOLDOWN_SECONDS: 主动提醒冷却时间，默认 10
    - REALTIME_ENABLE_LLM_ON_NORMAL: 正常画面是否也走 LLM，默认 False
    """

    def __init__(self) -> None:
        self.model_key = str(getattr(settings, "REALTIME_FRAME_MODEL_KEY", "") or "auto").strip() or "auto"
        self.conf_threshold = float(getattr(settings, "REALTIME_FRAME_CONF", 0.15) or 0.15)
        self.device = str(getattr(settings, "REALTIME_FRAME_DEVICE", "") or "cpu").strip() or "cpu"
        self.min_anomaly_frames = int(getattr(settings, "REALTIME_MIN_ANOMALY_FRAMES", 2) or 2)
        self.alert_cooldown_seconds = float(getattr(settings, "REALTIME_ALERT_COOLDOWN_SECONDS", 10) or 10)
        self.enable_llm_on_normal = bool(getattr(settings, "REALTIME_ENABLE_LLM_ON_NORMAL", False))

    async def analyze(
        self,
        *,
        session_id: str,
        image_data: str,
        state: RealtimeSessionState,
        forced_prompt: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        分析单帧画面。

        Args:
            session_id: RTC 会话 ID
            image_data: Base64 图片（支持 data URL 或纯 base64）
            state: 实时会话状态
            forced_prompt: 如果用户有明确问题，优先使用该问题；否则根据异常状态自动生成 prompt

        Returns:
            {
                "type": "result",
                "payload": {
                    "content": str,
                    "overall_status": str,
                    "detection_count": int,
                    "anomaly_count": int,
                    "speak": bool,
                    "session_id": str,
                    "source": str,
                    "provider": Optional[str],
                    "detection_summary": Optional[str],
                }
            }
        """
        t0 = time.perf_counter()
        state.set_ai_status("analyzing")

        # 快速路径：用户明确提问且配置了 VLM 时，跳过 YOLO 检测，直接让 VLM 看图回答
        if forced_prompt and self._vlm_configured():
            return await self._analyze_with_vlm(
                session_id=session_id,
                image_data=image_data,
                state=state,
                prompt=forced_prompt,
                t0=t0,
            )

        try:
            detection = _run_detection_from_image_data(
                image_data,
                conf_threshold=self.conf_threshold,
                device=self.device,
                model_key=self.model_key,
                suppress_overlay=True,
            )
        except Exception as exc:
            logger.warning("[Realtime] frame detection failed for session=%s: %s", session_id, exc)
            state.set_ai_status("observing")
            return self._error_result(session_id, f"画面分析失败：{exc}")

        detection_dict = detection.model_dump() if hasattr(detection, "model_dump") else dict(detection)
        state.on_analysis_done(detection_dict)

        detection_summary = _summarize_detection(detection)
        anomaly_count = int(detection.anomaly_count or 0)
        overall_status = str(detection.overall_status or "normal")
        has_anomaly = anomaly_count > 0 or overall_status in {"warning", "critical"}

        # 确定本次是否需要生成语音/文字回复
        speak = False
        prompt = forced_prompt

        if prompt:
            # 用户主动提问：一定回复
            speak = True
        elif has_anomaly and state.should_alert():
            # 连续异常且满足冷却：主动提醒
            prompt = "请基于当前画面检测结果，判断设备是否存在故障，并给出处理建议。"
            speak = True
            state.mark_alerted()
        elif self.enable_llm_on_normal:
            # 正常画面也做简要分析（可配置关闭以节省成本）
            prompt = "请简要总结当前画面中的设备状态。"
        else:
            # 无需回复，只更新状态
            state.set_ai_status("observing")
            return {
                "type": "status",
                "payload": {
                    "ai_status": "observing",
                    "overall_status": overall_status,
                    "anomaly_count": anomaly_count,
                    "detection_count": int(detection.total_detections or 0),
                    "last_analysis_at": int(time.time() * 1000),
                    "session_id": session_id,
                },
            }

        # 调用 LLM/VLM 生成回复
        image_base64_for_vlm = _extract_pure_base64(image_data) if image_data else None
        content, provider = await _generate_ai_reply(
            prompt=prompt,
            detection_summary=detection_summary,
            image_count=1,
            image_base64=image_base64_for_vlm,
        )

        state.append_message("user" if forced_prompt else "system", prompt)
        state.append_message("assistant", content)
        state.set_ai_status(speak and "speaking" or "observing")

        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        logger.info(
            "[Realtime] analyzed session=%s status=%s anomaly=%s speak=%s latency=%sms provider=%s",
            session_id, overall_status, anomaly_count, speak, latency_ms, provider,
        )

        return {
            "type": "result",
            "payload": {
                "content": content,
                "overall_status": overall_status,
                "detection_count": int(detection.total_detections or 0),
                "anomaly_count": anomaly_count,
                "speak": speak,
                "session_id": session_id,
                "source": "realtime-frame",
                "provider": provider,
                "detection_summary": detection_summary,
                "latency_ms": latency_ms,
            },
        }

    def _vlm_configured(self) -> bool:
        """检查是否配置了 VLM 服务商。"""
        vlm_provider = str(getattr(settings, "VLM_PROVIDER", "") or "").strip().lower()
        return bool(vlm_provider)

    async def _analyze_with_vlm(
        self,
        *,
        session_id: str,
        image_data: str,
        state: RealtimeSessionState,
        prompt: str,
        t0: float,
    ) -> dict[str, Any]:
        """VLM 快速路径：直接看图 + 问题生成回复，跳过 YOLO 检测。"""
        image_base64_for_vlm = _extract_pure_base64(image_data) if image_data else None

        try:
            content, provider = await _generate_ai_reply(
                prompt=prompt,
                detection_summary="",
                image_count=1,
                image_base64=image_base64_for_vlm,
            )
        except Exception as exc:
            logger.warning("[Realtime] VLM fast path failed for session=%s: %s", session_id, exc)
            state.set_ai_status("observing")
            return self._error_result(session_id, f"AI 分析失败：{exc}")

        state.append_message("user", prompt)
        state.append_message("assistant", content)
        state.set_ai_status("speaking")

        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        logger.info(
            "[Realtime] vlm-fast session=%s latency=%sms provider=%s",
            session_id, latency_ms, provider,
        )

        return {
            "type": "result",
            "payload": {
                "content": content,
                "overall_status": "normal",
                "detection_count": 0,
                "anomaly_count": 0,
                "speak": True,
                "session_id": session_id,
                "source": "realtime-vlm-fast",
                "provider": provider,
                "detection_summary": None,
                "latency_ms": latency_ms,
            },
        }

    def _error_result(self, session_id: str, message: str) -> dict[str, Any]:
        return {
            "type": "error",
            "payload": {
                "content": message,
                "session_id": session_id,
                "speak": False,
            },
        }


_analyzer: Optional[RealtimeFrameAnalyzer] = None


def get_frame_analyzer() -> RealtimeFrameAnalyzer:
    global _analyzer
    if _analyzer is None:
        _analyzer = RealtimeFrameAnalyzer()
    return _analyzer


async def analyze_frame_for_session(
    *,
    session_id: str,
    image_data: str,
    state: RealtimeSessionState,
    forced_prompt: Optional[str] = None,
) -> dict[str, Any]:
    """便捷函数：获取全局分析器并分析单帧。"""
    analyzer = get_frame_analyzer()
    return await analyzer.analyze(
        session_id=session_id,
        image_data=image_data,
        state=state,
        forced_prompt=forced_prompt,
    )
