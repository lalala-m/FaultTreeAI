#!/usr/bin/env bash
set -euo pipefail

trap 'echo "[错误] 脚本在 ${BASH_SOURCE[0]} 第 $LINENO 行执行失败，命令: $BASH_COMMAND" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

if [ "${1:-}" = "check-ai-summary" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "[错误] 未找到 psql。请先安装 PostgreSQL 客户端（含 psql）。"
    exit 1
  fi

  DOC_ID="${2:-}"
  if [ ! -f ".env" ]; then
    echo "[错误] 未找到项目根目录 .env，无法确定数据库连接信息。"
    echo "请先在项目根目录创建 .env 并配置 DATABASE_URL。"
    exit 1
  fi

  set -a
  source .env
  set +a

  if [ -z "${DATABASE_URL:-}" ]; then
    echo "[错误] .env 中未配置 DATABASE_URL"
    exit 1
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "[错误] 未找到 python3（用于解析 DATABASE_URL）。"
    exit 1
  fi

  read -r DB_USER DB_PASS DB_HOST DB_PORT DB_NAME < <(
    python3 - <<'PY'
import os
from urllib.parse import urlparse

u = os.environ.get("DATABASE_URL", "")
u = u.replace("postgresql+asyncpg://", "postgresql://").replace("postgresql+psycopg2://", "postgresql://")
pu = urlparse(u)
user = pu.username or "postgres"
pwd = pu.password or ""
host = pu.hostname or "localhost"
port = str(pu.port or 5432)
db = (pu.path or "/postgres").lstrip("/") or "postgres"
print(user, pwd, host, port, db)
PY
  )

  if [ -z "${DOC_ID:-}" ]; then
    DOC_ID="$(PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -P pager=off -Atc "SELECT doc_id FROM documents WHERE status <> 'deleted' ORDER BY upload_time DESC LIMIT 1;" 2>/dev/null || true)"
  fi

  if [ -z "${DOC_ID:-}" ]; then
    echo "[错误] 未找到 doc_id。请显式传入："
    echo "  ./scripts/start_kylin.sh check-ai-summary <doc_id>"
    exit 1
  fi

  echo "[*] DB: host=${DB_HOST} port=${DB_PORT} user=${DB_USER} db=${DB_NAME}"
  echo "[*] doc_id: ${DOC_ID}"
  echo ""

  PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -P pager=off -c "
SELECT doc_id, filename, upload_time,
       metadata->>'pipeline' AS pipeline,
       metadata->>'structured_kb' AS structured_kb,
       metadata->>'structured_provider' AS structured_provider,
       metadata->>'structured_error' AS structured_error,
       metadata->>'structured_extracted' AS structured_extracted,
       metadata->>'structured_inserted' AS structured_inserted,
       metadata->>'structured_skipped' AS structured_skipped,
       metadata->>'ai_summary_status' AS ai_summary_status,
       length(coalesce(metadata->>'ai_summary','')) AS ai_len,
       metadata->>'ai_summary_error' AS ai_err
FROM documents
WHERE doc_id = '${DOC_ID}';"

  echo ""
  ITEM_COUNT="$(PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -P pager=off -Atc "
SELECT COUNT(*)
FROM knowledge_items
WHERE status='active'
  AND COALESCE(metadata->>'doc_id','') = '${DOC_ID}';
" 2>/dev/null | tr -d '\r' | tail -n 1)"

  PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -P pager=off -c "
SELECT COUNT(*) AS item_count
FROM knowledge_items
WHERE status='active'
  AND COALESCE(metadata->>'doc_id','') = '${DOC_ID}';"

  echo ""
  PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -P pager=off -c "
SELECT pipeline, machine_category, machine, problem_category, problem, root_cause,
       COALESCE(metadata->>'doc_id','') AS doc_id,
       COALESCE(metadata->>'filename','') AS filename
FROM knowledge_items
WHERE status='active'
  AND COALESCE(metadata->>'doc_id','') = '${DOC_ID}'
ORDER BY updated_at DESC
LIMIT 20;"

  if [ "${ITEM_COUNT:-0}" = "0" ]; then
    echo ""
    echo "[!] 按 doc_id 未找到条目，尝试按 filename 回查（排除 doc_id 关联丢失）..."
    PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -P pager=off -c "
SELECT COUNT(*) AS item_count_by_filename
FROM knowledge_items
WHERE status='active'
  AND COALESCE(metadata->>'filename','') = (SELECT filename FROM documents WHERE doc_id='${DOC_ID}' LIMIT 1)
  AND updated_at >= (SELECT upload_time - INTERVAL '30 minutes' FROM documents WHERE doc_id='${DOC_ID}' LIMIT 1);"

    echo ""
    PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -P pager=off -c "
SELECT pipeline, machine_category, machine, problem_category, problem, root_cause,
       COALESCE(metadata->>'doc_id','') AS doc_id
FROM knowledge_items
WHERE status='active'
  AND COALESCE(metadata->>'filename','') = (SELECT filename FROM documents WHERE doc_id='${DOC_ID}' LIMIT 1)
  AND updated_at >= (SELECT upload_time - INTERVAL '30 minutes' FROM documents WHERE doc_id='${DOC_ID}' LIMIT 1)
ORDER BY updated_at DESC
LIMIT 20;"
  fi

  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[错误] 未找到 python3。请先安装：sudo dnf install -y python3 python3-pip python3-devel"
  exit 1
fi

mkdir -p "$HOME/tmp"
export TMPDIR="$HOME/tmp"

if [ -d ".venv" ] && [ ! -f ".venv/bin/activate" ]; then
  rm -rf .venv
fi

if [ ! -f ".venv/bin/activate" ]; then
  python3 -m pip install --user --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com virtualenv
  python3 -m virtualenv .venv
fi

source .venv/bin/activate

PYTHON_BIN="$(command -v python 2>/dev/null || true)"
if [ -z "${PYTHON_BIN:-}" ]; then
  PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
fi
if [ -z "${PYTHON_BIN:-}" ]; then
  echo "[错误] 虚拟环境已激活，但未找到 python/python3 可执行文件。"
  exit 1
fi

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

DOCKER_BIN="docker"
DOCKER_SUDO=""

_select_docker_cli() {
  if docker info >/dev/null 2>&1; then
    DOCKER_BIN="docker"
    DOCKER_SUDO=""
    return 0
  fi
  if $SUDO docker info >/dev/null 2>&1; then
    DOCKER_BIN="docker"
    DOCKER_SUDO="$SUDO"
    return 0
  fi
  return 1
}

if [ ! -f ".env" ]; then
  cat > .env <<'EOF'
VITE_API_TARGET=http://127.0.0.1:8000
DATABASE_URL=postgresql+asyncpg://postgres:faulttree123@localhost:5432/postgres
LLM_PROVIDER=openai
LLM_FALLBACK_PROVIDER=openai
EMBED_PROVIDER=openai
OPENAI_BASE_URL=https://qianfan.baidubce.com/v2
OPENAI_API_KEY=
LLM_MODEL=glm-5.1
EMBED_MODEL=text-embedding-ada-002
RAG_USE_HYBRID=true
RAG_VECTOR_WEIGHT=0
EOF
fi

if ! grep -q "^DATABASE_URL=" .env 2>/dev/null; then
  echo "DATABASE_URL=postgresql+asyncpg://postgres:faulttree123@localhost:5432/postgres" >> .env
fi

if ! "$PYTHON_BIN" -c "import uvicorn" >/dev/null 2>&1; then
  echo "[*] 安装后端依赖（使用阿里云 PyPI 镜像）..."
  "$PYTHON_BIN" -m pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com
fi

if command -v docker >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files 2>/dev/null | grep -q "^docker\\.service"; then
      $SUDO systemctl start docker || true
    elif systemctl list-unit-files 2>/dev/null | grep -q "^docker$"; then
      $SUDO systemctl start docker || true
    fi
  fi

  if ! _select_docker_cli; then
    if command -v dockerd >/dev/null 2>&1; then
      $SUDO nohup dockerd >/tmp/dockerd.log 2>&1 &
      sleep 2
    fi
  fi

  if _select_docker_cli; then
    if [ -z "$($DOCKER_SUDO $DOCKER_BIN ps -a -q -f name=faulttree-db)" ]; then
      $DOCKER_SUDO $DOCKER_BIN run -d --name faulttree-db -p 5432:5432 -e POSTGRES_PASSWORD=faulttree123 docker.m.daocloud.io/pgvector/pgvector:pg16
    else
      $DOCKER_SUDO $DOCKER_BIN start faulttree-db >/dev/null 2>&1 || true
    fi
  else
    echo "[!] Docker 未就绪，跳过数据库容器启动。"
  fi
else
  echo "[!] 未检测到 docker，跳过数据库容器启动。"
fi

# 等待 PostgreSQL 就绪并自动创建数据库
_wait_for_postgres() {
  local max_wait=30
  local waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    if $SUDO docker exec faulttree-db pg_isready -U postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

if _select_docker_cli && [ -n "$($DOCKER_SUDO $DOCKER_BIN ps -q -f name=faulttree-db)" ]; then
  echo "[*] 等待 PostgreSQL 就绪..."
  if _wait_for_postgres; then
    echo "[OK] PostgreSQL 已就绪"

    # 从 .env 解析数据库名，自动创建
    DB_NAME_FROM_ENV="postgres"
    if [ -f ".env" ]; then
      DB_NAME_FROM_ENV="$(grep '^DATABASE_URL=' .env | head -n1 | sed -n 's|.*@.*/\([^?]*\).*|\1|p')"
      [ -z "$DB_NAME_FROM_ENV" ] && DB_NAME_FROM_ENV="postgres"
    fi

    if [ "$DB_NAME_FROM_ENV" != "postgres" ]; then
      echo "[*] 检查数据库 $DB_NAME_FROM_ENV 是否存在..."
      if ! $SUDO docker exec faulttree-db psql -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME_FROM_ENV';" | grep -q '^1$'; then
        $SUDO docker exec faulttree-db psql -U postgres -d postgres -c "CREATE DATABASE \"$DB_NAME_FROM_ENV\";" >/dev/null 2>&1
        echo "[OK] 数据库 $DB_NAME_FROM_ENV 已创建"
      else
        echo "[OK] 数据库 $DB_NAME_FROM_ENV 已存在"
      fi
    fi
  else
    echo "[!] 等待 PostgreSQL 超时，后端可能无法连接数据库"
  fi
fi

if command -v firewall-cmd >/dev/null 2>&1; then
  $SUDO firewall-cmd --add-port=8000/tcp --permanent >/dev/null 2>&1 || true
  $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
fi

VM_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -z "${VM_IP:-}" ]; then
  VM_IP="127.0.0.1"
fi

# 设置 RTC Bot 动态库路径
# 优先从 .env 中的 RTC_BOT_SO_PATH 推导 sdk/lib 目录
_RTC_BOT_SO_PATH=""
if [ -f "$PROJECT_ROOT/.env" ]; then
  _RTC_BOT_SO_PATH="$(grep '^RTC_BOT_SO_PATH=' "$PROJECT_ROOT/.env" 2>/dev/null | head -n1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -d '\r' || true)"
fi
if [ -n "$_RTC_BOT_SO_PATH" ]; then
  case "$_RTC_BOT_SO_PATH" in
    /*) _RTC_BOT_SO_ABS="$_RTC_BOT_SO_PATH" ;;
    *) _RTC_BOT_SO_ABS="$PROJECT_ROOT/$_RTC_BOT_SO_PATH" ;;
  esac
  _RTC_BOT_SDK_LIB="$(dirname "$_RTC_BOT_SO_ABS")/../sdk/lib"
  _RTC_BOT_SDK_LIB="$(cd "$_RTC_BOT_SDK_LIB" 2>/dev/null && pwd || true)"
  if [ -d "$_RTC_BOT_SDK_LIB" ]; then
    export LD_LIBRARY_PATH="${_RTC_BOT_SDK_LIB}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
fi
# 兜底：项目内置路径
RTC_BOT_SO_DIR="$PROJECT_ROOT/deploy/vm/rtc_bot/sdk/lib"
if [ -d "$RTC_BOT_SO_DIR" ]; then
  export LD_LIBRARY_PATH="${RTC_BOT_SO_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

BACKEND_PORT="${BACKEND_PORT:-8000}"
echo "[OK] 后端启动中..."
echo "[OK] 虚拟机访问: http://127.0.0.1:${BACKEND_PORT}/docs"
echo "[OK] 宿主机访问: http://${VM_IP}:${BACKEND_PORT}/docs"

# 若启用飞书且使用 WS 客户端，则自动启动（不阻塞后端）
FEISHU_ENABLED=""
FEISHU_USE_WS_CLIENT=""
if [ -f "$PROJECT_ROOT/.env" ]; then
  FEISHU_ENABLED="$(grep '^FEISHU_ENABLED=' "$PROJECT_ROOT/.env" 2>/dev/null | head -n1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -d '\r' || true)"
  FEISHU_USE_WS_CLIENT="$(grep '^FEISHU_USE_WS_CLIENT=' "$PROJECT_ROOT/.env" 2>/dev/null | head -n1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -d '\r' || true)"
fi
if [ "$FEISHU_ENABLED" = "true" ] && [ "$FEISHU_USE_WS_CLIENT" = "true" ]; then
  FEISHU_BACKEND_URL="${FEISHU_BACKEND_URL:-http://127.0.0.1:${BACKEND_PORT}}"
  IM_LOG="$PROJECT_ROOT/logs/feishu_im_event.log"
  mkdir -p "$PROJECT_ROOT/logs"
  echo "[OK] 飞书 WS 客户端启动中，日志: $IM_LOG"
  nohup "$PYTHON_BIN" "$PROJECT_ROOT/scripts/feishu_ws_client.py" >>"$IM_LOG" 2>&1 &
fi

cd "$PROJECT_ROOT/backend"
exec "$PYTHON_BIN" -m uvicorn main:app --host 0.0.0.0 --port "${BACKEND_PORT}"
