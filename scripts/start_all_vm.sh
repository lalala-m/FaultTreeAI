#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# 故障检修系统 虚拟机一键启动脚本
# 作用：同时启动后端服务与飞书事件消费者（如果启用）
# 用法：
#   cd deploy/vm && ./scripts/start_all.sh
#   # 不启动飞书消费者
#   ./scripts/start_all.sh --no-feishu
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

cd "$PROJECT_DIR"

NO_FEISHU=false
for arg in "$@"; do
  case "$arg" in
    --no-feishu) NO_FEISHU=true ;;
    -h|--help)
      echo "用法: $0 [--no-feishu]"
      echo "  --no-feishu  不启动飞书事件消费者"
      exit 0
      ;;
  esac
done

# 读取 .env（如果存在）
FEISHU_ENABLED=false
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ENV_FILE" | xargs)
  FEISHU_ENABLED="${FEISHU_ENABLED:-false}"
fi

# 获取虚拟机 IP（用于提示）
VM_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -z "${VM_IP:-}" ] && VM_IP="127.0.0.1"

# 启动飞书消费者（后台）
start_feishu() {
  echo ""
  echo "[*] 飞书机器人已启用，正在启动事件消费者..."

  if ! command -v lark-cli &>/dev/null; then
    echo "[!] 警告：未找到 lark-cli，跳过飞书事件消费者启动。"
    echo "    如需启用，请先安装并登录："
    echo "      有 npm:  npm install -g @larksuite/cli && lark-cli login"
    echo "      无 npm:  ./scripts/install_lark_cli.sh && lark-cli login"
    echo "    后端服务仍会继续启动。"
    return 0
  fi

  local feishu_url="http://${VM_IP}:8000"
  # 如果 .env 中指定了 API_HOST/API_PORT，优先使用
  API_HOST="${API_HOST:-0.0.0.0}"
  API_PORT="${API_PORT:-8000}"
  if [ "$API_HOST" != "0.0.0.0" ]; then
    feishu_url="http://${API_HOST}:${API_PORT}"
  fi
  feishu_url="${FEISHU_BACKEND_URL:-$feishu_url}"
  feishu_url="${feishu_url//0.0.0.0/127.0.0.1}"

  export FEISHU_BACKEND_URL="$feishu_url"
  export RUN_IN_BACKGROUND=true
  export FEISHU_START_VC=true
  if "$SCRIPT_DIR/start_feishu_bot.sh" >/tmp/feishu_bot_start.log 2>&1; then
    echo "[OK] 飞书消费者已启动，日志见 logs/feishu_*.log"
    echo "     转发目标: $feishu_url"
  else
    echo "[!] 飞书消费者启动失败，日志：/tmp/feishu_bot_start.log"
    echo "    后端服务仍会继续启动。"
  fi
}

# 启动后端（前台，阻塞）
echo "========================================"
echo "  故障检修系统 虚拟机一键启动"
echo "========================================"

# 默认使用 lark-oapi WS 客户端（支持交互卡片按钮）
export FEISHU_USE_WS_CLIENT="${FEISHU_USE_WS_CLIENT:-true}"

if [ "$FEISHU_ENABLED" = "true" ] && [ "$NO_FEISHU" = "false" ]; then
  start_feishu
fi

echo ""
echo "[*] 启动后端服务..."
echo "========================================"
exec "$SCRIPT_DIR/start_kylin.sh"
