"""
接收 Orchestrator 的待播放文本，调用 TTS，将 PCM 推送到 Bot。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import queue
import uuid
from io import BytesIO
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from backend.services.rtc_bot.bot_client import RtcBotClient
    from backend.services.rtc_bot.orchestrator import Orchestrator

logger = logging.getLogger(__name__)


class TtsPlayer:
    """
    TTS 播放器。

    Orchestrator 通过回调将文本放入队列，本播放器调用 TTS 后按 20ms 切片推给 Bot。
    支持用户打断：调用 stop_current() 可立即停止当前播放并清空队列。
    """

    def __init__(
        self,
        bot: "RtcBotClient",
        orchestrator: "Orchestrator",
        sample_rate: int = 16000,
        channels: int = 1,
    ):
        self.bot = bot
        self.orchestrator = orchestrator
        self.sample_rate = sample_rate
        self.channels = channels
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self.is_playing = asyncio.Event()
        self._abort = asyncio.Event()
        orchestrator.register_tts_callback(self._on_text)
        orchestrator.register_tts_player(self)

    def is_playing_now(self) -> bool:
        return self.is_playing.is_set()

    def stop_current(self) -> None:
        """打断当前播放，清空待播放队列。"""
        self._abort.set()
        try:
            while not self._queue.empty():
                self._queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        self.is_playing.clear()

    def _on_text(self, text: str) -> None:
        # 回调可能来自其他协程，需要安全入队
        try:
            self._queue.put_nowait(text)
        except Exception as exc:
            logger.warning("TTS queue put failed: %s", exc)

    async def run(self, stop_event) -> None:
        while not stop_event.is_set():
            try:
                text = await asyncio.wait_for(
                    self._queue.get(), timeout=0.5
                )
                await self._play(text)
            except asyncio.TimeoutError:
                continue
            except Exception as exc:
                logger.exception("TTS player error: %s", exc)

    async def _play(self, text: str) -> None:
        self._abort.clear()
        self.is_playing.set()
        try:
            pcm = await _tts_text(text, self.sample_rate, self.channels)
            if not pcm:
                return

            logger.info("TTS generated %d bytes PCM for: %s", len(pcm), text[:40])

            # 按 20ms 切片推送
            frame_bytes = int(self.sample_rate * 20 / 1000) * self.channels * 2
            for offset in range(0, len(pcm), frame_bytes):
                if self._abort.is_set():
                    logger.info("TTS playback aborted by user")
                    break
                chunk = pcm[offset:offset + frame_bytes]
                # 补齐最后一帧
                if len(chunk) < frame_bytes:
                    chunk = chunk + b"\x00" * (frame_bytes - len(chunk))
                self.bot.push_audio(chunk, self.sample_rate, self.channels, 16)
                await asyncio.sleep(0.02)
        finally:
            self.is_playing.clear()


async def _tts_text(text: str, sample_rate: int, channels: int) -> bytes:
    """调用 TTS 服务，返回 16-bit PCM（主要用于 RTC Bot 推流）。"""
    audio_bytes, mime_type = await _tts_text_to_media(text, sample_rate, channels)
    if not audio_bytes:
        return b""
    if mime_type == "audio/mpeg":
        return _mp3_to_pcm(audio_bytes, sample_rate, channels)
    # PCM / WAV 等已接近目标格式，直接确保为 PCM
    return _ensure_pcm(audio_bytes, sample_rate, channels)


async def _tts_text_to_media(
    text: str, sample_rate: int, channels: int
) -> tuple[bytes, str]:
    """调用 TTS 服务，返回原始音频字节与 MIME 类型（用于 HTTP TTS 接口）。"""
    from backend.config import settings

    provider = str(getattr(settings, "RTC_TTS_PROVIDER", "") or "baidu_vop").strip().lower()

    if provider == "baidu_vop":
        pcm = await _baidu_vop_tts(text, sample_rate, channels)
        return pcm, "audio/wav" if pcm else ""

    if provider == "openai":
        mp3 = await _openai_tts(text, sample_rate, channels)
        return mp3, "audio/mpeg" if mp3 else ""

    if provider == "volcengine":
        return await _volcengine_tts_media(text, sample_rate, channels)

    logger.warning("Unknown TTS provider: %s", provider)
    return b"", ""


async def _baidu_vop_tts(text: str, sample_rate: int, channels: int) -> bytes:
    """百度语音合成。"""
    from backend.config import settings

    api_key = getattr(settings, "BAIDU_VOP_API_KEY", "")
    secret_key = getattr(settings, "BAIDU_VOP_SECRET_KEY", "")
    if not api_key or not secret_key:
        logger.warning("Baidu VOP credentials not configured")
        return b""

    try:
        import httpx

        token_url = (
            "https://aip.baidubce.com/oauth/2.0/token"
            f"?grant_type=client_credentials&client_id={api_key}&client_secret={secret_key}"
        )
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(token_url)
            r.raise_for_status()
            token = r.json().get("access_token", "")

            tts_url = "https://tsn.baidu.com/text2audio"
            payload = {
                "tex": text,
                "tok": token,
                "cuid": "faulttreeai",
                "ctp": "1",
                "lan": "zh",
                "spd": "5",
                "pit": "5",
                "vol": "5",
                "per": "0",
                "aue": "6",  # PCM 16k
            }
            r = await client.post(tts_url, data=payload)
            r.raise_for_status()
            content_type = r.headers.get("Content-Type", "")
            if "audio" in content_type:
                return _ensure_pcm(r.content, sample_rate, channels)
            logger.warning("Baidu TTS error: %s", r.text)
    except Exception as exc:
        logger.exception("Baidu TTS failed: %s", exc)
    return b""


async def _openai_tts(text: str, sample_rate: int, channels: int) -> bytes:
    """OpenAI TTS。"""
    from backend.config import settings

    api_key = getattr(settings, "OPENAI_API_KEY", "")
    base_url = getattr(settings, "OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = getattr(settings, "RTC_TTS_MODEL", "tts-1")
    voice = getattr(settings, "RTC_TTS_VOICE", "alloy")
    if not api_key:
        logger.warning("OpenAI API key not configured")
        return b""

    try:
        import httpx

        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                f"{base_url.rstrip('/')}/audio/speech",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "voice": voice, "input": text, "response_format": "mp3"},
            )
            r.raise_for_status()
            return _mp3_to_pcm(r.content, sample_rate, channels)
    except Exception as exc:
        logger.exception("OpenAI TTS failed: %s", exc)
    return b""


def _infer_volcengine_resource_id(speaker: str) -> str:
    """根据音色 ID 推断火山引擎 v3 TTS 所需 Resource-Id。"""
    speaker = str(speaker or "").strip().lower()
    if speaker.startswith("s_"):
        return "seed-icl-2.0"
    if "_uranus_" in speaker or speaker.startswith("saturn_"):
        return "seed-tts-2.0"
    # moon_bigtts / mars_bigtts / ICL_* 等官方 1.0 音色
    return "seed-tts-1.0"


async def _volcengine_tts_media(text: str, sample_rate: int, channels: int) -> tuple[bytes, str]:
    """火山引擎（豆包）语音合成 v3（单向 HTTP），返回原始 MP3 音频与 MIME 类型。"""
    from backend.config import settings

    text = str(text or "").strip()
    if not text:
        return b"", ""

    speaker = str(
        getattr(settings, "VOLCENGINE_TTS_SPEAKER", "")
        or getattr(settings, "VOLCENGINE_TTS_VOICE_TYPE", "")
        or "zh_female_wanqudashu_moon_bigtts"
    ).strip()
    # 按音色自动推断 resource_id；若用户显式配置且与推断不一致则告警并覆盖
    inferred_resource_id = _infer_volcengine_resource_id(speaker)
    resource_id = str(
        getattr(settings, "VOLCENGINE_TTS_RESOURCE_ID", "") or ""
    ).strip()
    if resource_id and resource_id != inferred_resource_id:
        logger.warning(
            "Volcano TTS configured resource_id %s does not match speaker %s, using inferred %s",
            resource_id, speaker, inferred_resource_id,
        )
        resource_id = inferred_resource_id
    if not resource_id:
        resource_id = inferred_resource_id
    emotion = str(getattr(settings, "VOLCENGINE_TTS_EMOTION", "") or "").strip()
    speed_ratio = float(getattr(settings, "VOLCENGINE_TTS_SPEED_RATIO", 1.0) or 1.0)
    tts_sample_rate = int(getattr(settings, "VOLCENGINE_TTS_SAMPLE_RATE", 24000) or 24000)

    # 构造鉴权头，优先级：TTS 单 key > 全局单 key > TTS app/access > 全局 app/access
    req_id = str(uuid.uuid4()).replace("-", "")
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "X-Api-Request-Id": req_id,
        "X-Api-Resource-Id": resource_id,
    }
    api_key = str(getattr(settings, "VOLCENGINE_TTS_API_KEY", "") or getattr(settings, "VOLCENGINE_API_KEY", "") or "").strip()
    if api_key:
        headers["X-Api-Key"] = api_key
    else:
        app_id = str(getattr(settings, "VOLCENGINE_TTS_APP_ID", "") or getattr(settings, "VOLCENGINE_APP_ID", "") or "").strip()
        access_key = str(
            getattr(settings, "VOLCENGINE_TTS_ACCESS_KEY", "")
            or getattr(settings, "VOLCENGINE_ACCESS_KEY", "")
            or getattr(settings, "VOLCENGINE_ACCESS_TOKEN", "")
            or ""
        ).strip()
        if not app_id or not access_key:
            logger.warning("Volcano TTS credentials not configured")
            return b"", ""
        headers["X-Api-App-Key"] = app_id
        headers["X-Api-Access-Key"] = access_key

    try:
        import httpx

        req_params: dict[str, Any] = {
            "text": text[:2048],
            "speaker": speaker,
            "audio_params": {
                "format": "mp3",
                "sample_rate": tts_sample_rate,
            },
        }
        if emotion:
            req_params["emotion"] = emotion
        if speed_ratio and speed_ratio != 1.0:
            req_params["speed_ratio"] = speed_ratio

        payload = {
            "user": {"uid": "faulttreeai"},
            "req_params": req_params,
        }

        url = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(url, headers=headers, json=payload)
            status_code = r.headers.get("X-Api-Status-Code") or r.headers.get("x-api-status-code")
            if status_code and status_code != "20000000":
                logger.warning("Volcano TTS error: status=%s body=%s", status_code, r.text[:400])
                return b"", ""
            # 解析拼接式 JSON：多个 JSON 对象连续排列，没有换行分隔
            audio_bytes = _parse_volcengine_tts_chunks(r.text)
            if not audio_bytes:
                logger.warning("Volcano TTS returned no audio")
                return b"", ""
            return audio_bytes, "audio/mpeg"
    except Exception as exc:
        logger.exception("Volcano TTS failed: %s", exc)
    return b"", ""


async def _volcengine_tts(text: str, sample_rate: int, channels: int) -> bytes:
    """火山引擎（豆包）语音合成，返回目标采样率 16-bit PCM（用于 RTC Bot）。"""
    audio_bytes, mime_type = await _volcengine_tts_media(text, sample_rate, channels)
    if not audio_bytes or mime_type != "audio/mpeg":
        return b""
    return _mp3_to_pcm(audio_bytes, sample_rate, channels)


def _parse_volcengine_tts_chunks(text: str) -> bytes:
    """解析豆包 TTS v3 返回的拼接 JSON，提取 base64 音频数据。"""
    import json

    chunks: list[bytes] = []
    decoder = json.JSONDecoder()
    i = 0
    n = len(text)
    while i < n:
        while i < n and text[i] in " \t\n\r":
            i += 1
        if i >= n:
            break
        try:
            obj, end = decoder.raw_decode(text, i)
            i = end
        except Exception:
            break
        data = obj.get("data") if isinstance(obj, dict) else None
        if isinstance(data, str) and data:
            try:
                chunks.append(base64.b64decode(data))
            except Exception:
                pass
    return b"".join(chunks)


def _resample_pcm_s16le(pcm: bytes, src_rate: int, dst_rate: int, channels: int) -> bytes:
    """用 numpy 线性插值重采样 16-bit PCM。"""
    try:
        import numpy as np

        if src_rate == dst_rate:
            return pcm
        arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float64)
        if channels > 1:
            arr = arr.reshape(-1, channels)
            src_len = arr.shape[0]
            dst_len = max(1, int(round(src_len * dst_rate / src_rate)))
            x = np.arange(src_len)
            x_new = np.linspace(0, src_len - 1, dst_len)
            out = np.zeros((dst_len, channels), dtype=np.float64)
            for c in range(channels):
                out[:, c] = np.interp(x_new, x, arr[:, c])
            return np.clip(out, -32768, 32767).astype(np.int16).tobytes()
        else:
            src_len = arr.shape[0]
            dst_len = max(1, int(round(src_len * dst_rate / src_rate)))
            x = np.arange(src_len)
            x_new = np.linspace(0, src_len - 1, dst_len)
            out = np.interp(x_new, x, arr)
            return np.clip(out, -32768, 32767).astype(np.int16).tobytes()
    except Exception as exc:
        logger.exception("PCM resampling failed: %s", exc)
    return pcm


def _ensure_pcm(data: bytes, sample_rate: int, channels: int) -> bytes:
    """若输入已是 PCM 则直接返回；否则尝试转换。"""
    # 豆包 v3 请求 pcm_s16le 返回的就是 16bit PCM
    return data


def _mp3_to_pcm(mp3_bytes: bytes, sample_rate: int, channels: int) -> bytes:
    """将 MP3 转换为 16-bit PCM。"""
    try:
        from pydub import AudioSegment

        audio = AudioSegment.from_mp3(BytesIO(mp3_bytes))
        audio = audio.set_frame_rate(sample_rate).set_channels(channels)
        return audio.raw_data
    except Exception as exc:
        logger.exception("MP3 to PCM failed: %s", exc)
    return b""
