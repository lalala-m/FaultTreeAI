"""
飞书会议诊断机器人

提供：
- 调用飞书 VC API 预约视频会议
- 接收会议实时字幕/转写事件
- 累积语音文本并触发故障诊断
- 将诊断结果发回会议群或用户私聊

注意：
- 预约会议需要 user_access_token，因此依赖 lark-cli 的用户身份
- 实时字幕事件 vc.recording.recording_transcript_generated_v1 也是 user 级别事件
"""

from __future__ import annotations

import json
import platform
import shlex
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from backend.config import settings
from backend.services.feishu_bot import feishu_bot_service


@dataclass
class MeetingSession:
    meeting_id: str
    reserve_id: str
    topic: str
    url: str
    meeting_no: str
    owner_id: str
    created_at: datetime = field(default_factory=datetime.now)
    transcript: list[dict] = field(default_factory=list)
    last_text: str = ""
    diagnosed: bool = False


class FeishuMeetingBotService:
    """飞书会议诊断服务"""

    def __init__(self):
        self._meetings: dict[str, MeetingSession] = {}

    def _run_lark_cli(self, args: list[str]) -> dict[str, Any]:
        """调用 lark-cli 并返回 JSON 结果。"""
        # Windows 下通过 cmd /c 调用，才能正确解析 npm 安装的 lark-cli.cmd
        # Windows 下通过 cmd /c 调用，才能正确解析 npm 安装的 lark-cli.cmd
        # Linux/macOS 下直接调用二进制
        is_windows = platform.system() == "Windows"
        if is_windows:
            cmd = ["cmd", "/c", "lark-cli"]
        else:
            cmd = ["lark-cli"]
        cmd = cmd + args + ["--as", "user", "--format", "json"]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding='utf-8',
                timeout=60,
            )
            output = result.stdout.strip() or result.stderr.strip()
            if not output:
                return {"ok": False, "error": "empty output"}
            data = json.loads(output)
            return data
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "lark-cli timeout"}
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"invalid json: {e}", "raw": output}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def reserve_meeting(self, owner_open_id: str, topic: str = "AI 故障诊断会议") -> dict[str, Any]:
        """预约一个飞书视频会议，返回会议链接。"""
        end_time = int((datetime.now() + timedelta(hours=1)).timestamp())
        body = {
            "end_time": str(end_time),
            "owner_id": owner_open_id,
            "meeting_settings": {
                "topic": topic,
                "meeting_initial_type": 1,
                "auto_record": True,
            },
        }
        result = self._run_lark_cli([
            "api", "POST", "/open-apis/vc/v1/reserves/apply",
            "--params", '{"user_id_type":"open_id"}',
            "--data", json.dumps(body, ensure_ascii=False),
        ])

        if not result.get("ok"):
            return result

        data = result.get("data", {})
        # 飞书预约会议接口返回结构：data.reserve
        reserve = data.get("reserve", {})
        reserve_id = reserve.get("id", "")
        meeting_id = reserve_id  # 预约会议没有独立的 meeting_id，先用 reserve_id
        url = reserve.get("url", "")
        meeting_no = reserve.get("meeting_no", "")

        if not meeting_id:
            return {"ok": False, "error": "meeting id not found in response", "raw": result}

        session = MeetingSession(
            meeting_id=meeting_id,
            reserve_id=reserve_id or "",
            topic=topic,
            url=url,
            meeting_no=meeting_no,
            owner_id=owner_open_id,
        )
        self._meetings[meeting_id] = session

        return {
            "ok": True,
            "meeting_id": meeting_id,
            "reserve_id": reserve_id,
            "url": url,
            "meeting_no": meeting_no,
        }

    async def handle_transcript(self, event: dict[str, Any]) -> None:
        """处理会议实时转写事件。"""
        transcript_items = event.get("transcript_items") or []
        unique_key = event.get("unique_key", "")
        if not transcript_items:
            return

        # 找到对应的 meeting（目前按 unique_key 或 meeting_id 匹配）
        meeting_id = unique_key  # 飞书文档说 unique_key 是一次 recording 会话唯一标识
        session = self._meetings.get(meeting_id)
        if not session:
            # 如果没有找到，先创建一个占位 session，便于累积文本
            session = MeetingSession(
                meeting_id=meeting_id,
                reserve_id="",
                topic="未知会议",
                url="",
                meeting_no="",
                owner_id="",
            )
            self._meetings[meeting_id] = session

        new_texts = []
        for item in transcript_items:
            text = str(item.get("text") or "").strip()
            if text and text not in [t.get("text") for t in session.transcript]:
                session.transcript.append(item)
                new_texts.append(text)

        if not new_texts:
            return

        full_text = " ".join([t.get("text", "") for t in session.transcript])
        # 简单去重：如果新增内容长度超过 30 且尚未诊断，则触发诊断
        if len(full_text) - len(session.last_text) > 30 and not session.diagnosed:
            await self._diagnose_and_reply(session, full_text)

    async def _diagnose_and_reply(self, session: MeetingSession, text: str) -> None:
        """根据转写文本进行故障诊断并回复。"""
        session.last_text = text
        try:
            from backend.api.generate import clarify_problem, generate_steps
            from backend.models.schemas import ClarifyRequest, StepsRequest

            # 先尝试直接做诊断（把完整转写当作 top_event）
            top_event = text[:200]
            clarify_resp = await clarify_problem(ClarifyRequest(top_event=top_event, rag_top_k=3, max_questions=3))
            questions = clarify_resp.questions

            # 如果转写文本已经比较长，直接生成排查步骤，不再追问
            if len(text) > 80:
                steps_resp = await generate_steps(
                    StepsRequest(top_event=top_event, user_prompt=text, rag_top_k=3)
                )
                summary = steps_resp.summary or "根据会议中的描述，建议按以下步骤排查："
                lines = [f"📹 {session.topic} 诊断结果：", "", f"📝 收集到的描述：{top_event}", "", summary]
                for s in steps_resp.steps[:5]:
                    lines.append(f"{s.step}. {s.title}：{s.action}")
                reply = "\n".join(lines)
                session.diagnosed = True
            else:
                # 文本还少，先追问澄清问题
                lines = ["根据目前听到的内容，我需要进一步确认："]
                for i, q in enumerate(questions, 1):
                    lines.append(f"{i}. {q.text}")
                lines.append("\n请继续在会议中语音回答，或文字回复到本对话。")
                reply = "\n".join(lines)

            # 发送到会议所有者私聊（如果没有 chat_id，则尝试发到 owner open_id）
            if session.owner_id:
                feishu_bot_service._send_text(
                    session.owner_id,
                    reply,
                    receive_id_type="open_id",
                )
        except Exception as e:
            print(f"[FeishuMeetingBot] diagnose error: {e}")


# 全局单例
feishu_meeting_bot_service = FeishuMeetingBotService()
