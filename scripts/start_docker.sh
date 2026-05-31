#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

_ensure_docker_installed() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi

  echo "[*] 未检测到 docker，尝试自动安装..."
  if command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y docker docker-compose-plugin || $SUDO dnf install -y docker || true
  elif command -v apt >/dev/null 2>&1; then
    $SUDO apt update
    $SUDO apt install -y docker.io docker-compose-plugin || $SUDO apt install -y docker.io || true
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "[错误] docker 安装失败或未加入 PATH，请手动安装后再运行。"
    exit 1
  fi
}

_start_docker_daemon() {
  if command -v systemctl >/dev/null 2>&1; then
    echo "[*] 启动 Docker（systemd）..."
    $SUDO systemctl enable docker >/dev/null 2>&1 || true
    $SUDO systemctl start docker >/dev/null 2>&1 || true
    $SUDO systemctl enable docker.service >/dev/null 2>&1 || true
    $SUDO systemctl start docker.service >/dev/null 2>&1 || true
  fi

  if docker info >/dev/null 2>&1; then
    return 0
  fi

  if command -v dockerd >/dev/null 2>&1; then
    echo "[*] 启动 Docker（dockerd 后台）..."
    $SUDO nohup dockerd >/tmp/dockerd.log 2>&1 &
    sleep 2
  fi
}

DOCKER_BIN="docker"
DOCKER_SUDO=""
DOCKER_CONFIG_DIR="${HOME:-/root}/.docker"

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

_ensure_docker_installed
_start_docker_daemon

if ! _select_docker_cli; then
  echo "[错误] 无法连接到 Docker。可能原因：Docker daemon 未启动，或当前用户无权限访问 /var/run/docker.sock。"
  echo "      建议先执行：sudo systemctl start docker"
  echo "      若仍提示 permission denied：sudo usermod -aG docker $USER 后重新登录，或改用 sudo docker ..."
  exit 1
fi

_ensure_compose() {
  if command -v docker-compose >/dev/null 2>&1; then
    return 0
  fi
  if [ -x "${DOCKER_CONFIG_DIR}/cli-plugins/docker-compose" ]; then
    :
  fi
  if $DOCKER_SUDO DOCKER_CONFIG="$DOCKER_CONFIG_DIR" $DOCKER_BIN compose version >/dev/null 2>&1; then
    return 0
  fi

  echo "[*] 未检测到 docker compose，尝试自动安装..."
  if command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y docker-compose-plugin || $SUDO dnf install -y docker-compose || true
  elif command -v apt >/dev/null 2>&1; then
    $SUDO apt update
    $SUDO apt install -y docker-compose-plugin || $SUDO apt install -y docker-compose || true
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    return 0
  fi
  if $DOCKER_SUDO DOCKER_CONFIG="$DOCKER_CONFIG_DIR" $DOCKER_BIN compose version >/dev/null 2>&1; then
    return 0
  fi

  echo "[错误] 未检测到 docker compose。请安装 docker-compose-plugin 或 docker-compose。"
  exit 1
}

export DB_PASSWORD="${DB_PASSWORD:-faulttree123}"

if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[提示] 未检测到 OPENAI_API_KEY（百度千帆）。"
  echo "      你可以在运行前临时注入："
  echo "      export OPENAI_API_KEY=xxx"
fi

mkdir -p data/manuals data/chroma_db || true

_ensure_compose

if command -v docker-compose >/dev/null 2>&1; then
  $SUDO docker-compose up -d --build
else
  $DOCKER_SUDO DOCKER_CONFIG="$DOCKER_CONFIG_DIR" $DOCKER_BIN compose up -d --build
fi

VM_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -z "${VM_IP:-}" ]; then
  VM_IP="127.0.0.1"
fi

echo "[OK] 已启动：db(5432) / backend(8000) / frontend(5173)"
echo "[OK] 前端：http://${VM_IP}:5173"
echo "[OK] 后端：http://${VM_IP}:8000/docs"
