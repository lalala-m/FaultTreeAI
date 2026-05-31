#!/usr/bin/env bash
set -euo pipefail

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

if command -v firewall-cmd >/dev/null 2>&1; then
  $SUDO firewall-cmd --add-port=8000/tcp --permanent >/dev/null 2>&1 || true
  $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
fi

VM_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -z "${VM_IP:-}" ]; then
  VM_IP="127.0.0.1"
fi

BACKEND_PORT="${BACKEND_PORT:-8000}"
echo "[OK] 后端启动中..."
echo "[OK] 虚拟机访问: http://127.0.0.1:${BACKEND_PORT}/docs"
echo "[OK] 宿主机访问: http://${VM_IP}:${BACKEND_PORT}/docs"

cd "$PROJECT_ROOT/backend"
exec "$PYTHON_BIN" -m uvicorn main:app --host 0.0.0.0 --port "${BACKEND_PORT}"
