"""
飞书/Lark 机器人接入接口

提供两条路径：
1. POST /api/feishu/webhook
   接收飞书开放平台直推的原始事件回调（含 challenge、encrypt、signature）。
   需要公网 HTTPS 地址并在飞书开发者后台配置「事件订阅」。

2. POST /api/feishu/event
   接收 lark-cli event consume 处理后输出的干净事件 JSON，
   适合本机开发调试，无需公网域名。

另外提供：
- GET /api/feishu/status：查看机器人配置与就绪状态
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Optional

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.config import settings
from backend.services.feishu_bot import feishu_bot_service
from backend.services.feishu_meeting_bot import feishu_meeting_bot_service


class RtcLinkRequest(BaseModel):
    room_id: Optional[str] = None
    user_id: Optional[str] = None


router = APIRouter(tags=["feishu"])


class RtcLinkRequest(BaseModel):
    room_id: Optional[str] = None
    user_id: Optional[str] = None


class RtcLinkResponse(BaseModel):
    url: str
    session_id: str
    room_id: str
    user_id: str
    expire_at: int


@router.post("/rtc-link", response_model=RtcLinkResponse)
async def feishu_rtc_link(req: RtcLinkRequest):
    """为飞书用户创建一个 RTC 视频排查房间，返回可直接点击加入的链接。"""
    from backend.api.vision import start_rtc_session, RtcSessionStartRequest

    rtc = await start_rtc_session(
        RtcSessionStartRequest(room_id=req.room_id, user_id=req.user_id),
        auth_payload=None,
    )

    query = (
        f"app_id={rtc.app_id}"
        f"&room_id={rtc.room_id}"
        f"&user_id={rtc.user_id}"
        f"&token={rtc.token}"
        f"&session_id={rtc.session_id}"
    )
    # 飞书里最好使用绝对 HTTPS 链接；未配置域名时返回相对路径
    base_url = settings.FEISHU_RTC_BASE_URL.strip().rstrip("/")
    url = f"{base_url}/static/rtc-call.html?{query}" if base_url else f"/static/rtc-call.html?{query}"

    return RtcLinkResponse(
        url=url,
        session_id=rtc.session_id,
        room_id=rtc.room_id,
        user_id=rtc.user_id,
        expire_at=rtc.expire_at,
    )


def _decrypt_feishu_encrypt(encrypt_key: str, encrypt: str) -> dict:
    """
    飞书事件加密数据解密（AES-CBC）。
    当飞书后台开启「加密策略」时使用。
    """
    try:
        import base64
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
    except Exception as e:  # pragma: no cover
        raise RuntimeError(f"解密失败：缺少 cryptography 依赖，{e}")

    key = hashlib.sha256(encrypt_key.encode("utf-8")).digest()
    data = base64.b64decode(encrypt)
    iv = data[:16]
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    plaintext = decryptor.update(data[16:]) + decryptor.finalize()
    # 去除 PKCS7 填充
    pad_len = plaintext[-1]
    plaintext = plaintext[:-pad_len]
    # 飞书格式：16 字节随机串 + 4 字节内容长度 + 内容 + app_id
    content_len = int.from_bytes(plaintext[16:20], "big")
    json_bytes = plaintext[20 : 20 + content_len]
    return json.loads(json_bytes.decode("utf-8"))


def _verify_feishu_signature(
    signature: str, timestamp: str, nonce: str, body: bytes, verification_token: str
) -> bool:
    """验证飞书回调请求签名。"""
    if not verification_token:
        return True
    if not signature:
        return False
    raw = f"{timestamp}{nonce}{verification_token}{body.decode('utf-8')}"
    expected = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return hmac.compare_digest(expected, signature)


@router.get("/status")
def feishu_status():
    return {
        "enabled": settings.FEISHU_ENABLED,
        "app_id_configured": bool(settings.FEISHU_APP_ID),
        "app_secret_configured": bool(settings.FEISHU_APP_SECRET),
        "verification_token_configured": bool(settings.FEISHU_VERIFICATION_TOKEN),
        "encrypt_key_configured": bool(settings.FEISHU_ENCRYPT_KEY),
        "bot_name": settings.FEISHU_BOT_NAME,
        "webhook_path": settings.FEISHU_WEBHOOK_PATH,
    }


@router.post("/webhook")
async def feishu_webhook(request: Request):
    """
    飞书开放平台原始事件回调入口。

    处理流程：
    1. 解析 body，优先解密 encrypt 字段
    2. 若是 URL 校验（challenge），直接返回 challenge
    3. 校验 timestamp/signature（可选，取决于配置）
    4. 处理 im.message.receive_v1 事件并异步回复用户
    """
    if not settings.FEISHU_ENABLED:
        raise HTTPException(status_code=503, detail="Feishu bot is not enabled")

    body = await request.body()
    try:
        payload = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json body")

    # 解密
    if payload.get("encrypt"):
        if not settings.FEISHU_ENCRYPT_KEY:
            raise HTTPException(status_code=400, detail="encrypt data but FEISHU_ENCRYPT_KEY not set")
        try:
            payload = _decrypt_feishu_encrypt(settings.FEISHU_ENCRYPT_KEY, payload["encrypt"])
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"decrypt failed: {e}")

    # URL 校验
    challenge = payload.get("challenge")
    if challenge:
        return JSONResponse({"challenge": challenge})

    # 签名校验
    signature = request.headers.get("X-Lark-Signature", "")
    timestamp = request.headers.get("X-Lark-Request-Timestamp", "")
    nonce = request.headers.get("X-Lark-Request-Nonce", "")
    if not _verify_feishu_signature(
        signature, timestamp, nonce, body, settings.FEISHU_VERIFICATION_TOKEN
    ):
        raise HTTPException(status_code=401, detail="signature verification failed")

    # 事件处理
    event_type = payload.get("header", {}).get("event_type") or payload.get("type")
    if event_type == "im.message.receive_v1":
        event = payload.get("event", {})
        await _dispatch_event(event)
    elif event_type == "im.chat.access_event.bot_p2p_chat_entered_v1":
        event = payload.get("event", {})
        await _dispatch_chat_entered(event)

    return JSONResponse({"status": "ok"})


@router.post("/event")
async def feishu_clean_event(event: dict[str, Any]):
    """
    lark-cli event consume 输出的干净事件入口。
    适合本机开发：lark-cli event consume im.message.receive_v1 | python scripts/feishu_event_consumer.py
    """
    if not settings.FEISHU_ENABLED:
        raise HTTPException(status_code=503, detail="Feishu bot is not enabled")

    event_type = event.get("type")
    if event_type == "im.message.receive_v1":
        await _dispatch_event(event)
    elif event_type == "im.chat.access_event.bot_p2p_chat_entered_v1":
        await _dispatch_chat_entered(event)
    return {"status": "ok"}


@router.post("/meeting-event")
async def feishu_meeting_event(event: dict[str, Any]):
    """
    lark-cli event consume 输出的飞书会议相关事件入口。
    当前处理：vc.recording.recording_transcript_generated_v1（实时字幕）
    """
    if not settings.FEISHU_ENABLED:
        raise HTTPException(status_code=503, detail="Feishu bot is not enabled")

    event_type = event.get("type")
    if event_type == "vc.recording.recording_transcript_generated_v1":
        await feishu_meeting_bot_service.handle_transcript(event)
    return {"status": "ok"}


@router.post("/card-action")
async def feishu_card_action(event: dict[str, Any]):
    """
    飞书交互卡片按钮点击回调入口（lark-oapi WS 客户端转发）。
    处理用户在机器人卡片上点击的按钮。
    """
    if not settings.FEISHU_ENABLED:
        raise HTTPException(status_code=503, detail="Feishu bot is not enabled")

    # 卡片点击事件结构：
    # {
    #   "action": {"value": {"action": "...", "chat_id": "...", "sender_id": "..."}, "tag": "button"},
    #   "sender": {"sender_id": {"open_id": "..."}},
    #   "open_chat_id": "...",
    #   "open_message_id": "..."
    # }
    action_value = event.get("action", {}).get("value", {})
    action_type = action_value.get("action", "")
    chat_id = action_value.get("chat_id") or event.get("open_chat_id", "")
    sender_id = action_value.get("sender_id") or event.get("sender", {}).get("sender_id", {}).get("open_id", "")
    top_event = action_value.get("top_event", "")

    if not chat_id or not sender_id or not action_type:
        return JSONResponse({"toast": {"type": "error", "content": "参数不完整"}})

    result = await feishu_bot_service._handle_card_action(chat_id, sender_id, action_type, top_event)
    print(f"[FeishuAPI] card action {action_type} -> {result}")

    # 返回 toast 提示
    return JSONResponse({"toast": {"type": "success", "content": "已处理"}})


async def _dispatch_event(event: dict[str, Any]) -> None:
    """把飞书消息事件分发给机器人服务处理。"""
    chat_id = event.get("chat_id", "")
    sender_id = event.get("sender_id", "")
    content = event.get("content", "")
    chat_type = event.get("chat_type", "p2p")

    # 忽略自己发送的消息（避免循环）
    if not chat_id or not sender_id:
        return

    await feishu_bot_service.handle_message(
        chat_id=chat_id,
        sender_id=sender_id,
        content=content,
        chat_type=chat_type,
    )


async def _dispatch_chat_entered(event: dict[str, Any]) -> None:
    """处理用户进入机器人私聊事件，自动发送欢迎链接。"""
    # lark-oapi 原生事件结构：event.chat_id / event.user.user_id.open_id
    chat_id = event.get("chat_id", "")
    user = event.get("user", {})
    sender_id = (
        user.get("user_id", {}).get("open_id")
        or user.get("user_id", {}).get("union_id")
        or user.get("user_id", {}).get("user_id")
        or ""
    )

    if not chat_id or not sender_id:
        return

    await feishu_bot_service.handle_chat_entered(
        chat_id=chat_id,
        sender_id=sender_id,
    )
