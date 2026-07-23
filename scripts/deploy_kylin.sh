#!/bin/bash

# 故障检修系统 银河麒麟/Linux 自动化部署脚本
# 适用环境: 银河麒麟 V10 / Ubuntu / Debian

set -e

echo "==========================================="
echo "   故障检修系统 自动化部署工具 (Kylin/Linux)"
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
    apt install -y git build-essential cmake python3 python3-dev python3-pip python3-venv \
                   libpq-dev nodejs npm postgresql postgresql-contrib \
                   libgl1-mesa-glx libglib2.0-0 curl ffmpeg
elif command -v dnf &> /dev/null; then
    dnf update -y
    dnf install -y git gcc gcc-c++ cmake make python3 python3-devel python3-pip \
                   postgresql-devel nodejs npm mesa-libGL glib2-devel curl ffmpeg
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

# 5. 配置后端虚拟环境（先进入项目根目录）
echo "[*] 正在配置后端虚拟环境..."
# 脚本假设在项目根目录运行
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# 6. 编译 RTC AI Bot（C++ Linux SDK）
# 注意：以下步骤编号保持 6，原步骤 6 改为 7
echo "[*] 正在准备 RTC AI Bot..."
RTC_BOT_DIR="$SCRIPT_DIR/../deploy/vm/rtc_bot"
if [ -d "$RTC_BOT_DIR" ]; then
    cd "$RTC_BOT_DIR"

    if [ ! -d "sdk" ]; then
        SDK_ZIP=$(ls -1 BytePlusRTC_Linux_*.zip 2>/dev/null | head -n1 || true)
        if [ -z "$SDK_ZIP" ]; then
            echo "[*] 未找到本地 SDK zip，尝试从官方链接下载..."
            SDK_URL="https://p9-arcosite.byteimg.com/obj/tos-cn-i-goo7wpa0wc/6f63cec654a14cea94fdb4111e21e37c"
            SDK_ZIP="BytePlusRTC_Linux_3.60.104.1400_x86_64.zip"
            if curl -fsSL "$SDK_URL" -o "$SDK_ZIP"; then
                echo "[✓] SDK 下载成功"
            else
                echo "[!] SDK 下载失败。请手动下载 BytePlusRTC Linux SDK x86_64 zip 并放到 $RTC_BOT_DIR 目录下，然后重新运行部署脚本。"
                SDK_ZIP=""
            fi
        fi
        if [ -n "$SDK_ZIP" ] && [ -f "$SDK_ZIP" ]; then
            unzip -q "$SDK_ZIP" -d sdk_temp
            SDK_INNER=$(find sdk_temp -maxdepth 2 -name "include" -type d | head -n1 | xargs dirname 2>/dev/null || true)
            if [ -n "$SDK_INNER" ]; then
                mv "$SDK_INNER" sdk
            else
                mv sdk_temp sdk
            fi
            rm -rf sdk_temp
        fi
    fi

    if [ -d "sdk" ]; then
        mkdir -p build
        cd build
        if cmake .. && make -j$(nproc); then
            echo "[✓] librtc_bot.so 编译成功"
            if [ -d "$(pwd)/../sdk/lib" ]; then
                echo "$(pwd)/../sdk/lib" > /etc/ld.so.conf.d/rtc_bot.conf
                ldconfig
            fi
        else
            echo "[!] librtc_bot.so 编译失败，RTC AI Bot 功能不可用，但后端服务仍可启动。"
        fi
    else
        echo "[!] 未找到 RTC SDK，跳过 Bot 编译。如需启用 AI Bot，请准备 SDK 后重新运行此脚本。"
    fi
    cd "$SCRIPT_DIR/.."
else
    echo "[!] 未找到 rtc_bot 目录，跳过 Bot 编译"
fi

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

# 7. 配置前端环境
echo "[*] 正在安装前端依赖并构建..."
cd frontend
npm install --registry=https://registry.npmmirror.com
npm run build

# 8. 生成 .env 文件
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
