#!/bin/bash

# FaultTreeAI 银河麒麟/Linux 自动化部署脚本
# 适用环境: 银河麒麟 V10 / Ubuntu / Debian

set -e

echo "==========================================="
echo "   FaultTreeAI 自动化部署工具 (Kylin/Linux)"
echo "==========================================="

# 1. 检查权限
if [ "$EUID" -ne 0 ]; then 
  echo "请使用 sudo 运行此脚本: sudo ./deploy_kylin.sh"
  exit 1
fi

# 2. 安装系统依赖
echo "[*] 正在安装系统依赖..."
if command -v apt &> /dev/null; then
    apt update
    apt install -y git build-essential python3 python3-dev python3-pip python3-venv \
                   libpq-dev nodejs npm postgresql postgresql-contrib \
                   libgl1-mesa-glx libglib2.0-0 curl
elif command -v dnf &> /dev/null; then
    dnf update -y
    dnf install -y git gcc gcc-c++ make python3 python3-devel python3-pip \
                   postgresql-devel nodejs npm mesa-libGL glib2-devel curl
else
    echo "[错误] 找不到支持的包管理器 (apt 或 dnf)。请手动安装依赖。"
    exit 1
fi

# 确认 python3 是否安装成功
if ! command -v python3 &> /dev/null; then
    echo "[错误] python3 安装失败，请检查网络或软件源。"
    exit 1
fi

# 3. 检查并安装 Docker (用于运行 pgvector)
if ! command -v docker &> /dev/null; then
    echo "[*] 正在安装 Docker..."
    curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun
fi

systemctl start docker
systemctl enable docker

# 4. 启动 pgvector 数据库
echo "[*] 正在启动 pgvector 数据库容器..."
# 检查容器是否存在
if [ ! "$(docker ps -a -q -f name=faulttree-db)" ]; then
    docker run -d \
      --name faulttree-db \
      -p 5432:5432 \
      -e POSTGRES_PASSWORD=faulttree123 \
      -v pgdata:/var/lib/postgresql/data \
      --restart always \
      docker.m.daocloud.io/pgvector/pgvector:pg16
else
    echo "[!] 数据库容器已存在，正在启动..."
    docker start faulttree-db
fi

# 5. 配置后端虚拟环境
echo "[*] 正在配置后端虚拟环境..."
# 脚本假设在项目根目录运行
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

if [ ! -d ".venv" ]; then
    if python3 -m venv .venv; then
        :
    else
        if command -v dnf &> /dev/null; then
            dnf install -y python3-virtualenv || true
        fi
        python3 -m virtualenv .venv
    fi
fi
source .venv/bin/activate
pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 6. 配置前端环境
echo "[*] 正在安装前端依赖并构建..."
cd frontend
npm install --registry=https://registry.npmmirror.com
npm run build

# 7. 生成 .env 文件
cd ..
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "" >> .env
    echo "DATABASE_URL=postgresql+asyncpg://postgres:faulttree123@localhost:5432/postgres" >> .env
    echo "[!] .env 文件已生成，请编辑并填入您的 AI 密钥"
fi

echo ""
echo "==========================================="
echo "   部署完成！"
echo "==========================================="
echo "下一步操作指引："
echo "1. 编辑项目根目录下的 .env 文件，填入您的 MINIMAX_API_KEY 等配置。"
echo "2. 启动后端服务："
echo "   source .venv/bin/activate"
echo "   cd backend"
echo "   uvicorn main:app --host 0.0.0.0 --port 8000"
echo "3. 访问系统：打开浏览器访问 http://localhost:5173 (开发模式) 或部署 frontend/dist"
echo "==========================================="
