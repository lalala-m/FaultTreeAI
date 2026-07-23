#!/usr/bin/env python3
"""
飞书会议实时字幕事件本地消费脚本

作用：启动 lark-cli event consume vc.recording.recording_transcript_generated_v1 --as user
      并把它输出的 NDJSON 事件转发到本机 backend 的 POST /api/feishu/meeting-event。

用法：
  1. 确保 backend 已启动
  2. 运行：python scripts/feishu_vc_event_consumer.py
  3. 在飞书会议中开启「妙记/字幕」，语音转写文本会实时推送到 backend 分析。

注意：
  - lark-cli 需要有 user identity 且已授予 vc:recording:read 权限
  - 会议需要开启录制/字幕才会产生事件
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

BACKEND_URL = os.environ.get(
    "FEISHU_VC_EVENT_TARGET",
    os.environ.get("FEISHU_EVENT_TARGET", "http://127.0.0.1:8000/api/feishu/meeting-event"),
)
LARK_CLI = os.environ.get("LARK_CLI", "lark-cli")


def forward_event(line: str) -> None:
    line = line.strip()
    if not line or not line.startswith("{"):
        return
    try:
        event = json.loads(line)
    except json.JSONDecodeError as e:
        # 可能是 lark-cli 返回的错误信息（如事件未订阅）
        print(f"[feishu-vc-consumer] skip invalid json: {e}", file=sys.stderr)
        print(f"[feishu-vc-consumer] raw: {line[:500]}", file=sys.stderr)
        return

    # lark-cli 错误响应
    if event.get("ok") is False:
        print(f"[feishu-vc-consumer] lark-cli error: {event}", file=sys.stderr)
        return

    event_type = event.get("type")
    if event_type != "vc.recording.recording_transcript_generated_v1":
        return

    try:
        resp = httpx.post(BACKEND_URL, json=event, timeout=60)
        print(f"[feishu-vc-consumer] forwarded {event.get('event_id')} -> {resp.status_code}")
        if resp.status_code >= 400:
            print(f"[feishu-vc-consumer] response: {resp.text[:500]}", file=sys.stderr)
    except Exception as e:
        print(f"[feishu-vc-consumer] forward error: {e}", file=sys.stderr)


def main() -> None:
    print(f"[feishu-vc-consumer] forwarding events to {BACKEND_URL}")
    print("[feishu-vc-consumer] starting lark-cli event consume vc.recording.recording_transcript_generated_v1 --as user")

    cmd = f'"{LARK_CLI}" event consume vc.recording.recording_transcript_generated_v1 --as user'
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
            if line.startswith("["):
                print(f"[lark-cli] {line}")
                continue
            if line.startswith("{"):
                forward_event(line)
                continue
            print(f"[lark-cli] {line}")
    except KeyboardInterrupt:
        print("\n[feishu-vc-consumer] interrupted, stopping lark-cli...")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
