"""
实时 AI 通话 WebSocket 路由

协议：
- 连接：WS /api/realtime/ws/{session_id}
- 心跳：客户端发送 {"type": "ping"}，服务端回复 {"type": "pong"}
- 上传帧：{"type": "frame", "payload": {"image_base64": "...", "timestamp": ms}}
- 提问：{"type": "ask", "payload": {"text": "...", "mode": "voice|text"}}
- 服务端推送：{"type": "status"} / {"type": "result"} / {"type": "error"}
"""

from __future__ import annotations

import io
import json
import logging
import wave
from typing import Any, Optional

import numpy as np

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Request, Response

from backend.config import settings
from backend.core.rtc import get_rtc_session_manager
from backend.core.realtime import get_realtime_state_store, analyze_frame_for_session
from backend.core.realtime.session_state import RealtimeSessionState
from backend.services.rtc_bot.audio_asr_pipeline import _asr_pcm
from backend.services.rtc_bot.tts_player import _tts_text_to_media

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/realtime", tags=["realtime"])


def _get_missing_asr_config_hint() -> str:
    """检查当前 ASR Provider 的必要配置是否缺失，返回用户友好的提示。"""
    provider = str(getattr(settings, "RTC_ASR_PROVIDER", "") or "baidu_vop").strip().lower()

    if provider == "baidu_vop":
        if not getattr(settings, "BAIDU_VOP_API_KEY", ""):
            return "缺少 BAIDU_VOP_API_KEY"
        if not getattr(settings, "BAIDU_VOP_SECRET_KEY", ""):
            return "缺少 BAIDU_VOP_SECRET_KEY"

    elif provider == "openai":
        if not getattr(settings, "OPENAI_API_KEY", ""):
            return "缺少 OPENAI_API_KEY"

    elif provider == "volcengine":
        api_key = getattr(settings, "VOLCENGINE_API_KEY", "")
        app_id = getattr(settings, "VOLCENGINE_APP_ID", "")
        access_key = getattr(settings, "VOLCENGINE_ACCESS_KEY", "")
        if not api_key and not (app_id and access_key):
            return "缺少 VOLCENGINE_API_KEY（或 VOLCENGINE_APP_ID + VOLCENGINE_ACCESS_KEY）"

    return ""


async def _send_json(websocket: WebSocket, data: dict[str, Any]) -> None:
    try:
        await websocket.send_json(data)
    except Exception as exc:
        logger.debug("[Realtime] send_json failed: %s", exc)


async def _push_status(state: RealtimeSessionState, websocket: WebSocket) -> None:
    await _send_json(
        websocket,
        {
            "type": "status",
            "payload": {
                "ai_status": state.ai_status,
                "last_analysis_at": int(state.last_analysis_at * 1000) if state.last_analysis_at else 0,
                "last_frame_at": int(state.last_frame_at * 1000) if state.last_frame_at else 0,
                "pending_question": state.pending_question,
            },
        },
    )


