"""
RTC AI Bot Worker。

管理每个 RTC session 对应的独立 Bot 进程：
- session 创建时 spawn Bot 进程
- session 结束时 terminate/join
- 提供查询接口
"""
from __future__ import annotations

import logging
import multiprocessing as mp
import os
import signal
import sys
import time
from dataclasses import dataclass
from typing import Optional

from backend.config import settings

logger = logging.getLogger(__name__)


@dataclass
class BotProcessInfo:
    session_id: str
    process: mp.Process
    room_id: str
    ai_user_id: str
    created_at: float


class RtcAIBotWorker:
    """
    AI RTC Bot 管理器。

    每个 session 对应一个独立进程，进程内使用 bot_client 与 C++ SDK 交互。
    """

    def __init__(self) -> None:
        self._bots: dict[str, BotProcessInfo] = {}
        self._manager = mp.Manager()
        self._stop_events: dict[str, mp.Event] = {}

    def start_bot(
        self,
        session_id: str,
        token: str,
        room_id: str,
        ai_user_id: str,
    ) -> bool:
        if session_id in self._bots:
            logger.warning("Bot for session %s already exists", session_id)
            return False

        if not self._is_enabled():
            logger.info("RTC_BOT_ENABLED is false, skip spawning bot for %s", session_id)
            return False

        stop_event = self._manager.Event()
        self._stop_events[session_id] = stop_event

        so_path = self._so_path()
        app_id = str(getattr(settings, "RTC_APP_ID", "") or "")

        p = mp.Process(
            target=_bot_process_main,
            args=(session_id, app_id, token, room_id, ai_user_id, so_path, stop_event),
            daemon=True,
        )
        p.start()

        self._bots[session_id] = BotProcessInfo(
            session_id=session_id,
            process=p,
            room_id=room_id,
            ai_user_id=ai_user_id,
            created_at=time.time(),
        )
        logger.info("Started RTC bot process for session %s, pid=%s", session_id, p.pid)
        return True

    def stop_bot(self, session_id: str) -> bool:
        info = self._bots.pop(session_id, None)
        if not info:
            return False

        stop_event = self._stop_events.pop(session_id, None)
        if stop_event:
            stop_event.set()

        info.process.join(timeout=5.0)
        if info.process.is_alive():
            logger.warning("Force killing bot process for session %s", session_id)
            info.process.terminate()
            info.process.join(timeout=2.0)
            if info.process.is_alive():
                os.kill(info.process.pid, signal.SIGKILL)
                info.process.join(timeout=1.0)

        logger.info("Stopped RTC bot process for session %s", session_id)
        return True

    def get_bot_pid(self, session_id: str) -> Optional[int]:
        info = self._bots.get(session_id)
        return info.process.pid if info and info.process else None

    def list_sessions(self) -> list[str]:
        return list(self._bots.keys())

    def stop_all(self) -> None:
        for session_id in list(self._bots.keys()):
            self.stop_bot(session_id)

    @staticmethod
    def _is_enabled() -> bool:
        return bool(getattr(settings, "RTC_BOT_ENABLED", False))

    @staticmethod
    def _so_path() -> str:
        return str(getattr(settings, "RTC_BOT_SO_PATH", "") or "")


def _bot_process_main(
    session_id: str,
    app_id: str,
    token: str,
    room_id: str,
    ai_user_id: str,
    so_path: str,
    stop_event: mp.Event,
) -> None:
    """Bot 子进程入口。"""
    # 确保项目根目录在 sys.path，以便导入 backend 包
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, "..", "..", ".."))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

    # 子进程里重新配置日志
    logging.basicConfig(
        level=logging.INFO,
        format=f"[%(levelname)s] [bot:{session_id}] %(message)s",
    )
    log = logging.getLogger("rtc_bot_process")

    try:
        # 延迟导入，避免父进程初始化问题
        from backend.services.rtc_bot.bot_client import RtcBotClient
        from backend.services.rtc_bot.audio_asr_pipeline import AudioAsrPipeline
        from backend.services.rtc_bot.video_analyze_pipeline import VideoAnalyzePipeline
        from backend.services.rtc_bot.tts_player import TtsPlayer
        from backend.services.rtc_bot.orchestrator import Orchestrator
    except Exception as exc:
        log.exception("Failed to import bot modules: %s", exc)
        return

    bot: Optional[RtcBotClient] = None
    try:
        bot = RtcBotClient(app_id=app_id, so_path=so_path or None)
        log.info("Bot client created, version=%s", bot.version())

        ok = bot.join_room(token, room_id, ai_user_id)
        if not ok:
            log.error("Bot failed to join room %s", room_id)
            return
        log.info("Bot joined room %s as %s", room_id, ai_user_id)

        orchestrator = Orchestrator(session_id)
        tts_player = TtsPlayer(bot, orchestrator)
        audio_pipeline = AudioAsrPipeline(bot, orchestrator, tts_player)
        video_pipeline = VideoAnalyzePipeline(bot, orchestrator, session_id)

        # 启动各管道（在子进程内使用 asyncio）
        import asyncio

        async def run():
            await asyncio.gather(
                audio_pipeline.run(stop_event),
                video_pipeline.run(stop_event),
                tts_player.run(stop_event),
                _state_reporter(bot, stop_event, session_id),
            )

        asyncio.run(run())

    except Exception as exc:
        log.exception("Bot process error: %s", exc)
    finally:
        if bot:
            bot.leave_room()
            bot.close()
        log.info("Bot process exiting")


async def _state_reporter(bot, stop_event: mp.Event, session_id: str) -> None:
    """每隔几秒打印一次 Bot 状态。"""
    while not stop_event.is_set():
        try:
            state = bot.get_state()
            if state:
                logger.debug("Bot state %s: %s", session_id, state)
        except Exception:
            pass
        # 使用 asyncio.sleep 以便被取消
        import asyncio
        await asyncio.sleep(5)


async def _main() -> None:
    """独立运行 worker 的入口（调试用）。"""
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    worker = RtcAIBotWorker()
    try:
        while True:
            await __import__("asyncio").sleep(1)
    except KeyboardInterrupt:
        worker.stop_all()


if __name__ == "__main__":
    # 注意：main 模式下不要用 asyncio.run，因为 _main 已经是协程
    import asyncio
    asyncio.run(_main())
