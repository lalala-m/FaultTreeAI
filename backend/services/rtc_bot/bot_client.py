"""
BytePlus RTC Linux Bot 的 ctypes 客户端。
负责加载 librtc_bot.so 并暴露 Pythonic 接口。
"""
from __future__ import annotations

import ctypes
import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class RtcBotClient:
    """
    封装 librtc_bot.so 的 C API。
    """

    def __init__(self, app_id: str, work_dir: Optional[str] = None, so_path: Optional[str] = None):
        self.app_id = app_id
        self.work_dir = work_dir or os.getcwd()
        self.handle: Optional[ctypes.c_void_p] = None
        self._lib = self._load_so(so_path)
        self._create()

    def _load_so(self, so_path: Optional[str]) -> ctypes.CDLL:
        if so_path:
            path = Path(so_path)
        else:
            # 默认搜索路径
            candidates = [
                Path(__file__).resolve().parents[3] / "deploy" / "vm" / "rtc_bot" / "build" / "librtc_bot.so",
                Path("deploy/vm/rtc_bot/build/librtc_bot.so"),
                Path("/opt/rtc_bot/librtc_bot.so"),
            ]
            path = None
            for c in candidates:
                if c.exists():
                    path = c
                    break
            if path is None:
                raise FileNotFoundError(
                    f"librtc_bot.so not found. Tried: {[str(c) for c in candidates]}"
                )

        logger.info("Loading librtc_bot.so from %s", path)
        lib = ctypes.CDLL(str(path))

        # 声明函数签名
        lib.rtc_bot_create.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        lib.rtc_bot_create.restype = ctypes.c_void_p

        lib.rtc_bot_destroy.argtypes = [ctypes.c_void_p]
        lib.rtc_bot_destroy.restype = ctypes.c_int

        lib.rtc_bot_join_room.argtypes = [
            ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p
        ]
        lib.rtc_bot_join_room.restype = ctypes.c_int

        lib.rtc_bot_leave_room.argtypes = [ctypes.c_void_p]
        lib.rtc_bot_leave_room.restype = ctypes.c_int

        lib.rtc_bot_push_audio.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8),
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int
        ]
        lib.rtc_bot_push_audio.restype = ctypes.c_int

        lib.rtc_bot_pop_audio.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_int,
            ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int)
        ]
        lib.rtc_bot_pop_audio.restype = ctypes.c_int

        lib.rtc_bot_pop_video_frame.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_int,
            ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int64)
        ]
        lib.rtc_bot_pop_video_frame.restype = ctypes.c_int

        lib.rtc_bot_get_state.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        lib.rtc_bot_get_state.restype = ctypes.c_int

        lib.rtc_bot_version.restype = ctypes.c_char_p

        return lib

    def _create(self) -> None:
        handle = self._lib.rtc_bot_create(
            self.app_id.encode("utf-8"),
            self.work_dir.encode("utf-8"),
        )
        if not handle:
            raise RuntimeError("rtc_bot_create failed")
        self.handle = handle

    def join_room(self, token: str, room_id: str, user_id: str) -> bool:
        if not self.handle:
            return False
        ret = self._lib.rtc_bot_join_room(
            self.handle,
            token.encode("utf-8"),
            room_id.encode("utf-8"),
            user_id.encode("utf-8"),
        )
        return ret == 0

    def leave_room(self) -> bool:
        if not self.handle:
            return False
        ret = self._lib.rtc_bot_leave_room(self.handle)
        return ret == 0

    def push_audio(self, pcm_bytes: bytes, sample_rate: int = 16000,
                   channels: int = 1, bits_per_sample: int = 16) -> bool:
        if not self.handle or not pcm_bytes:
            return False
        buf = (ctypes.c_uint8 * len(pcm_bytes)).from_buffer_copy(pcm_bytes)
        ret = self._lib.rtc_bot_push_audio(
            self.handle, buf, len(pcm_bytes),
            sample_rate, channels, bits_per_sample
        )
        return ret == 0

    def pop_audio(self, buf_len: int = 640) -> Optional[bytes]:
        """
        读取用户音频 PCM。
        默认 640 字节 = 20ms @ 16kHz 16bit mono。
        """
        if not self.handle:
            return None
        buf = (ctypes.c_uint8 * buf_len)()
        sr = ctypes.c_int()
        ch = ctypes.c_int()
        bits = ctypes.c_int()
        ret = self._lib.rtc_bot_pop_audio(
            self.handle, buf, buf_len,
            ctypes.byref(sr), ctypes.byref(ch), ctypes.byref(bits)
        )
        if ret <= 0:
            return None
        return bytes(buf[:ret])

    def pop_video_frame(self, buf_len: int = 1920 * 1080 * 4) -> Optional[dict]:
        """读取一帧 RGBA 视频帧。"""
        if not self.handle:
            return None
        buf = (ctypes.c_uint8 * buf_len)()
        width = ctypes.c_int()
        height = ctypes.c_int()
        ts = ctypes.c_int64()
        ret = self._lib.rtc_bot_pop_video_frame(
            self.handle, buf, buf_len,
            ctypes.byref(width), ctypes.byref(height), ctypes.byref(ts)
        )
        if ret <= 0:
            return None
        return {
            "data": bytes(buf[:ret]),
            "width": width.value,
            "height": height.value,
            "timestamp_us": ts.value,
        }

    def get_state(self) -> dict:
        if not self.handle:
            return {}
        out = ctypes.create_string_buffer(1024)
        ret = self._lib.rtc_bot_get_state(self.handle, out, 1024)
        if ret <= 0:
            return {}
        try:
            return json.loads(out.value.decode("utf-8"))
        except Exception:
            return {"raw": out.value.decode("utf-8", errors="ignore")}

    def version(self) -> str:
        return (self._lib.rtc_bot_version() or b"").decode("utf-8")

    def close(self) -> None:
        if self.handle:
            self._lib.rtc_bot_destroy(self.handle)
            self.handle = None

    def __enter__(self) -> "RtcBotClient":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()
