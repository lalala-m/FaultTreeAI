# FaultTreeAI Backend Dockerfile
FROM python:3.11-slim

WORKDIR /app

# 同时识别 backend 包（/app）与 legacy 的顶层 core 包（/app/backend/core）
ENV PYTHONPATH=/app:/app/backend

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY requirements.txt .

# 安装 Python 依赖
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码（core/ 为顶层 import core 的兼容入口，见 core/__init__.py）
COPY core/ ./core/
COPY backend/ ./backend/
COPY scripts/ ./scripts/
COPY data/ ./data/

# 复制配置文件
COPY .env.docker ./.env

# 暴露端口
EXPOSE 8000

# 启动命令
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
