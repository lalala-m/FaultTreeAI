"""
实时会话状态机

维护一个 RTC 会话在实时分析过程中的状态：
- 当前 AI 状态（idle / observing / analyzing / speaking）
- 最近画面检测结果
- 异常变化历史（用于去重和主动提醒）
- 用户语音/文字问题队列
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class RealtimeSessionState:
    session_id: str
    created_at: float = field(default_factory=time.time)
    ai_status: str = "idle"  # idle | observing | analyzing | speaking
    last_frame_at: float = 0.0
    last_analysis_at: float = 0.0
    last_alert_at: float = 0.0
    latest_detection: Optional[dict] = None
    latest_detections_window: list[dict] = field(default_factory=list)
    pending_question: Optional[str] = None
    pending_question_mode: str = "text"  # text | voice
    messages: list[dict] = field(default_factory=list)
    alert_cooldown_seconds: float = 10.0
    min_anomaly_frames_for_alert: int = 2

    def set_ai_status(self, status: str) -> None:
        self.ai_status = str(status or "idle").strip()

    def on_frame_received(self, timestamp: Optional[float] = None) -> None:
        self.last_frame_at = timestamp or time.time()

    def on_analysis_done(self, detection: dict, timestamp: Optional[float] = None) -> None:
        now = timestamp or time.time()
        self.last_analysis_at = now
        self.latest_detection = detection
        self.latest_detections_window.append(detection)
        # 保留最近 10 条检测结果用于去重
        self.latest_detections_window = self.latest_detections_window[-10:]

    def set_pending_question(self, text: str, mode: str = "text") -> None:
        self.pending_question = str(text or "").strip()
        self.pending_question_mode = str(mode or "text").strip()

    def clear_pending_question(self) -> None:
        self.pending_question = None
        self.pending_question_mode = "text"

    def append_message(self, role: str, content: str) -> None:
        self.messages.append(
            {
                "role": str(role or "assistant"),
                "content": str(content or "").strip(),
                "created_at": time.time(),
            }
        )
        self.messages = self.messages[-40:]

    def should_alert(self) -> bool:
        """
        判断是否应该主动提醒用户。
        条件：
        1. 最近窗口内连续出现 min_anomaly_frames_for_alert 次异常；
        2. 距离上次提醒超过 alert_cooldown_seconds；
        3. 最近一次异常与上一次提醒时的异常类型不完全相同（简单去重）。
        """
        now = time.time()
        if now - self.last_alert_at < self.alert_cooldown_seconds:
            return False

        if not self.latest_detections_window:
            return False

        recent = self.latest_detections_window[-self.min_anomaly_frames_for_alert :]
        if len(recent) < self.min_anomaly_frames_for_alert:
            return False

        for det in recent:
            anomaly_count = int(det.get("anomaly_count", 0) if isinstance(det, dict) else 0)
            overall_status = str(det.get("overall_status", "normal") if isinstance(det, dict) else "normal")
            if anomaly_count <= 0 and overall_status not in {"warning", "critical"}:
                return False

        # 获取最近一次异常类型集合
        current_classes = self._extract_anomaly_classes(self.latest_detections_window[-1])
        last_alert_classes = self._extract_anomaly_classes(self.latest_detection)

        # 如果异常类型没有变化，则不重复提醒
        if current_classes and current_classes == last_alert_classes:
            return False

        return True

    def mark_alerted(self) -> None:
        self.last_alert_at = time.time()

    def _extract_anomaly_classes(self, detection: Optional[dict]) -> set[str]:
        if not isinstance(detection, dict):
            return set()
        detections = detection.get("detections") or []
        classes = set()
        for item in detections:
            if not isinstance(item, dict):
                continue
            if item.get("is_anomaly"):
                classes.add(str(item.get("class_name", "")).strip().lower())
        return classes


class RealtimeSessionStateStore:
    """内存实时会话状态仓库（单例）"""

    def __init__(self) -> None:
        self._states: dict[str, RealtimeSessionState] = {}
        self._last_access: dict[str, float] = {}
        self._ttl_seconds: float = 3600.0  # 1 小时无活动自动清理
        self._max_sessions: int = 200      # 最大并发会话数

    def get_or_create(self, session_id: str) -> RealtimeSessionState:
        session_id = str(session_id or "").strip()
        if session_id not in self._states:
            self._cleanup_if_needed()
            self._states[session_id] = RealtimeSessionState(session_id=session_id)
        self._last_access[session_id] = time.time()
        return self._states[session_id]

    def get(self, session_id: str) -> Optional[RealtimeSessionState]:
        state = self._states.get(str(session_id or "").strip())
        if state is not None:
            self._last_access[session_id] = time.time()
        return state

    def remove(self, session_id: str) -> None:
        sid = str(session_id or "").strip()
        self._states.pop(sid, None)
        self._last_access.pop(sid, None)

    def _cleanup_if_needed(self) -> None:
        """按 TTL 清理过期会话，若仍超过上限则移除最老的会话。"""
        now = time.time()
        expired = [
            sid for sid, last in self._last_access.items()
            if now - last > self._ttl_seconds
        ]
        for sid in expired:
            self.remove(sid)

        if len(self._states) >= self._max_sessions:
            # 按最近访问时间排序，移除最老的 20%
            sorted_sids = sorted(
                self._last_access.keys(),
                key=lambda sid: self._last_access.get(sid, 0),
            )
            remove_count = max(1, len(sorted_sids) // 5)
            for sid in sorted_sids[:remove_count]:
                self.remove(sid)

    def get_stats(self) -> dict:
        return {
            "active_sessions": len(self._states),
            "max_sessions": self._max_sessions,
            "ttl_seconds": self._ttl_seconds,
        }

_store: Optional[RealtimeSessionStateStore] = None


def get_realtime_state_store() -> RealtimeSessionStateStore:
    global _store
    if _store is None:
        _store = RealtimeSessionStateStore()
    return _store
