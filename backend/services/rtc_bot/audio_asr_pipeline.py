"""
从 Bot 读取用户音频，做 VAD 切分，调 ASR，识别结果送入 Orchestrator。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import uuid
import wave
from io import BytesIO
from typing import TYPE_CHECKING, Optional

import numpy as np

if TYPE_CHECKING:
    from backend.services.rtc_bot.bot_client import RtcBotClient
    from backend.services.rtc_bot.orchestrator import Orchestrator
    from backend.services.rtc_bot.tts_player import TtsPlayer

logger = logging.getLogger(__name__)


class AudioAsrPipeline:
    """
    音频 ASR 管道。

    以 20ms 为单位从 Bot 读取 PCM，累积到足够长度后做 ASR。
    简单实现：固定 1.5 秒窗口，检测到静音或窗口满则送 ASR。
    """

    def __init__(
        self,
        bot: "RtcBotClient",
        orchestrator: "Orchestrator",
        tts_player: Optional["TtsPlayer"] = None,
        sample_rate: int = 16000,
        channels: int = 1,
        frame_ms: int = 20,
        min_speech_ms: int = 500,
        silence_ms: int = 600,
        barge_in_speech_ms: int = 300,
    ):
        self.bot = bot
        self.orchestrator = orchestrator
        self.tts_player = tts_player
        self.sample_rate = sample_rate
        self.channels = channels
        self.frame_ms = frame_ms
        self.min_speech_ms = min_speech_ms
        self.silence_ms = silence_ms
        self.barge_in_speech_ms = barge_in_speech_ms

        self._buffer = bytearray()
        self._silence_count = 0
        self._speech_count = 0

    async def run(self, stop_event) -> None:
        frame_bytes = int(self.sample_rate * self.frame_ms / 1000) * self.channels * 2
        while not stop_event.is_set():
            pcm = await asyncio.to_thread(self.bot.pop_audio, frame_bytes)
            if not pcm:
                await asyncio.sleep(0.01)
                continue

            self._buffer.extend(pcm)
            rms = self._rms(pcm)
            is_speech = rms > 500  # 简单能量阈值，避免静音/噪声误触发

            tts_playing = self.tts_player is not None and self.tts_player.is_playing_now()

            if is_speech:
                self._speech_count += self.frame_ms
                self._silence_count = 0

                # Barge-in：用户在 AI 说话时插话，立即打断
                if tts_playing and self._speech_count >= self.barge_in_speech_ms:
                    logger.info("[ASR] Barge-in detected after %d ms speech", self._speech_count)
                    await self.orchestrator.on_user_barge_in()
                    # 丢弃可能包含 AI 回声的 buffer，重新监听用户语音
                    self._buffer.clear()
                    self._speech_count = 0
                    self._silence_count = 0
                    continue
            else:
                self._silence_count += self.frame_ms

            # AI 正在说话时若未触发打断，持续丢弃音频（避免把 AI 回声识别成用户语音）
            if tts_playing:
                if self._silence_count >= self.silence_ms:
                    self._buffer.clear()
                    self._speech_count = 0
                    self._silence_count = 0
                continue

            # 满足条件则送 ASR
            if (
                self._speech_count >= self.min_speech_ms
                and self._silence_count >= self.silence_ms
            ):
                await self._do_asr(bytes(self._buffer))
                self._buffer.clear()
                self._speech_count = 0
                self._silence_count = 0

            # 防止 buffer 无限增长
            if len(self._buffer) > self.sample_rate * self.channels * 2 * 10:  # 10s
                await self._do_asr(bytes(self._buffer))
                self._buffer.clear()
                self._speech_count = 0
                self._silence_count = 0

    def _rms(self, pcm: bytes) -> float:
        try:
            arr = np.frombuffer(pcm, dtype=np.int16)
            if len(arr) == 0:
                return 0.0
            return float(np.sqrt(np.mean(arr.astype(np.float64) ** 2)))
        except Exception:
            return 0.0

    async def _do_asr(self, pcm: bytes) -> None:
        if len(pcm) < self.sample_rate * self.channels * 2 * 0.3:  # 太短忽略
            return

        rms = self._rms(pcm)
        logger.info("[ASR] send %d bytes, sample_rate=%d, channels=%d, rms=%.1f", len(pcm), self.sample_rate, self.channels, rms)

        text = await _asr_pcm(pcm, self.sample_rate, self.channels)
        if text:
            await self.orchestrator.on_user_text(text)


async def _asr_pcm(pcm: bytes, sample_rate: int, channels: int) -> str:
    """调用 ASR 服务。"""
    from backend.config import settings

    provider = str(getattr(settings, "RTC_ASR_PROVIDER", "") or "baidu_vop").strip().lower()

    if provider == "baidu_vop":
        return await _baidu_vop_asr(pcm, sample_rate, channels)

    if provider == "openai":
        return await _openai_whisper_asr(pcm, sample_rate, channels)

    if provider == "volcengine":
        return await _volcengine_asr(pcm, sample_rate, channels)

    logger.warning("Unknown ASR provider: %s", provider)
    return ""


async def _volcengine_asr(pcm: bytes, sample_rate: int, channels: int) -> str:
    """火山引擎（豆包）大模型录音文件识别极速版（同步）。"""
    from backend.config import settings

    resource_id = str(getattr(settings, "VOLCENGINE_ASR_RESOURCE_ID", "volc.bigasr.auc_turbo") or "volc.bigasr.auc_turbo").strip()

    # 构造鉴权头，优先级：ASR 单 key > 全局单 key > ASR app/access > 全局 app/access
    req_id = str(uuid.uuid4()).replace("-", "")
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "X-Api-Request-Id": req_id,
        "X-Api-Resource-Id": resource_id,
    }
    api_key = str(getattr(settings, "VOLCENGINE_ASR_API_KEY", "") or getattr(settings, "VOLCENGINE_API_KEY", "") or "").strip()
    if api_key:
        headers["X-Api-Key"] = api_key
    else:
        app_id = str(getattr(settings, "VOLCENGINE_ASR_APP_ID", "") or getattr(settings, "VOLCENGINE_APP_ID", "") or "").strip()
        access_key = str(
            getattr(settings, "VOLCENGINE_ASR_ACCESS_KEY", "")
            or getattr(settings, "VOLCENGINE_ACCESS_KEY", "")
            or getattr(settings, "VOLCENGINE_ACCESS_TOKEN", "")
            or ""
        ).strip()
        if not app_id or not access_key:
            logger.warning("Volcano ASR credentials not configured")
            return ""
        headers["X-Api-App-Key"] = app_id
        headers["X-Api-Access-Key"] = access_key

    print(f"[*] Volcano ASR request: resource_id={resource_id}, api_key_prefix={api_key[:6] if api_key else '(none)'}, app_id={headers.get('X-Api-App-Key', '') or '(none)'}")

    try:
        import httpx

        # 将 PCM 封装为 WAV 再 base64，兼容性最好
        wav = BytesIO()
        with wave.open(wav, "wb") as f:
            f.setnchannels(channels)
            f.setsampwidth(2)
            f.setframerate(sample_rate)
            f.writeframes(pcm)
        wav_bytes = wav.getvalue()

        payload = {
            "user": {"uid": "faulttreeai"},
            "audio": {
                "format": "wav",
                "data": base64.b64encode(wav_bytes).decode("utf-8"),
            },
            "request": {
                "model_name": "bigmodel",
                "enable_itn": True,
                "enable_punc": True,
            },
        }

        url = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=payload)
            status_code = r.headers.get("X-Api-Status-Code") or r.headers.get("x-api-status-code")
            print(f"[*] Volcano ASR response status: http={r.status_code}, x-api-status={status_code}, body_len={len(r.text)}")
            if status_code and status_code != "20000000":
                logger.warning("Volcano ASR error: status=%s body=%s", status_code, r.text[:400])
                print(f"[WARN] Volcano ASR error: status={status_code}, body={r.text[:400]}")
                return ""
            data = r.json()
            text = (data.get("result") or {}).get("text") or ""
            print(f"[*] Volcano ASR result length: {len(text)}")
            if text:
                return str(text).strip()
            logger.warning("Volcano ASR empty result: %s", data)
            print(f"[WARN] Volcano ASR empty result: {data}")
    except Exception as exc:
        logger.exception("Volcano ASR failed: %s", exc)
        print(f"[ERROR] Volcano ASR failed: {exc}")
    return ""


async def _baidu_vop_asr(pcm: bytes, sample_rate: int, channels: int) -> str:
    """百度语音识别。"""
    from backend.config import settings

    api_key = getattr(settings, "BAIDU_VOP_API_KEY", "")
    secret_key = getattr(settings, "BAIDU_VOP_SECRET_KEY", "")
    if not api_key or not secret_key:
        logger.warning("Baidu VOP credentials not configured")
        return ""

    try:
        import httpx

        # 1. 获取 token
        token_url = (
            "https://aip.baidubce.com/oauth/2.0/token"
            f"?grant_type=client_credentials&client_id={api_key}&client_secret={secret_key}"
        )
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(token_url)
            r.raise_for_status()
            token = r.json().get("access_token", "")

            # 2. 构造 WAV
            wav = BytesIO()
            with wave.open(wav, "wb") as f:
                f.setnchannels(channels)
                f.setsampwidth(2)
                f.setframerate(sample_rate)
                f.writeframes(pcm)
            wav_bytes = wav.getvalue()

            # 3. 调用 ASR
            asr_url = f"https://vop.baidu.com/server_api?cuid=faulttreeai&token={token}"
            headers = {"Content-Type": "audio/wav; rate=16000"}
            r = await client.post(asr_url, content=wav_bytes, headers=headers)
            r.raise_for_status()
            data = r.json()
            if data.get("err_no") == 0:
                return " ".join(data.get("result", []))
            logger.warning("Baidu ASR error: %s", data)
    except Exception as exc:
        logger.exception("Baidu ASR failed: %s", exc)
    return ""


async def _openai_whisper_asr(pcm: bytes, sample_rate: int, channels: int) -> str:
    """OpenAI Whisper。"""
    from backend.config import settings

    api_key = getattr(settings, "OPENAI_API_KEY", "")
    base_url = getattr(settings, "OPENAI_BASE_URL", "https://api.openai.com/v1")
    if not api_key:
        logger.warning("OpenAI API key not configured")
        return ""

    try:
        import httpx

        wav = BytesIO()
        with wave.open(wav, "wb") as f:
            f.setnchannels(channels)
            f.setsampwidth(2)
            f.setframerate(sample_rate)
            f.writeframes(pcm)
        wav_bytes = wav.getvalue()

        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{base_url.rstrip('/')}/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": ("audio.wav", wav_bytes, "audio/wav")},
                data={"model": "whisper-1", "language": "zh"},
            )
            r.raise_for_status()
            return r.json().get("text", "")
    except Exception as exc:
        logger.exception("OpenAI Whisper ASR failed: %s", exc)
    return ""
