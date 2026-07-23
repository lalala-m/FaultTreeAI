"""
飞书/Lark 故障检索机器人核心逻辑

提供：
- 用户消息解析与会话状态管理
- 调用现有 clarify / generate / steps 服务生成故障分析
- 通过飞书机器人发送文本回复

状态说明（内存字典，按 sender_id 隔离）：
- idle: 等待用户描述故障
- awaiting_clarify: 已生成澄清问题，等待用户回答
- processing: 正在生成结果（避免重复提交）
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from backend.config import settings
from backend.models.schemas import ClarifyQuestion


@dataclass
class UserSession:
    sender_id: str
    stage: str = "idle"  # idle | awaiting_clarify | processing
    top_event: str = ""
    questions: list[ClarifyQuestion] = field(default_factory=list)
    answers: dict[str, str] = field(default_factory=dict)
    last_updated: datetime = field(default_factory=datetime.now)
    messages: list[dict] = field(default_factory=list)
    # 与 web 总览页对齐的可选配置
    doc_id: str = ""          # 指定知识来源文档
    provider: str = ""        # 指定 LLM Provider
    manual_weight: float = 0.5  # 文档权重(0.0~1.0)


class FeishuBotService:
    """飞书机器人服务：处理消息、维护会话、调用 故障检修系统 服务、回复用户。"""

    def __init__(self):
        self._sessions: dict[str, UserSession] = {}
        self._session_ttl_seconds: float = 3600.0  # 1 小时无活动自动清理
        self._enabled = settings.FEISHU_ENABLED and bool(settings.FEISHU_APP_ID) and bool(settings.FEISHU_APP_SECRET)

    # ---------- 会话管理 ----------

    def _cleanup_expired_sessions(self) -> None:
        """清理长时间未活动的飞书会话，防止内存无限增长。"""
        from datetime import datetime, timedelta
        cutoff = datetime.now() - timedelta(seconds=self._session_ttl_seconds)
        expired = [sid for sid, s in self._sessions.items() if s.last_updated < cutoff]
        for sid in expired:
            self._sessions.pop(sid, None)

    def _get_session(self, sender_id: str) -> UserSession:
        self._cleanup_expired_sessions()
        if sender_id not in self._sessions:
            self._sessions[sender_id] = UserSession(sender_id=sender_id)
        return self._sessions[sender_id]

    def _reset_session(self, sender_id: str) -> UserSession:
        self._sessions[sender_id] = UserSession(sender_id=sender_id)
        return self._sessions[sender_id]

    # ---------- 飞书消息发送 ----------

    def _send_text(self, receive_id: str, text: str, receive_id_type: str = "chat_id") -> dict:
        """调用飞书机器人发送文本消息。"""
        if not self._enabled:
            print(f"[FeishuBot] disabled, would send to {receive_id}: {text[:120]}...")
            return {"ok": False, "error": "bot not enabled"}

        try:
            import httpx

            # 1. 获取 tenant access token
            token_resp = httpx.post(
                "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": settings.FEISHU_APP_ID, "app_secret": settings.FEISHU_APP_SECRET},
                timeout=30,
            )
            token_data = token_resp.json()
            if token_data.get("code") != 0:
                return {"ok": False, "error": f"token error: {token_data}"}
            access_token = token_data["tenant_access_token"]

            # 2. 发送消息
            content = json.dumps({"text": text[: settings.FEISHU_REPLY_MAX_LENGTH]}, ensure_ascii=False)
            send_resp = httpx.post(
                f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={receive_id_type}",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"receive_id": receive_id, "msg_type": "text", "content": content},
                timeout=60,
            )
            send_data = send_resp.json()
            if send_data.get("code") == 0:
                return {"ok": True, "data": send_data.get("data")}
            return {"ok": False, "error": send_data.get("msg"), "code": send_data.get("code")}
        except Exception as e:
            print(f"[FeishuBot] send_text error: {e}")
            return {"ok": False, "error": str(e)}

    def _send_interactive_card(self, receive_id: str, card: dict, receive_id_type: str = "chat_id") -> dict:
        """调用飞书机器人发送交互卡片。"""
        if not self._enabled:
            print(f"[FeishuBot] disabled, would send card to {receive_id}")
            return {"ok": False, "error": "bot not enabled"}

        try:
            import httpx

            token_resp = httpx.post(
                "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": settings.FEISHU_APP_ID, "app_secret": settings.FEISHU_APP_SECRET},
                timeout=30,
            )
            token_data = token_resp.json()
            if token_data.get("code") != 0:
                return {"ok": False, "error": f"token error: {token_data}"}
            access_token = token_data["tenant_access_token"]

            content = json.dumps({"config": {"wide_screen_mode": True}, **card}, ensure_ascii=False)
            send_resp = httpx.post(
                f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={receive_id_type}",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"receive_id": receive_id, "msg_type": "interactive", "content": content},
                timeout=60,
            )
            send_data = send_resp.json()
            if send_data.get("code") == 0:
                return {"ok": True, "data": send_data.get("data")}
            return {"ok": False, "error": send_data.get("msg"), "code": send_data.get("code")}
        except Exception as e:
            print(f"[FeishuBot] send_interactive_card error: {e}")
            return {"ok": False, "error": str(e)}

    # ---------- 消息处理入口 ----------

    async def handle_message(self, chat_id: str, sender_id: str, content: str, chat_type: str = "p2p") -> str:
        """
        处理一条飞书消息。
        当前策略：非命令文字直接基于知识库做简单问答，并给出视频/会议/网页等进阶入口。
        """
        text = self._extract_text(content).strip()
        if not text:
            self._send_welcome(chat_id, sender_id)
            return "welcome_sent"

        session = self._get_session(sender_id)
        session.last_updated = datetime.now()
        session.top_event = text
        session.messages.append({"role": "user", "content": text})

        # 命令处理
        if text in ("重置", "重新开始", "clear", "reset"):
            self._reset_session(sender_id)
            self._send_welcome(chat_id, sender_id)
            return "reset"

        if text in ("帮助", "help", "?"):
            self._send_text(chat_id, self._help_text())
            return "help"

        # 快捷指令：直接打开特定网页功能
        if text in ("视频排查", "视频诊断", "视频通话", "rtc", "video"):
            return self._handle_web_diagnosis(chat_id, sender_id, session.top_event, tab="rtc")

        if text in ("会议诊断", "会议排查", "飞书会议", "meeting"):
            return await self._handle_meeting_diagnosis(chat_id, sender_id)

        if text in ("网页诊断", "网页交互诊断", "web", "website"):
            return self._handle_web_diagnosis(chat_id, sender_id, session.top_event, tab="vision")

        # 默认：直接基于知识库做简单问答
        return await self._simple_qa(chat_id, session, text)

    async def handle_chat_entered(self, chat_id: str, sender_id: str) -> str:
        """用户进入机器人私聊时自动发送欢迎链接。"""
        self._get_session(sender_id).last_updated = datetime.now()
        self._send_welcome(chat_id, sender_id)
        return "welcome_sent"

    # ---------- 内部处理流程 ----------

    async def _handle_meeting_diagnosis(self, chat_id: str, sender_id: str) -> str:
        """预约飞书视频会议并发送会议链接，后续通过实时字幕做诊断。"""
        try:
            from backend.services.feishu_meeting_bot import feishu_meeting_bot_service

            result = feishu_meeting_bot_service.reserve_meeting(
                owner_open_id=sender_id,
                topic="AI 故障诊断会议",
            )
            if not result.get("ok"):
                error = result.get("error") or "未知错误"
                self._send_text(chat_id, f"创建会议失败：{error}\n请确认机器人有视频会议权限。")
                return f"meeting_error: {error}"

            msg = (
                "📹 已为你预约 AI 故障诊断会议\n"
                f"会议主题：AI 故障诊断会议\n"
                f"会议号：{result.get('meeting_no')}\n"
                f"加入链接：{result.get('url')}\n\n"
                "请直接点击链接进入飞书会议，描述故障现象。\n"
                "AI 会根据会议实时字幕生成诊断结果并发回这里。"
            )
            self._send_text(chat_id, msg)
            return "meeting_link_sent"
        except Exception as e:
            print(f"[FeishuBot] meeting diagnosis error: {e}")
            self._send_text(chat_id, f"预约会议时出错：{e}")
            return f"meeting_error: {e}"

    async def _handle_video_diagnosis(self, chat_id: str, sender_id: str) -> str:
        """创建 RTC 视频排查房间并发送加入链接。"""
        try:
            from backend.api.vision import start_rtc_session, RtcSessionStartRequest

            rtc = await start_rtc_session(
                RtcSessionStartRequest(room_id=None, user_id=sender_id[:32]),
                auth_payload=None,
            )

            base_url = settings.FEISHU_RTC_BASE_URL.strip()
            if not base_url:
                # 本地或相对路径：飞书客户端通常能打开同域名，但最好配置绝对域名
                base_url = ""
            query = (
                f"app_id={rtc.app_id}"
                f"&room_id={rtc.room_id}"
                f"&user_id={rtc.user_id}"
                f"&token={rtc.token}"
                f"&session_id={rtc.session_id}"
            )
            url = f"{base_url}/static/rtc-call.html?{query}" if base_url else f"/static/rtc-call.html?{query}"

            msg = (
                "📹 已为你创建 AI 视频排查房间\n"
                f"点击链接加入视频通话，AI 会实时观察画面并分析故障：\n{url}\n\n"
                "提示：需要允许浏览器使用摄像头和麦克风。"
            )
            self._send_text(chat_id, msg)
            return "video_link_sent"
        except Exception as e:
            print(f"[FeishuBot] video diagnosis error: {e}")
            self._send_text(chat_id, f"创建视频排查房间失败：{e}\n请确认 RTC 已配置（RTC_APP_ID / RTC_APP_KEY）。")
            return f"video_error: {e}"

    def _send_welcome(self, chat_id: str, sender_id: str, top_event: str = "") -> None:
        """发送欢迎消息 + 网页端交互入口链接。"""
        base_url = settings.FEISHU_WEB_APP_URL.strip().rstrip("/")
        if not base_url:
            self._send_text(
                chat_id,
                "暂未配置网页端地址。\n"
                "请在 .env 中设置 FEISHU_WEB_APP_URL=https://你的前端地址:8443，然后重启后端。"
            )
            return

        query_parts = [f"sender_id={sender_id}", f"chat_id={chat_id}"]
        if top_event:
            from urllib.parse import quote
            query_parts.append(f"top_event={quote(top_event)}")

        query = "&".join(query_parts)
        web_url = f"{base_url}/vision?{query}"
        rtc_url = f"{base_url}/static/rtc-call.html?{query}"

        msg = (
            f"你好，我是{settings.FEISHU_BOT_NAME}。\n"
            "请在下方链接中完成交互式故障诊断：\n\n"
            f"🌐 网页端诊断（推荐）：\n{web_url}\n\n"
            "支持功能：\n"
            "- 文字描述故障并获取分析\n"
            "- 拍照/摄像头视觉识别\n"
            "- AI 实时视频通话诊断\n\n"
            f"📹 直接视频通话：\n{rtc_url}\n\n"
            "提示：飞书内点击链接会使用内置浏览器，请允许摄像头和麦克风权限。"
        )
        self._send_text(chat_id, msg)

    def _handle_web_diagnosis(self, chat_id: str, sender_id: str, top_event: str = "", tab: str = "vision") -> str:
        """发送网页端诊断入口链接，用户在浏览器/飞书内置浏览器中使用完整 Web UI。"""
        base_url = settings.FEISHU_WEB_APP_URL.strip().rstrip("/")
        if not base_url:
            self._send_text(
                chat_id,
                "暂未配置网页端地址。\n"
                "请在 .env 中设置 FEISHU_WEB_APP_URL=https://你的前端地址:8443，然后重启后端。"
            )
            return "web_url_not_configured"

        query_parts = [f"sender_id={sender_id}", f"chat_id={chat_id}"]
        if top_event:
            from urllib.parse import quote
            query_parts.append(f"top_event={quote(top_event)}")

        query = "&".join(query_parts)
        if tab == "rtc":
            url = f"{base_url}/static/rtc-call.html?{query}"
            msg = (
                "📹 点击链接加入 AI 视频诊断：\n"
                f"{url}\n\n"
                "提示：需要允许浏览器使用摄像头和麦克风。"
            )
        else:
            url = f"{base_url}/vision?{query}"
            msg = (
                "🌐 点击链接在网页端进行交互式诊断：\n"
                f"{url}\n\n"
                "支持：文字询问、视觉识别、实时视频通话。"
            )
        self._send_text(chat_id, msg)
        return "web_link_sent"

    # ---------- 配置命令（与 web 总览页对齐） ----------

    def _handle_set_doc(self, chat_id: str, session: UserSession, text: str) -> str:
        """设置知识来源文档，例如：文档 doc_xxx / 选择文档 doc_xxx。"""
        parts = text.split(None, 1)
        if len(parts) < 2 or not parts[1].strip():
            self._send_text(chat_id, "请指定文档 ID，例如：\n文档 doc_xxx\n或「文档 默认」取消指定。")
            return "set_doc_help"
        doc_id = parts[1].strip()
        if doc_id in ("默认", "default", "取消", "none", ""):
            session.doc_id = ""
            self._send_text(chat_id, "已取消文档指定，后续将使用全量知识库。")
        else:
            session.doc_id = doc_id
            self._send_text(chat_id, f"已指定知识来源文档：{doc_id}\n后续诊断将优先参考该文档。")
        return "set_doc"

    def _handle_set_provider(self, chat_id: str, session: UserSession, text: str) -> str:
        """设置 LLM Provider，例如：模型 openai / 模型 minimax。"""
        parts = text.split(None, 1)
        if len(parts) < 2 or not parts[1].strip():
            self._send_text(chat_id, "请指定模型 Provider，例如：\n模型 openai\n模型 minimax\n模型 默认（取消指定）")
            return "set_provider_help"
        provider = parts[1].strip()
        if provider in ("默认", "default", "取消", "none", ""):
            session.provider = ""
            self._send_text(chat_id, "已取消 Provider 指定，后续使用系统默认模型。")
        else:
            session.provider = provider
            self._send_text(chat_id, f"已指定模型 Provider：{provider}")
        return "set_provider"

    def _handle_set_weight(self, chat_id: str, session: UserSession, text: str) -> str:
        """设置文档权重 0.0~1.0，例如：权重 0.7。"""
        parts = text.split(None, 1)
        if len(parts) < 2:
            self._send_text(chat_id, "请指定 0.0~1.0 之间的权重，例如：\n权重 0.7\n权重 0.5")
            return "set_weight_help"
        try:
            weight = float(parts[1].strip())
            weight = max(0.0, min(1.0, weight))
            session.manual_weight = weight
            self._send_text(chat_id, f"已设置文档权重：{weight}（越接近 1 越依赖向量检索）")
        except ValueError:
            self._send_text(chat_id, "权重必须是 0.0~1.0 之间的数字，例如：权重 0.7")
        return "set_weight"

    def _build_action_card(self, chat_id: str, sender_id: str, top_event: str) -> dict:
        """构建故障描述后的操作选择卡片。"""
        return {
            "header": {
                "title": {"tag": "plain_text", "content": f"🛠️ 故障：{top_event[:40]}{'...' if len(top_event) > 40 else ''}"},
                "template": "blue",
            },
            "elements": [
                {
                    "tag": "div",
                    "text": {"tag": "lark_md", "content": "请选择下一步操作："},
                },
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "🌲 直接生成故障树"},
                            "type": "primary",
                            "value": {"action": "generate_tree", "chat_id": chat_id, "sender_id": sender_id, "top_event": top_event},
                        },
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "📹 视频排查"},
                            "type": "default",
                            "value": {"action": "video", "chat_id": chat_id, "sender_id": sender_id},
                        },
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "🎥 会议诊断"},
                            "type": "default",
                            "value": {"action": "meeting", "chat_id": chat_id, "sender_id": sender_id},
                        },
                        {
                            "tag": "button",
                            "text": {"tag": "plain_text", "content": "🌐 网页交互诊断"},
                            "type": "default",
                            "value": {"action": "web", "chat_id": chat_id, "sender_id": sender_id, "top_event": top_event},
                        },
                    ],
                },
                {
                    "tag": "note",
                    "elements": [
                        {"tag": "plain_text", "content": "也可以直接输入文字命令，如「重置」「帮助」「文档 doc_xxx」"}
                    ],
                },
            ],
        }

    async def _handle_card_action(self, chat_id: str, sender_id: str, action: str, top_event: str = "") -> str:
        """处理卡片按钮点击事件。"""
        session = self._get_session(sender_id)

        if action == "clarify":
            # 旧卡片兼容：不再询问澄清问题，直接基于当前问题做简单问答
            session.top_event = top_event or session.top_event
            if not session.top_event:
                self._send_text(chat_id, "请先描述故障现象。")
                return "card_action_no_top_event"
            return await self._simple_qa(chat_id, session, session.top_event)

        if action == "generate_tree":
            session.top_event = top_event or session.top_event
            if not session.top_event:
                self._send_text(chat_id, "请先描述故障现象。")
                return "card_action_no_top_event"
            session.stage = "processing"
            await self._generate_and_reply(chat_id, session)
            return "card_action_generate_tree"

        if action == "video":
            return await self._handle_video_diagnosis(chat_id, sender_id)

        if action == "meeting":
            return await self._handle_meeting_diagnosis(chat_id, sender_id)

        if action == "web":
            return self._handle_web_diagnosis(chat_id, sender_id, top_event)

        self._send_text(chat_id, "未知操作，请重新选择或输入文字。")
        return "card_action_unknown"

    # ---------- 内部处理流程 ----------

    def _send_clarify_message(self, chat_id: str, questions: list[ClarifyQuestion], raw_intro: str | None, cached: bool = False) -> None:
        """发送澄清问题消息。"""
        tag = "（来自历史缓存）" if cached else ""
        lines = [f"{raw_intro or '为了更精准地定位故障源，请补充以下信息：'}{tag}", ""]
        for i, q in enumerate(questions, 1):
            lines.append(f"{i}. {q.text}")
            if q.hint:
                lines.append(f"   （提示：{q.hint}）")
        lines.append("")
        lines.append("你可以直接按序号回复答案，例如：\n1. 是\n2. 间歇性\n3. 红色报警灯")
        self._send_text(chat_id, "\n".join(lines))

    async def _generate_and_reply(self, chat_id: str, session: UserSession) -> None:
        """根据 top_event + answers 直接生成故障树并回复（兜底路径）。"""
        try:
            # 先尝试复用历史故障树
            from backend.api.generate import lookup_tree
            from backend.api.generate import LookupRequest

            query = session.top_event
            if session.answers:
                query += "\n" + "\n".join(f"{k}: {v}" for k, v in session.answers.items())
            lookup_resp = await lookup_tree(LookupRequest(query=query))
            if lookup_resp and lookup_resp.get("found") and lookup_resp.get("tree_id"):
                from backend.api.generate import get_tree
                reused = await get_tree(lookup_resp["tree_id"])
                if reused and reused.fault_tree:
                    summary = self._format_fault_tree(reused.fault_tree, reused.tree_id)
                    self._send_text(chat_id, f"命中历史故障树：\n\n{summary}\n\n输入「重置」可以询问新的故障。")
                    session.stage = "idle"
                    await self._save_session(session)
                    return
        except Exception as e:
            print(f"[FeishuBot] lookup_tree error: {e}")

        # 未命中则生成新的故障树
        try:
            tree_text = await self._generate_tree_summary(session)
            if tree_text:
                self._send_text(chat_id, f"故障树分析：\n\n{tree_text}\n\n输入「重置」可以询问新的故障。")
            else:
                self._send_text(chat_id, "生成故障树失败，请稍后重试或输入「重置」重新开始。")
        except Exception as e:
            print(f"[FeishuBot] direct generate error: {e}")
            self._send_text(chat_id, f"生成故障树时出错：{e}\n请稍后重试或输入「重置」重新开始。")
        finally:
            session.stage = "idle"
            await self._save_session(session)

    async def _save_session(self, session: UserSession) -> None:
        """保存会话到数据库（与 web 总览页 save_session 对齐）。"""
        try:
            from backend.api.generate import save_session
            from backend.models.schemas import SaveSessionRequest

            await save_session(
                SaveSessionRequest(
                    top_event=session.top_event,
                    answers=session.answers,
                    messages=session.messages[-20:],  # 只保存最近 20 条
                )
            )
        except Exception as e:
            print(f"[FeishuBot] save_session error: {e}")

    async def _handle_new_fault(self, chat_id: str, session: UserSession, text: str) -> str:
        """用户描述新故障后，发送操作选择卡片（与 web 总览页按钮交互对齐）。"""
        session.top_event = text
        session.answers = {}
        session.questions = []
        session.stage = "idle"

        card = self._build_action_card(chat_id, session.sender_id, text)
        result = self._send_interactive_card(chat_id, card)
        if not result.get("ok"):
            # 卡片发送失败时回退到文字流程
            return await self._start_clarify_flow(chat_id, session, text)
        return "action_card_sent"

    async def _simple_qa(self, chat_id: str, session: UserSession, text: str) -> str:
        """
        简单问答：直接基于知识库给出答案，不再询问澄清问题。
        命中知识库时返回结构化答案；未命中时由 LLM 兜底生成简短回答。
        """
        session.stage = "processing"
        session.top_event = text
        try:
            from backend.api.knowledge import search_knowledge_items, KnowledgeItemSearchRequest

            resp = await search_knowledge_items(
                KnowledgeItemSearchRequest(query=text, top_k=5)
            )
            results = resp.get("results", []) if resp else []
            answer = self._format_knowledge_items(text, results)

            # 未命中知识库时，使用 LLM 兜底生成简短回答
            if not answer:
                from backend.core.llm.manager import get_llm_manager

                prompt = (
                    f"用户问题：{text}\n\n"
                    "你是工业设备维修助手。请基于常见工业维修知识，给出简洁、可落地的回答。"
                    "若无法判断，请直接说明需要更多信息。回答控制在300字以内。"
                )
                manager = get_llm_manager()
                llm_resp, _ = await manager.generate_with_fallback(prompt)
                answer = (llm_resp.content if llm_resp else "").strip()

            if not answer:
                answer = "暂未找到相关知识点，请尝试换个描述或输入「帮助」查看可用指令。"

            self._send_text(chat_id, answer)

            session.stage = "idle"
            await self._save_session(session)
            return "simple_qa"
        except Exception as e:
            session.stage = "idle"
            print(f"[FeishuBot] simple_qa error: {e}")
            self._send_text(chat_id, f"回答问题时出错：{e}\n请稍后重试或输入「重置」重新开始。")
            return f"simple_qa_error: {e}"

    async def _start_clarify_flow(self, chat_id: str, session: UserSession, text: str) -> str:
        """开始澄清流程：先查缓存，再让 LLM 生成澄清问题。"""
        session.stage = "processing"
        session.top_event = text
        session.answers = {}
        session.questions = []

        try:
            # 1) 先尝试复用历史 clarify 问题（与 web 总览页一致）
            from backend.api.generate import clarify_lookup
            from backend.models.schemas import ClarifyLookupRequest

            cached = await clarify_lookup(ClarifyLookupRequest(top_event=text))
            if cached and cached.found and cached.questions:
                session.questions = cached.questions
                session.answers = {}
                session.stage = "awaiting_clarify"
                self._send_clarify_message(chat_id, cached.questions, cached.raw_intro, cached=True)
                return "clarify_asked_cached"
        except Exception as e:
            print(f"[FeishuBot] clarify_lookup error: {e}")

        try:
            # 2) 未命中缓存则让 LLM 生成澄清问题
            from backend.api.generate import clarify_problem
            from backend.models.schemas import ClarifyRequest

            req = ClarifyRequest(
                top_event=text,
                doc_ids=[session.doc_id] if session.doc_id else None,
                provider=session.provider or None,
                rag_top_k=3,
                max_questions=4,
            )
            resp = await clarify_problem(req)

            if not resp.questions:
                # 3) 没有问题则直接生成故障树（兜底，与 web 总览页一致）
                session.stage = "idle"
                await self._generate_and_reply(chat_id, session)
                return "direct_generate"

            session.questions = resp.questions
            session.answers = {}
            session.stage = "awaiting_clarify"
            self._send_clarify_message(chat_id, resp.questions, resp.raw_intro, cached=False)
            return "clarify_asked"
        except Exception as e:
            session.stage = "idle"
            print(f"[FeishuBot] clarify error: {e}")
            self._send_text(chat_id, f"生成澄清问题时出错：{e}\n请稍后重试或输入「重置」重新开始。")
            return f"clarify_error: {e}"

    async def _handle_clarify_answer(self, chat_id: str, session: UserSession, text: str) -> str:
        """解析用户对澄清问题的回答，与 web 总览页提交澄清后流程对齐。"""
        # 简单解析：按行或分号拆分，尝试匹配 "序号. 答案" 或 "Q1. 答案"
        parsed = self._parse_answers(text, session.questions)
        session.answers.update(parsed)

        # 检查必填问题是否都答了
        missing = [q for q in session.questions if q.required and not session.answers.get(q.id)]
        if missing:
            lines = ["还有以下必填问题需要回答：", ""]
            for q in missing:
                lines.append(f"- {q.text}")
            lines.append("\n请继续补充，或直接回复所有问题的答案。")
            self._send_text(chat_id, "\n".join(lines))
            return "clarify_incomplete"

        session.stage = "processing"
        try:
            # 1) 先尝试命中历史诊断案例
            from backend.api.generate import diagnosis_lookup
            from backend.models.schemas import DiagnosisLookupRequest

            lookup_resp = await diagnosis_lookup(
                DiagnosisLookupRequest(top_event=session.top_event, answers=session.answers)
            )

            if lookup_resp.found and lookup_resp.fault_tree:
                summary = self._format_fault_tree(lookup_resp.fault_tree, lookup_resp.tree_id)
                self._send_text(chat_id, f"命中历史诊断案例：\n\n{summary}\n\n输入「重置」可以询问新的故障。")
                session.stage = "idle"
                await self._save_session(session)
                return "diagnosis_hit"

            # 2) 再尝试命中历史排查步骤
            from backend.api.generate import steps_lookup
            from backend.models.schemas import StepsLookupRequest

            steps_hit = await steps_lookup(
                StepsLookupRequest(top_event=session.top_event, answers=session.answers)
            )
            if steps_hit.found and steps_hit.steps:
                result_text = self._format_steps(steps_hit.steps, steps_hit.summary)
                self._send_text(chat_id, f"命中历史排查步骤：\n\n{result_text}\n\n输入「重置」可以询问新的故障。")
                session.stage = "idle"
                await self._save_session(session)
                return "steps_hit"

            # 3) 未命中则生成排查步骤
            from backend.api.generate import generate_steps
            from backend.models.schemas import StepsRequest

            steps_resp = await generate_steps(
                StepsRequest(
                    top_event=session.top_event,
                    user_prompt=session.top_event,
                    doc_ids=[session.doc_id] if session.doc_id else None,
                    provider=session.provider or None,
                    rag_top_k=3,
                    clarify_questions=session.questions,
                    clarify_answers=session.answers,
                )
            )

            result_text = self._format_steps(steps_resp.steps, steps_resp.summary)
            self._send_text(chat_id, result_text)

            # 4) 同时生成故障树（异步，失败不影响步骤回复）
            try:
                tree_text = await self._generate_tree_summary(session)
                if tree_text:
                    self._send_text(chat_id, f"故障树分析：\n\n{tree_text}\n\n输入「重置」可以询问新的故障。")
            except Exception as e:
                print(f"[FeishuBot] generate tree error: {e}")

            session.stage = "idle"
            await self._save_session(session)
            return "steps_generated"
        except Exception as e:
            session.stage = "awaiting_clarify"
            print(f"[FeishuBot] steps error: {e}")
            self._send_text(chat_id, f"生成排查步骤时出错：{e}\n请检查答案格式后重试，或输入「重置」重新开始。")
            return f"steps_error: {e}"

    async def _generate_tree_summary(self, session: UserSession) -> str:
        """生成故障树并返回文本摘要；先尝试复用历史故障树。"""
        try:
            from backend.api.generate import lookup_tree
            from backend.api.generate import LookupRequest

            query = session.top_event
            if session.answers:
                query += "\n" + "\n".join(f"{k}: {v}" for k, v in session.answers.items())
            lookup_resp = await lookup_tree(LookupRequest(query=query))
            if lookup_resp and lookup_resp.get("found") and lookup_resp.get("tree_id"):
                from backend.api.generate import get_tree
                reused = await get_tree(lookup_resp["tree_id"])
                if reused and reused.fault_tree:
                    return "命中历史故障树：\n\n" + self._format_fault_tree(reused.fault_tree, reused.tree_id)
        except Exception as e:
            print(f"[FeishuBot] lookup_tree error in _generate_tree_summary: {e}")

        from backend.api.generate import generate_ft
        from backend.models.schemas import GenerateRequest

        req = GenerateRequest(
            top_event=session.top_event,
            user_prompt=session.top_event,
            doc_ids=[session.doc_id] if session.doc_id else None,
            provider=session.provider or None,
            manual_weight=session.manual_weight,
            clarify_questions=session.questions,
            clarify_answers=session.answers,
            rag_top_k=3,
            use_fallback=True,
        )
        resp = await generate_ft(req)
        if not resp or not resp.fault_tree:
            return ""
        return self._format_fault_tree(resp.fault_tree, resp.tree_id)

    # ---------- 格式化输出 ----------

    def _format_steps(self, steps: list, summary: str) -> str:
        lines = []
        if summary:
            lines.append(f"📋 {summary}")
        else:
            lines.append("📋 建议按以下步骤排查：")
        lines.append("")
        for s in steps:
            title = getattr(s, "title", "")
            action = getattr(s, "action", "")
            expected = getattr(s, "expected", "")
            decision = getattr(s, "decision", "")
            note = getattr(s, "note", "")
            lines.append(f"第 {getattr(s, 'step', '?')} 步：{title}")
            if action:
                lines.append(f"  操作：{action}")
            if expected:
                lines.append(f"  预期：{expected}")
            if decision:
                lines.append(f"  判断：{decision}")
            if note:
                lines.append(f"  注意：{note}")
            lines.append("")
        return "\n".join(lines).rstrip()

    def _format_fault_tree(self, fault_tree, tree_id: str | None) -> str:
        lines = [f"🔧 顶事件：{fault_tree.top_event}", ""]
        if fault_tree.analysis_summary:
            lines.append(f"分析摘要：{fault_tree.analysis_summary}")
        if fault_tree.nodes:
            lines.append("\n涉及节点：")
            for node in fault_tree.nodes[:10]:
                lines.append(f"- [{node.type}] {node.name}")
            if len(fault_tree.nodes) > 10:
                lines.append(f"  ... 等共 {len(fault_tree.nodes)} 个节点")
        if tree_id:
            lines.append(f"\n故障树 ID：{tree_id}")
        return "\n".join(lines)

    def _format_knowledge_items(self, query: str, items: list[dict]) -> str:
        """把知识库检索结果格式化为飞书文本回答。"""
        if not items:
            return ""
        lines = [f"🔍 针对「{query}」，找到以下参考：", ""]
        for i, item in enumerate(items[:5], 1):
            kt = str(item.get("knowledge_type") or "fault")
            machine = str(item.get("machine") or "").strip()
            if machine:
                lines.append(f"{i}. 设备/来源：{machine}")
            else:
                lines.append(f"{i}.")

            if kt == "maintenance":
                op_cat = str(item.get("operation_category") or "").strip()
                op_item = str(item.get("operation_item") or "").strip()
                op_steps = str(item.get("operation_steps") or "").strip()
                check_std = str(item.get("check_standard") or "").strip()
                precautions = str(item.get("precautions") or "").strip()
                if op_cat:
                    lines.append(f"   类别：{op_cat}")
                if op_item:
                    lines.append(f"   操作项：{op_item}")
                if check_std:
                    lines.append(f"   检查标准：{check_std}")
                if op_steps:
                    lines.append(f"   步骤：{op_steps}")
                if precautions:
                    lines.append(f"   注意事项：{precautions}")
            else:
                problem = str(item.get("problem") or "").strip()
                root_cause = str(item.get("root_cause") or "").strip()
                solution = str(item.get("solution") or "").strip()
                if problem:
                    lines.append(f"   问题：{problem}")
                if root_cause:
                    lines.append(f"   原因：{root_cause}")
                if solution:
                    lines.append(f"   处理：{solution}")
            lines.append("")
        return "\n".join(lines).rstrip()

    # ---------- 文本工具 ----------

    def _extract_text(self, content: str) -> str:
        """从飞书消息 content 中提取纯文本。"""
        if not content:
            return ""
        text = content.strip()
        # 飞书 text 消息 content 通常是 JSON，如 {"text":"hello"}
        if text.startswith("{"):
            try:
                data = json.loads(text)
                if isinstance(data, dict) and "text" in data:
                    return str(data["text"])
            except Exception:
                pass
        return text

    def _parse_answers(self, text: str, questions: list[ClarifyQuestion]) -> dict[str, str]:
        """
        解析用户对澄清问题的回答。
        支持格式：
        1. 答案
        2. 答案
        Q1. 答案
        A: 答案
        """
        answers: dict[str, str] = {}
        if not questions:
            return answers

        qid_map: dict[str, ClarifyQuestion] = {}
        idx_map: dict[int, ClarifyQuestion] = {}
        for i, q in enumerate(questions):
            qid_map[q.id.lower()] = q
            idx_map[i + 1] = q

        # 尝试按 "序号. 答案" 或 "Q1. 答案" 解析
        # 匹配行首的 数字. 或 Q数字. 或 数字、
        pattern = re.compile(r"^(?:Q|q)?(\d+)[\.、\.\)\】:：\s]+(.+)$", re.MULTILINE)
        for match in pattern.finditer(text):
            idx = int(match.group(1))
            answer = match.group(2).strip()
            if idx in idx_map:
                answers[idx_map[idx].id] = answer

        # 如果没匹配到任何结构，且只有一条文本，则当作第一个未答问题的答案
        if not answers:
            first_unanswered = next((q for q in questions if q.id not in answers), None)
            if first_unanswered:
                answers[first_unanswered.id] = text.strip()

        return answers

    def _help_text(self) -> str:
        return (
            f"你好，我是{settings.FEISHU_BOT_NAME}。\n"
            "直接发送设备故障或维修问题，我会基于知识库立即给出答案。\n\n"
            "常用指令：\n"
            "- 帮助：查看本条说明\n"
            "- 视频排查：直接打开 AI 视频诊断页面\n"
            "- 会议诊断：预约飞书视频会议\n"
            "- 网页诊断：打开网页端交互入口\n"
            "- 重置：清空当前会话"
        )


# 全局单例
feishu_bot_service = FeishuBotService()
