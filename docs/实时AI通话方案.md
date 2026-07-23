# 实时 AI 通话方案

## 1. 功能目标

在 RTC 视频通话过程中，AI 能够：

- 持续观察用户摄像头画面中的机械设备；
- 主动发现异常并语音提醒；
- 回答用户语音/文字提问，结合当前画面给出诊断建议；
- 支持移动端（Android WebView）现场使用。

## 2. 架构设计

采用 **前端 RTC + WebSocket 实时 AI 通道** 的混合架构：

```
移动端/PC 前端                后端 FastAPI
┌──────────────┐             ┌──────────────────────────┐
│ BytePlus RTC │◄───────────►│ RTC Token / Session 管理 │
│ 音视频通话   │             └──────────────────────────┘
└──────┬───────┘                          ▲
       │ WebSocket                         │
       ▼                                   │
┌──────────────┐             ┌────────────┴─────────────┐
│ 实时帧上传   │────────────►│ RealtimeFrameAnalyzer    │
│ 语音/文字提问│────────────►│ 视觉检测 + LLM/VLM 诊断  │
│ AI 回复播报  │◄────────────│ 异常去重 + 主动提醒      │
└──────────────┘             └──────────────────────────┘
```

## 3. 核心流程

1. 用户点击「接通 AI」，前端通过 BytePlus RTC 加入房间；
2. 同时前端与后端建立 WebSocket 连接 `/api/realtime/ws/{session_id}`；
3. 前端周期性抓取本地视频帧，压缩后通过 WebSocket 发送给后端；
4. 后端先做轻量 CV 检测，再根据异常状态和用户问题触发 LLM/VLM；
5. AI 诊断文本通过 WebSocket 推回前端，前端语音播报并显示字幕；
6. 当连续检测到异常且异常类型变化时，AI 主动提醒用户。

## 4. 后端模块

| 文件 | 职责 |
|---|---|
| `backend/api/realtime.py` | WebSocket 路由，管理消息收发 |
| `backend/core/realtime/frame_analyzer.py` | 帧分析调度器 |
| `backend/core/realtime/session_state.py` | 实时会话状态、异常去重 |
| `backend/core/rtc/session_manager.py` | RTC 会话与 WebSocket 连接映射 |
| `backend/api/vision.py` | VLM / 文本 LLM 诊断回复 |

## 5. 前端模块

| 文件 | 职责 |
|---|---|
| `frontend/src/services/realtime.js` | WebSocket 封装、重连、心跳 |
| `frontend/src/hooks/useSpeech.js` | 语音输入/输出 |
| `frontend/src/components/vision/RtcCallAssistant.jsx` | AI 状态、字幕、控制面板 |
| `frontend/src/pages/vision/VisionDetect.jsx` | 通话 UI 与实时分析集成 |

## 6. WebSocket 协议

### 客户端 → 服务端

```json
{ "type": "ping", "payload": { "ts": 1234567890 } }
{ "type": "frame", "payload": { "image_base64": "data:image/jpeg;base64,...", "timestamp": 1234567890 } }
{ "type": "ask", "payload": { "text": "这个电机为什么会过热？", "mode": "voice|text" } }
```

### 服务端 → 客户端

```json
{ "type": "pong", "payload": { "ts": 1234567890 } }
{ "type": "status", "payload": { "ai_status": "observing|analyzing|speaking" } }
{ "type": "result", "payload": { "content": "...", "overall_status": "normal|warning|critical", "speak": true } }
{ "type": "error", "payload": { "content": "..." } }
```

## 7. 配置项

在 `.env` 中配置：

```ini
# RTC 配置（BytePlus / 火山引擎）
RTC_APP_ID=your_app_id
RTC_APP_KEY=your_app_key

# 可选：原生多模态 VLM（OpenAI 兼容接口）
VLM_PROVIDER=openai
VLM_MODEL=gpt-4o
VLM_BASE_URL=https://api.openai.com/v1
VLM_API_KEY=your_key

# 实时分析配置
REALTIME_FRAME_INTERVAL_MS=2000
REALTIME_MIN_ANOMALY_FRAMES=2
REALTIME_ALERT_COOLDOWN_SECONDS=10.0
```

如果 `VLM_PROVIDER` 留空，则使用「目标检测摘要 + 文本 LLM」的回退方案。

## 8. 后续演进

- **Phase 2**：接入 BytePlus RTC 服务端 SDK，让 AI Bot 真正进房订阅音视频流；
- **Phase 3**：接入服务端 ASR/TTS，降低对浏览器 Web Speech API 的依赖；
- **Phase 4**：支持多路视频、专家远程协助。
