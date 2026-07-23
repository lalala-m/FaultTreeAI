#!/usr/bin/env python3
"""
飞书事件本地消费脚本

作用：启动 lark-cli event consume 并把它输出的 NDJSON 事件转发到本机 backend 的
      POST /api/feishu/event 接口，实现本机无公网域名调试。

用法：
  1. 确保 backend 已启动：uvicorn backend.main:app --reload --port 8000
  2. 运行：python scripts/feishu_event_consumer.py
  3. 在飞书私聊/群聊@机器人发送消息，事件会经 lark-cli 转发到 backend 处理。

依赖：
  - lark-cli 已登录且有 bot identity
  - 飞书应用已开启「机器人」能力并订阅 im.message.receive_v1 事件
  - backend 的 .env 中 FEISHU_ENABLED=true 且 FEISHU_APP_ID/FEISHU_APP_SECRET 已配置
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

BACKEND_URL = os.environ.get("FEISHU_EVENT_TARGET", "http://127.0.0.1:8000/api/feishu/event")
LARK_CLI = os.environ.get("LARK_CLI", "lark-cli")


def forward_event(line: str) -> None:
    line = line.strip()
    if not line or not line.startswith("{"):
        return
    try:
        event = json.loads(line)
    except json.JSONDecodeError as e:
        print(f"[feishu-consumer] skip invalid json: {e}", file=sys.stderr)
        print(f"[feishu-consumer] raw: {line[:500]}", file=sys.stderr)
        return

    event_type = event.get("type")
    if event_type not in ("im.message.receive_v1", "im.chat.access_event.bot_p2p_chat_entered_v1"):
        return

    try:
        resp = httpx.post(BACKEND_URL, json=event, timeout=120)
        print(f"[feishu-consumer] forwarded {event.get('event_id')} ({event_type}) -> {resp.status_code}")
        if resp.status_code >= 400:
            print(f"[feishu-consumer] response: {resp.text[:500]}", file=sys.stderr)
    except Exception as e:
        print(f"[feishu-consumer] forward error: {e}", file=sys.stderr)


def main() -> None:
    print(f"[feishu-consumer] forwarding events to {BACKEND_URL}")
    print("[feishu-consumer] starting lark-cli event consume im.message.receive_v1 --as bot")

    cmd = f'"{LARK_CLI}" event consume im.message.receive_v1 --as bot'
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
        encoding="utf-8",
        shell=True,
    )

    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            # 打印 lark-cli 的日志行（以 [ 开头），方便调试
            if line.startswith("["):
                print(f"[lark-cli] {line}")
                continue
            # 以 { 开头但不是标准 NDJSON 的事件：尝试转发，失败时上面会打印 raw
            if line.startswith("{"):
                forward_event(line)
                continue
            # 其他未知输出也打印出来
            print(f"[lark-cli] {line}")
    except KeyboardInterrupt:
        print("\n[feishu-consumer] interrupted, stopping lark-cli...")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