@router.post("/transcribe")
async def realtime_transcribe(audio: UploadFile = File(...)):
    """
    接收前端上传的音频文件（优先 WAV 16kHz 单声道），调用配置的 ASR 服务返回文字。

    用于 Web Speech API 不支持的浏览器作为语音输入降级方案。
    """
    if not audio or not audio.filename:
        raise HTTPException(status_code=400, detail="缺少音频文件")

    try:
        raw = await audio.read()
    except Exception as exc:
        logger.warning("[Realtime] read audio failed: %s", exc)
        raise HTTPException(status_code=400, detail="读取音频失败") from exc

    if not raw:
        raise HTTPException(status_code=400, detail="音频文件为空")

    sample_rate = 16000
    channels = 1
    pcm = b""

    # 尝试按 WAV 解析
    try:
        with wave.open(io.BytesIO(raw), "rb") as wf:
            channels = wf.getnchannels()
            sample_rate = wf.getframerate()
            width = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())
            if width == 1:
                # 8bit -> 16bit
                pcm = (np.frombuffer(frames, dtype=np.uint8).astype(np.int16) - 128) * 256
                if hasattr(pcm, "tobytes"):
                    pcm = pcm.tobytes()
                else:
                    pcm = pcm.tostring()
            elif width == 2:
                pcm = frames
            elif width == 4:
                arr = np.frombuffer(frames, dtype=np.int32)
                pcm = (arr // 256).astype(np.int16)
                if hasattr(pcm, "tobytes"):
                    pcm = pcm.tobytes()
                else:
                    pcm = pcm.tostring()
            else:
                raise HTTPException(status_code=400, detail=f"不支持的采样位数: {width}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[Realtime] parse wav failed: %s", exc)
        raise HTTPException(status_code=400, detail="仅支持 WAV 格式音频") from exc

    if not pcm:
        raise HTTPException(status_code=400, detail="未能从音频中提取 PCM")

    try:
        text = await _asr_pcm(pcm, sample_rate, channels)
    except Exception as exc:
        logger.exception("[Realtime] ASR failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"ASR 调用失败: {exc}") from exc

    if not text:
        missing = _get_missing_asr_config_hint()
        if missing:
            raise HTTPException(status_code=503, detail=f"ASR 服务未配置: {missing}")
        raise HTTPException(status_code=503, detail="未能识别到语音，请重试或检查音频质量")

    return {"text": text}


@router.post("/tts")
async def realtime_tts(request: Request):
    """
    接收文本，调用配置的 TTS 服务返回 WAV 音频。

    用于不支持 Web Speech API 的浏览器（如飞书内置浏览器）作为语音播报降级方案。
    """
    try:
        body = await request.json()
    except Exception as exc:
        logger.warning("[Realtime] tts parse body failed: %s", exc)
        raise HTTPException(status_code=400, detail="请求体必须是 JSON") from exc

    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="缺少 text")

    # 限制长度，避免过长文本导致 TTS 耗时过长
    if len(text) > 1000:
        text = text[:1000]

    sample_rate = 16000
    channels = 1
    try:
        audio_bytes, mime_type = await _tts_text_to_media(text, sample_rate, channels)
    except Exception as exc:
        logger.exception("[Realtime] TTS failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"TTS 调用失败: {exc}") from exc

    if not audio_bytes:
        raise HTTPException(status_code=503, detail="TTS 服务未返回音频，请检查配置")

    if mime_type == "audio/mpeg":
        return Response(content=audio_bytes, media_type="audio/mpeg")

    wav_bytes = _pcm_to_wav(audio_bytes, sample_rate, channels)
    return Response(content=wav_bytes, media_type="audio/wav")


def _pcm_to_wav(pcm: bytes, sample_rate: int, channels: int) -> bytes:
    """将 16-bit PCM 数据打包成标准 WAV 格式。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


@router.websocket("/ws/{session_id}")
async def realtime_websocket(websocket: WebSocket, session_id: str):
    session_id = str(session_id or "").strip()
    session_manager = get_rtc_session_manager()
    session = session_manager.get_session(session_id)

    # 可选鉴权：如果会话不存在则拒绝；也可以允许创建新状态用于调试
    if not session:
        logger.warning("[Realtime] websocket rejected: session not found %s", session_id)
        await websocket.close(code=4004, reason="session not found")
        return

    state_store = get_realtime_state_store()
    state = state_store.get_or_create(session_id)

    await websocket.accept()
    session_manager.set_websocket(session_id, websocket)
    state.set_ai_status("observing")

    welcome = str(getattr(settings, "RTC_AI_WELCOME_MESSAGE", "") or "").strip()
    if welcome:
        await _send_json(
            websocket,
            {
                "type": "result",
                "payload": {
                    "content": welcome,
                    "overall_status": "normal",
                    "detection_count": 0,
                    "anomaly_count": 0,
                    "speak": True,
                    "session_id": session_id,
                    "source": "welcome",
                },
            },
        )

    await _push_status(state, websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            if not raw:
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _send_json(
                    websocket,
                    {"type": "error", "payload": {"content": "消息必须是 JSON"}},
                )
                continue

            msg_type = str(msg.get("type") or "").strip().lower()
            payload = msg.get("payload") or {}

            if msg_type == "ping":
                await _send_json(websocket, {"type": "pong", "payload": {"ts": payload.get("ts")}})
                continue

            if msg_type == "frame":
                image_data = str(payload.get("image_base64") or "").strip()
                if not image_data:
                    await _send_json(
                        websocket,
                        {"type": "error", "payload": {"content": "frame 缺少 image_base64"}},
                    )
                    continue

                # 如果用户有未处理问题，先回答用户问题；否则只做画面观察
                forced_prompt = None
                if state.pending_question:
                    forced_prompt = state.pending_question
                    state.clear_pending_question()

                state.on_frame_received()
                await _push_status(state, websocket)

                result = await analyze_frame_for_session(
                    session_id=session_id,
                    image_data=image_data,
                    state=state,
                    forced_prompt=forced_prompt,
                )
                await _send_json(websocket, result)

                # 如果回答完问题后还有新的待处理问题，继续处理下一帧
                if state.pending_question:
                    await _push_status(state, websocket)
                continue

            if msg_type == "ask":
                text = str(payload.get("text") or "").strip()
                mode = str(payload.get("mode") or "text").strip().lower()
                if not text:
                    await _send_json(
                        websocket,
                        {"type": "error", "payload": {"content": "ask 缺少 text"}},
                    )
                    continue

                state.set_pending_question(text, mode)
                state.append_message("user", text)
                session_manager.append_message(session_id, role="user", content=text)

                # 立即回复：已收到问题，将在下一帧画面到达后分析作答
                await _send_json(
                    websocket,
                    {
                        "type": "status",
                        "payload": {
                            "ai_status": "analyzing",
                            "hint": "已收到问题，正在观察画面并生成答复...",
                            "pending_question": text,
                        },
                    },
                )
                continue

            if msg_type == "status":
                await _push_status(state, websocket)
                continue

            # 未知类型
            await _send_json(
                websocket,
                {"type": "error", "payload": {"content": f"未知消息类型: {msg_type}"}},
            )

    except WebSocketDisconnect:
        logger.info("[Realtime] websocket disconnected: %s", session_id)
    except WebSocketDisconnect:
        logger.info("[Realtime] websocket disconnected: %s", session_id)
    except Exception as exc:
        logger.exception("[Realtime] websocket error: %s", exc)
    finally:
        state.set_ai_status("idle")
        session_manager.set_websocket(session_id, None)
        # 不立即删除状态，允许断线重连后保留上下文
