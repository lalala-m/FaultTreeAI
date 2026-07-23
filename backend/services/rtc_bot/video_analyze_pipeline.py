"""
从 Bot 读取视频帧，周期性调用 frame_analyzer 做视觉分析。
"""
from __future__ import annotations

import asyncio
import base64
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.services.rtc_bot.bot_client import RtcBotClient
    from backend.services.rtc_bot.orchestrator import Orchestrator

logger = logging.getLogger(__name__)


class VideoAnalyzePipeline:
    """
    视频分析管道。

    每 REALTIME_FRAME_INTERVAL_MS 取一帧，调用 frame_analyzer。
    """

    def __init__(
        self,
        bot: "RtcBotClient",
        orchestrator: "Orchestrator",
        session_id: str,
        interval_ms: int = 2000,
    ):
        self.bot = bot
        self.orchestrator = orchestrator
        self.session_id = session_id
        self.interval_ms = interval_ms

    async def run(self, stop_event) -> None:
        from backend.core.realtime.session_state import get_realtime_state_store

        state_store = get_realtime_state_store()

        while not stop_event.is_set():
            try:
                frame = await asyncio.to_thread(self.bot.pop_video_frame)
                if frame:
                    await self._analyze(frame, state_store)
            except Exception as exc:
                logger.exception("Video analyze pipeline error: %s", exc)

            # 使用 asyncio.sleep，便于被 stop_event 中断
            for _ in range(int(self.interval_ms / 100)):
                if stop_event.is_set():
                    break
                await asyncio.sleep(0.1)

    async def _analyze(self, frame: dict, state_store) -> None:
        try:
            from backend.core.realtime.frame_analyzer import analyze_frame_for_session
            from PIL import Image
            from io import BytesIO

            width = frame.get("width", 0)
            height = frame.get("height", 0)
            data = frame.get("data", b"")

            if width <= 0 or height <= 0 or len(data) < width * height * 4:
                logger.warning("Invalid video frame: %dx%d, data_len=%d", width, height, len(data))
                return

            # RGBA 原始字节转 PNG
            image = Image.frombytes("RGBA", (width, height), data)
            # 顺时针旋转 90 度（手机端摄像头通常是竖屏）
            image = image.transpose(Image.Transpose.ROTATE_270)
            buf = BytesIO()
            image.save(buf, format="PNG")
            png_bytes = buf.getvalue()

            image_base64 = base64.b64encode(png_bytes).decode("utf-8")
            data_url = f"data:image/png;base64,{image_base64}"

            state = state_store.get_or_create(self.session_id)
            result = await analyze_frame_for_session(
                session_id=self.session_id,
                image_data=data_url,
                state=state,
            )

            # 补充 image_base64 供 orchestrator 使用
            result["image_base64"] = data_url
            await self.orchestrator.on_visual_result(result)
        except Exception as exc:
            logger.exception("Frame analysis failed: %s", exc)
