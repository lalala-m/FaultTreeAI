
#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "========================================"
echo "  故障检修系统 一键启动"
echo "========================================"
echo ""

# 检测 Docker Compose 命令
if command -v docker-compose &>/dev/null; then
    DOCKER_COMPOSE="docker-compose"
elif docker compose version &>/dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    echo "[错误] 未找到 Docker Compose！"
    echo "请先安装 Docker 和 Docker Compose"
    exit 1
fi

echo "[OK] 使用: $DOCKER_COMPOSE"
echo ""

# 检查是否存在 .env 文件
if [ ! -f ".env" ]; then
    echo "[提示] 未找到 .env 文件，正在从 .env.example 创建..."
    cp ".env.example" ".env"
    echo ""
    echo "[!] 请编辑 .env 文件配置您的 API 密钥！"
    echo ""
fi

# 检查 SSL 证书
if [ ! -f "ssl/cert.pem" ]; then
    echo "[提示] 未找到 SSL 证书，正在生成..."
    python3 tools/generate_cert.py
    echo ""
fi

echo "[*] 正在启动服务..."
echo ""

# 启动 Docker Compose
$DOCKER_COMPOSE up -d --build

VM_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -z "${VM_IP:-}" ]; then
    VM_IP="127.0.0.1"
fi

echo ""
echo "========================================"
echo "  启动完成！"
echo "========================================"
echo ""
echo "访问地址："
echo "  - HTTP (浏览器): http://localhost:5173"
echo "  - HTTPS (App): https://${VM_IP}:8443"
echo "  - API 文档: http://localhost:8000/docs"
echo ""
echo "查看日志: $DOCKER_COMPOSE logs -f"
echo "停止服务: $DOCKER_COMPOSE down"
echo ""

