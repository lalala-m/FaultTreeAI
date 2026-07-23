#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/frontend/dist"

SUDO=""
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  SUDO="sudo"
fi

# 1. 检查前端 dist
echo "[*] 检查前端构建产物：$DIST_DIR"
if [ ! -d "$DIST_DIR" ]; then
  echo "[!] 未找到前端构建产物。请在本地构建后传到 VM，或在 VM 上执行："
  echo "    cd $PROJECT_ROOT/frontend && npm install && npm run build"
  exit 1
fi

# 2. 修复 connection.py 中的 QueuePool 问题（如果 VM 上的代码还没更新）
CONN_PY="$PROJECT_ROOT/backend/core/database/connection.py"
if [ -f "$CONN_PY" ] && grep -q "QueuePool" "$CONN_PY"; then
  echo "[*] 修复 $CONN_PY 中的连接池..."
  sed -i 's/from sqlalchemy.pool import NullPool, QueuePool/from sqlalchemy.pool import NullPool, AsyncAdaptedQueuePool/' "$CONN_PY"
  sed -i 's/_pool_class = NullPool if _is_windows else QueuePool/_pool_class = NullPool if _is_windows else AsyncAdaptedQueuePool/' "$CONN_PY"
  echo "[OK] 已修复"
fi

# 3. 检查后端是否已启动
if ! curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
  echo "[!] 后端未在 127.0.0.1:8000 响应。请先启动后端："
  echo "    cd $PROJECT_ROOT && ./scripts/start_kylin.sh"
  exit 1
fi

# 4. 安装 Nginx
echo "[*] 检查 Nginx..."
if ! command -v nginx >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    echo "[*] 使用 dnf 安装 Nginx..."
    $SUDO dnf install -y nginx
  elif command -v apt >/dev/null 2>&1; then
    echo "[*] 使用 apt 安装 Nginx..."
    $SUDO apt update
    $SUDO apt install -y nginx
  else
    echo "[错误] 找不到 dnf 或 apt，无法安装 Nginx。"
    exit 1
  fi
else
  echo "[OK] Nginx 已安装"
fi

# 5. 写入 Nginx 配置
CONF_FILE="/etc/nginx/conf.d/faulttree.conf"
echo "[*] 写入 Nginx 配置：$CONF_FILE"
$SUDO tee "$CONF_FILE" >/dev/null <<EOF
server {
    listen 80;
    server_name _;

    root $DIST_DIR;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

# 6. 启动/重载 Nginx
$SUDO nginx -t
if $SUDO systemctl is-active nginx >/dev/null 2>&1; then
  echo "[*] 重载 Nginx..."
  $SUDO systemctl reload nginx
else
  echo "[*] 启动 Nginx..."
  $SUDO systemctl start nginx
  $SUDO systemctl enable nginx
fi

# 7. 防火墙放行
if command -v firewall-cmd >/dev/null 2>&1; then
  echo "[*] 放行 80/8000 端口..."
  $SUDO firewall-cmd --add-port=80/tcp --permanent >/dev/null 2>&1 || true
  $SUDO firewall-cmd --add-port=8000/tcp --permanent >/dev/null 2>&1 || true
  $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
fi

VM_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"
echo ""
echo "========================================"
echo "[OK] 前端已通过 Nginx 启动"
echo "[OK] 访问地址：http://$VM_IP/"
echo "========================================"
