#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 在虚拟机/服务器上常驻运行飞书事件消费者
# 适用场景：后端部署在 VM 且无公网 HTTPS 域名，使用 lark-cli 事件消费模式
# 前置条件：
#   1. 已安装 lark-cli：https://open.larkoffice.com/document/tools-and-resources/cli-tool/overview
#   2. 已执行 lark-cli login 完成应用登录
#   3. .env 中 FEISHU_ENABLED=true 并填好 FEISHU_APP_ID / FEISHU_APP_SECRET
# 用法：
#   cd deploy/vm && ./scripts/start_feishu_bot.sh
#   # 指定后端地址（默认读取 .env 中的 HOST/PORT 组合）
#   FEISHU_BACKEND_URL=http://192.168.222.135:8000 ./scripts/start_feishu_bot.sh
#   # 使用 lark-oapi 原生 WebSocket 客户端（支持交互卡片按钮）
#   FEISHU_USE_WS_CLIENT=true ./scripts/start_feishu_bot.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
PYTHON_BIN="${PYTHON_BIN:-$PROJECT_DIR/.venv/bin/python}"
[ -x "$PYTHON_BIN" ] || PYTHON_BIN="$(command -v python3)"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

# 默认后端地址
API_HOST="${API_HOST:-0.0.0.0}"
API_PORT="${API_PORT:-8000}"
FEISHU_BACKEND_URL="${FEISHU_BACKEND_URL:-http://${API_HOST}:${API_PORT}}"
FEISHU_BACKEND_URL="${FEISHU_BACKEND_URL//0.0.0.0/127.0.0.1}"

echo "[FeishuBot] 后端地址: $FEISHU_BACKEND_URL"

FEISHU_USE_WS_CLIENT="${FEISHU_USE_WS_CLIENT:-false}"
FEISHU_IM_EVENT_TARGET="${FEISHU_BACKEND_URL}/api/feishu/event"
FEISHU_VC_EVENT_TARGET="${FEISHU_BACKEND_URL}/api/feishu/meeting-event"

# 日志与后台运行配置（WS 客户端和 lark-cli 模式都需要）
RUN_IN_BACKGROUND="${RUN_IN_BACKGROUND:-false}"
IM_LOG="$PROJECT_DIR/logs/feishu_im_event.log"
VC_LOG="$PROJECT_DIR/logs/feishu_vc_event.log"
mkdir -p "$PROJECT_DIR/logs"

# 使用 lark-oapi 原生 WebSocket 客户端（支持交互卡片按钮）
start_ws_client() {
  echo "[FeishuBot] 启动 lark-oapi WebSocket 客户端（支持 IM + 卡片回调）"
  export FEISHU_BACKEND_URL
  if [ "$RUN_IN_BACKGROUND" = "true" ]; then
    nohup "$PYTHON_BIN" "$SCRIPT_DIR/feishu_ws_client.py" >>"$IM_LOG" 2>&1 &
    echo "[FeishuBot] WS 客户端已转入后台，日志: $IM_LOG (PID: $!)"
  else
    "$PYTHON_BIN" "$SCRIPT_DIR/feishu_ws_client.py"
  fi
}

if [ "$FEISHU_USE_WS_CLIENT" = "true" ]; then
  start_ws_client
  exit 0
fi

if ! command -v lark-cli &>/dev/null; then
  echo "[FeishuBot] 错误：未找到 lark-cli。" >&2
  echo "    有 npm 时：npm install -g @larksuite/cli && lark-cli login" >&2
  echo "    无 npm 时：./scripts/install_lark_cli.sh（从 GitHub Releases 下载二进制）" >&2
  echo "    或使用 WS 客户端：FEISHU_USE_WS_CLIENT=true $0" >&2
  exit 1
fi

echo "[FeishuBot] lark-cli 版本: $(lark-cli --version)"

start_im_consumer() {
  echo "[FeishuBot] 启动 IM 消息消费者 -> $FEISHU_IM_EVENT_TARGET"
  export FEISHU_EVENT_TARGET="$FEISHU_IM_EVENT_TARGET"
  if [ "$RUN_IN_BACKGROUND" = "true" ]; then
    nohup "$PYTHON_BIN" "$SCRIPT_DIR/feishu_event_consumer.py" >>"$IM_LOG" 2>&1 &
    echo "[FeishuBot] IM 消费者已转入后台，日志: $IM_LOG (PID: $!)"
  else
    "$PYTHON_BIN" "$SCRIPT_DIR/feishu_event_consumer.py"
  fi
}

start_vc_consumer() {
  echo "[FeishuBot] 启动 VC 会议字幕消费者 -> $FEISHU_VC_EVENT_TARGET"
  export FEISHU_EVENT_TARGET="$FEISHU_VC_EVENT_TARGET"
  if [ "$RUN_IN_BACKGROUND" = "true" ]; then
    nohup "$PYTHON_BIN" "$SCRIPT_DIR/feishu_vc_event_consumer.py" >>"$VC_LOG" 2>&1 &
    echo "[FeishuBot] VC 消费者已转入后台，日志: $VC_LOG (PID: $!)"
  else
    "$PYTHON_BIN" "$SCRIPT_DIR/feishu_vc_event_consumer.py"
  fi
}

# 默认只启动 IM；可通过 FEISHU_START_VC=true 同时启动会议字幕监听
if [ "${FEISHU_START_VC:-false}" = "true" ]; then
  start_im_consumer &
  start_vc_consumer &
  wait
else
  start_im_consumer
fi
