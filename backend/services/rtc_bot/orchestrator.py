"""
RTC Bot 的中央协调器。

负责：
- 接收 ASR 文本、视觉分析结果
- 调度 LLM 生成回复
- 触发 TTS 播放
- 管理打断/排队策略
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from backend.config import settings

logger = logging.getLogger(__name__)


@dataclass
class PendingTask:
    kind: str  # "asr" | "visual"
    text: str = ""
    image_base64: Optional[str] = None


@dataclass
class OrchestratorContext:
    session_id: str
    messages: list[dict] = field(default_factory=list)
    latest_visual_result: Optional[dict] = None
    speaking: bool = False
    pending: deque[PendingTask] = field(default_factory=deque)


class Orchestrator:
    """
    每个 Bot 进程内一个 Orchestrator 实例。
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.ctx = OrchestratorContext(session_id=session_id)
        self._tts_callback: Optional[Callable[[str], None]] = None
        self._tts_player: Optional[Any] = None
        self._lock = asyncio.Lock()

        welcome = str(getattr(settings, "RTC_AI_WELCOME_MESSAGE", "") or "").strip()
        if welcome:
            self.ctx.messages.append({"role": "assistant", "content": welcome})

    def register_tts_callback(self, cb: Callable[[str], None]) -> None:
        self._tts_callback = cb

    def register_tts_player(self, player: Any) -> None:
        """注册 TtsPlayer 实例，用于用户打断时停止播放。"""
        self._tts_player = player

    async def on_user_text(self, text: str) -> None:
        """ASR 识别到用户语音。"""
        if not text or not text.strip():
            return
        text = text.strip()
        logger.info("[session=%s] ASR: %s", self.session_id, text)

        async with self._lock:
            self.ctx.messages.append({"role": "user", "content": text})
            self.ctx.pending.append(PendingTask(kind="asr", text=text))
            await self._drain_locked()

    async def on_user_barge_in(self, text: str = "") -> None:
        """用户在 AI 说话时插话，打断当前播放并优先处理新输入。"""
        async with self._lock:
            logger.info("[session=%s] Barge-in triggered", self.session_id)
            if self._tts_player is not None:
                self._tts_player.stop_current()
            self.ctx.pending.clear()
            self.ctx.speaking = False
            if text and text.strip():
                self.ctx.messages.append({"role": "user", "content": text.strip()})
                self.ctx.pending.append(PendingTask(kind="asr", text=text.strip()))
            await self._drain_locked()

    async def on_visual_result(self, result: dict) -> None:
        """视觉分析结果。"""
        logger.info("[session=%s] Visual result: %s", self.session_id, result)

        async with self._lock:
            self.ctx.latest_visual_result = result
            speak = result.get("payload", {}).get("speak", False)
            if not speak and not result.get("forced", False):
                return
            image_base64 = result.get("image_base64")
            text = result.get("payload", {}).get("content", "")
            self.ctx.pending.append(
                PendingTask(kind="visual", text=text, image_base64=image_base64)
            )
            await self._drain_locked()

    async def _drain_locked(self) -> None:
        """处理队列中的任务。"""
        if self.ctx.speaking:
            # 正在播放时，只保留最新任务
            while len(self.ctx.pending) > 1:
                self.ctx.pending.popleft()
            return

        if not self.ctx.pending:
            return

        task = self.ctx.pending.popleft()
        self.ctx.speaking = True

        try:
            reply = await self._generate_reply(task)
            if reply:
                self.ctx.messages.append({"role": "assistant", "content": reply})
                if self._tts_callback:
                    self._tts_callback(reply)
        except Exception as exc:
            logger.exception("Failed to generate/play reply: %s", exc)
        finally:
            self.ctx.speaking = False
            # 继续处理剩余任务
            asyncio.create_task(self._drain_with_lock())

    async def _drain_with_lock(self) -> None:
        async with self._lock:
            await self._drain_locked()

    async def _generate_reply(self, task: PendingTask) -> str:
        """调用后端 LLM 生成回复。"""
        try:
            from backend.core.llm.manager import get_llm_manager
        except Exception as exc:
            logger.exception("Cannot import llm manager: %s", exc)
            return "抱歉，我暂时无法处理，请稍后再试。"

        # 构建 prompt
        system_prompt = (
            "你是故障检修系统助手，正在通过视频通话帮助用户进行工业设备故障诊断。"
            "请用简洁、专业、口语化的中文回答。"
        )

        messages = [{"role": "system", "content": system_prompt}]
        # 保留最近 6 轮上下文
        for m in self.ctx.messages[-12:]:
            messages.append(m)

        user_content = task.text
        if task.kind == "visual" and self.ctx.latest_visual_result:
            det = self.ctx.latest_visual_result.get("payload", {}).get("detection_summary", "")
            if det:
                user_content = f"[画面检测到：{det}]\n{user_content}"

        messages.append({"role": "user", "content": user_content})

        try:
            manager = get_llm_manager()
            prompt = "\n".join(
                f"{'系统' if m['role'] == 'system' else ('助手' if m['role'] == 'assistant' else '用户')}: {m['content']}"
                for m in messages
            )
            response = await manager.generate_with_fallback(prompt)
            if isinstance(response, tuple):
                response = response[0]
            content = ""
            if hasattr(response, "content"):
                content = response.content
            elif isinstance(response, dict):
                content = response.get("content", "")
            elif isinstance(response, str):
                content = response
            return content.strip()
        except Exception as exc:
            logger.exception("LLM call failed: %s", exc)
            return "抱歉，我暂时没听清，你能再说一遍吗？"
