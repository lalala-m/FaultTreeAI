from __future__ import annotations

import secrets
import threading
import time
from copy import deepcopy
from typing import Any, Optional


class RtcSessionManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, dict] = {}

    def create_session(
        self,
        *,
        room_id: str,
        user_id: str,
        ai_user_id: str,
        created_by: str,
        welcome_message: str,
    ) -> dict:
        now = int(time.time())
        session_id = f"rtc_{secrets.token_hex(8)}"
        session = {
            "session_id": session_id,
            "room_id": room_id,
            "user_id": user_id,
            "ai_user_id": ai_user_id,
            "created_by": created_by,
            "status": "ready",
            "ai_status": "idle",
            "created_at": now,
            "updated_at": now,
            "last_analysis_at": 0,
            "message_count": 1,
            "messages": [
                {
                    "role": "assistant",
                    "content": str(welcome_message or "").strip(),
                    "created_at": now,
                }
            ],
            "websocket": None,
            "latest_detection": None,
            "latest_frame_at": 0,
        }
        with self._lock:
            self._sessions[session_id] = session
        return deepcopy(session)

    def get_session(self, session_id: str) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            # WebSocket 对象不可 deepcopy，排除后深拷贝其余字段
            result = deepcopy({k: v for k, v in session.items() if k != "websocket"})
            return result

    def _safe_copy(self, session: dict) -> dict:
        """返回 session 深拷贝，排除不可序列化的 WebSocket 对象。"""
        return deepcopy({k: v for k, v in session.items() if k != "websocket"})

    def append_message(self, session_id: str, *, role: str, content: str) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            now = int(time.time())
            session["messages"].append(
                {
                    "role": str(role or "assistant"),
                    "content": str(content or "").strip(),
                    "created_at": now,
                }
            )
            session["messages"] = session["messages"][-80:]
            session["message_count"] = len(session["messages"])
            session["updated_at"] = now
            return self._safe_copy(session)

    def mark_analyzing(self, session_id: str) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            session["status"] = "analyzing"
            session["ai_status"] = "analyzing"
            session["updated_at"] = int(time.time())
            return self._safe_copy(session)

    def mark_ready(self, session_id: str) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            now = int(time.time())
            session["status"] = "ready"
            session["ai_status"] = "observing"
            session["last_analysis_at"] = now
            session["updated_at"] = now
            return self._safe_copy(session)

    def set_ai_status(self, session_id: str, ai_status: str) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            session["ai_status"] = str(ai_status or "idle").strip()
            session["updated_at"] = int(time.time())
            return self._safe_copy(session)

    def set_websocket(self, session_id: str, websocket: Any) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            session["websocket"] = websocket
            session["updated_at"] = int(time.time())
            return self._safe_copy(session)

    def update_latest_detection(self, session_id: str, detection: dict) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            session["latest_detection"] = detection
            session["updated_at"] = int(time.time())
            return self._safe_copy(session)

    def update_latest_frame(self, session_id: str, timestamp: int) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            session["latest_frame_at"] = timestamp
            session["updated_at"] = int(time.time())
            return self._safe_copy(session)

    def end_session(self, session_id: str) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(str(session_id or "").strip())
            if not session:
                return None
            session["status"] = "ended"
            session["ai_status"] = "offline"
            session["updated_at"] = int(time.time())
            return self._safe_copy(session)


_session_manager: Optional[RtcSessionManager] = None


def get_rtc_session_manager() -> RtcSessionManager:
    global _session_manager
    if _session_manager is None:
        _session_manager = RtcSessionManager()
    return _session_manager
