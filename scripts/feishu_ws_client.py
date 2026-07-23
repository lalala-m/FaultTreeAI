#!/usr/bin/env python3
"""
飞书原生事件 WebSocket 客户端（基于 lark-oapi）

作用：替代 lark-cli event consume，同时接收：
  - im.message.receive_v1（文字消息）
  - card.action.trigger（卡片按钮点击）

并把事件转发到本机 backend。

依赖：
  - lark-oapi>=1.4.0
  - backend 已启动
  - .env 中 FEISHU_ENABLED=true 且 FEISHU_APP_ID/FEISHU_APP_SECRET 已配置
"""

import os
import sys
from pathlib import Path

import httpx
from lark_oapi import LogLevel
from lark_oapi.core.json import JSON
from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
from lark_oapi.ws.client import Client as WSClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

BACKEND_URL = os.environ.get("FEISHU_BACKEND_URL", "http://127.0.0.1:8000")
IM_EVENT_TARGET = f"{BACKEND_URL}/api/feishu/event"
CARD_EVENT_TARGET = f"{BACKEND_URL}/api/feishu/card-action"
VC_EVENT_TARGET = f"{BACKEND_URL}/api/feishu/meeting-event"


def _load_env() -> dict:
    env_file = PROJECT_ROOT / ".env"
    env = {}
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = _load_env()
APP_ID = os.environ.get("FEISHU_APP_ID") or ENV.get("FEISHU_APP_ID", "")
APP_SECRET = os.environ.get("FEISHU_APP_SECRET") or ENV.get("FEISHU_APP_SECRET", "")
ENCRYPT_KEY = os.environ.get("FEISHU_ENCRYPT_KEY") or ENV.get("FEISHU_ENCRYPT_KEY", "")
VERIFICATION_TOKEN = os.environ.get("FEISHU_VERIFICATION_TOKEN") or ENV.get("FEISHU_VERIFICATION_TOKEN", "")


def _event_to_dict(event) -> dict:
    """把 lark-oapi 事件对象序列化为可转发给后端的 dict。"""
    raw = JSON.marshal(event)
    import json

    return json.loads(raw)


def _normalize_im_event(event) -> dict:
    """把 lark-oapi 的嵌套事件格式转成后端期望的扁平格式。"""
    data = _event_to_dict(event)
    ev = data.get("event", {})
    msg = ev.get("message", {})
    sender = ev.get("sender", {})
    sender_id_obj = sender.get("sender_id", {})
    # 优先使用 open_id， fallback 到 user_id / union_id
    sender_id = sender_id_obj.get("open_id") or sender_id_obj.get("user_id") or sender_id_obj.get("union_id") or ""
    return {
        "type": "im.message.receive_v1",
        "event_id": data.get("header", {}).get("event_id"),
        "chat_id": msg.get("chat_id", ""),
        "chat_type": msg.get("chat_type", "p2p"),
        "message_id": msg.get("message_id", ""),
        "message_type": msg.get("message_type", ""),
        "content": msg.get("content", ""),
        "sender_id": sender_id,
    }


def forward_im_event(event) -> None:
    payload = _normalize_im_event(event)
    try:
        resp = httpx.post(IM_EVENT_TARGET, json=payload, timeout=120)
        print(f"[ws-client] im forwarded -> {resp.status_code}")
        if resp.status_code >= 400:
            print(f"[ws-client] im response: {resp.text[:500]}", file=sys.stderr)
    except Exception as e:
        print(f"[ws-client] im forward error: {e}", file=sys.stderr)


def forward_card_event(event) -> dict:
    """卡片点击事件需要返回卡片响应对象。"""
    payload = _event_to_dict(event)
    try:
        resp = httpx.post(CARD_EVENT_TARGET, json=payload, timeout=120)
        print(f"[ws-client] card forwarded -> {resp.status_code}")
        if resp.status_code >= 400:
            print(f"[ws-client] card response: {resp.text[:500]}", file=sys.stderr)
            return {"toast": {"type": "error", "content": "处理失败"}}
        try:
            data = resp.json()
            return data or {"toast": {"type": "success", "content": "已处理"}}
        except Exception:
            return {"toast": {"type": "success", "content": "已处理"}}
    except Exception as e:
        print(f"[ws-client] card forward error: {e}", file=sys.stderr)
        return {"toast": {"type": "error", "content": "处理失败"}}


def forward_vc_event(event) -> None:
    """转发 VC 会议字幕等自定义事件。"""
    payload = _event_to_dict(event)
    # 补充 type 字段，方便后端识别
    if "type" not in payload:
        payload["type"] = "vc.recording.recording_transcript_generated_v1"
    try:
        resp = httpx.post(VC_EVENT_TARGET, json=payload, timeout=120)
        print(f"[ws-client] vc forwarded -> {resp.status_code}")
        if resp.status_code >= 400:
            print(f"[ws-client] vc response: {resp.text[:500]}", file=sys.stderr)
    except Exception as e:
        print(f"[ws-client] vc forward error: {e}", file=sys.stderr)


def _normalize_chat_entered_event(event) -> dict:
    """把 lark-oapi 的 bot_p2p_chat_entered 事件转成后端期望的扁平格式。"""
    data = _event_to_dict(event)
    ev = data.get("event", {})
    user = ev.get("user", {})
    user_id_obj = user.get("user_id", {})
    sender_id = user_id_obj.get("open_id") or user_id_obj.get("user_id") or user_id_obj.get("union_id") or ""
    return {
        "type": "im.chat.access_event.bot_p2p_chat_entered_v1",
        "event_id": data.get("header", {}).get("event_id"),
        "chat_id": ev.get("chat_id", ""),
        "user": {"user_id": user_id_obj},
        "sender_id": sender_id,
    }


def forward_chat_entered_event(event) -> None:
    """转发用户进入机器人私聊事件。"""
    payload = _normalize_chat_entered_event(event)
    try:
        resp = httpx.post(IM_EVENT_TARGET, json=payload, timeout=120)
        print(f"[ws-client] chat-entered forwarded -> {resp.status_code}")
        if resp.status_code >= 400:
            print(f"[ws-client] chat-entered response: {resp.text[:500]}", file=sys.stderr)
    except Exception as e:
        print(f"[ws-client] chat-entered forward error: {e}", file=sys.stderr)


def main() -> None:
    if not APP_ID or not APP_SECRET:
        print("[ws-client] 错误：未配置 FEISHU_APP_ID / FEISHU_APP_SECRET", file=sys.stderr)
        sys.exit(1)

    print(f"[ws-client] APP_ID: {APP_ID}")
    print(f"[ws-client] 转发目标: IM={IM_EVENT_TARGET}, CARD={CARD_EVENT_TARGET}")

    handler = (
        EventDispatcherHandler.builder(ENCRYPT_KEY, VERIFICATION_TOKEN, LogLevel.INFO)
        .register_p2_im_message_receive_v1(forward_im_event)
        .register_p2_card_action_trigger(forward_card_event)
        .register_p2_customized_event("vc.recording.recording_transcript_generated_v1", forward_vc_event)
        .register_p2_customized_event("im.chat.access_event.bot_p2p_chat_entered_v1", forward_chat_entered_event)
        .build()
    )

    client = WSClient(
        app_id=APP_ID,
        app_secret=APP_SECRET,
        event_handler=handler,
        log_level=LogLevel.INFO,
    )
    client.start()


if __name__ == "__main__":
    main()
