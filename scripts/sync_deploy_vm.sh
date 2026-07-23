#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 同步最新代码到 deploy/vm/（虚拟机部署目录）
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VM_DIR="$PROJECT_ROOT/deploy/vm"

cd "$PROJECT_ROOT"

echo "[*] 同步最新代码到 $VM_DIR ..."

# 删除之前生成的 vm/ 目录（用户要求）
if [ -d "$PROJECT_ROOT/vm" ]; then
    echo "[*] 删除旧的 vm/ 目录..."
    rm -rf "$PROJECT_ROOT/vm"
fi

# 确保 deploy/vm 目录存在
mkdir -p "$VM_DIR"

# 1. 同步顶层 core/ 兼容包（import core.xxx 映射到 backend/core/xxx）
if [ -d "$PROJECT_ROOT/core" ]; then
    rm -rf "$VM_DIR/core"
    cp -r "$PROJECT_ROOT/core" "$VM_DIR/"
    find "$VM_DIR/core" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
    find "$VM_DIR/core" -name "*.pyc" -delete 2>/dev/null || true
fi

# 2. 同步 backend（排除运行时上传目录和 pycache）
rm -rf "$VM_DIR/backend"
cp -r backend "$VM_DIR/"
rm -rf "$VM_DIR/backend/data/manuals"
find "$VM_DIR/backend" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
find "$VM_DIR/backend" -name "*.pyc" -delete 2>/dev/null || true

# 3. 同步 data（模型、样例、模板）
rm -rf "$VM_DIR/data"
cp -r data "$VM_DIR/"

# 4. 同步 scripts：先清空，再复制共用脚本，保留 deploy/vm 特有脚本
# 备份特有脚本
mkdir -p "$VM_DIR/scripts"
for f in install_lark_cli.sh feishu-bot.service; do
    if [ -f "$VM_DIR/scripts/$f" ]; then
        cp "$VM_DIR/scripts/$f" "$PROJECT_ROOT/tmp_${f}.bak" 2>/dev/null || true
    fi
done

rm -rf "$VM_DIR/scripts"
mkdir -p "$VM_DIR/scripts"

# 复制根目录 scripts 中的共用脚本
for f in deploy_kylin.sh \
         feishu_event_consumer.py \
         feishu_vc_event_consumer.py \
         feishu_ws_client.py \
         init_db.sql \
         start_all.sh \
         start_all_vm.sh \
         start_feishu_bot.sh \
         start_kylin.sh; do
    if [ -f "$PROJECT_ROOT/scripts/$f" ]; then
        cp "$PROJECT_ROOT/scripts/$f" "$VM_DIR/scripts/"
    fi
done

# 恢复 deploy/vm 特有脚本
for f in install_lark_cli.sh feishu-bot.service; do
    if [ -f "$PROJECT_ROOT/tmp_${f}.bak" ]; then
        mv "$PROJECT_ROOT/tmp_${f}.bak" "$VM_DIR/scripts/$f"
    elif [ -f "$PROJECT_ROOT/deploy/vm/scripts/$f" ]; then
        # 如果之前没备份（因为文件本来就在 deploy/vm/scripts），保留原文件
        cp "$PROJECT_ROOT/deploy/vm/scripts/$f" "$VM_DIR/scripts/$f" 2>/dev/null || true
    fi
done

# 清理 pycache
find "$VM_DIR/scripts" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
find "$VM_DIR/scripts" -name "*.pyc" -delete 2>/dev/null || true

# 5. 同步前端源码（dist/ 由 Dockerfile 在 VM 中构建，无需同步）
rm -rf "$VM_DIR/frontend"
mkdir -p "$VM_DIR/frontend"
for item in package.json package-lock.json index.html nginx.conf Dockerfile vite.config.js public src scripts; do
    if [ -e "$PROJECT_ROOT/frontend/$item" ]; then
        cp -r "$PROJECT_ROOT/frontend/$item" "$VM_DIR/frontend/"
    fi
done
# 排除本机 node_modules，到 VM 上再按需安装
rm -rf "$VM_DIR/frontend/node_modules"

# 6. 同步环境模板、依赖和可选的 Docker 部署文件
cp .env.example "$VM_DIR/.env.example"
if [ -f "$PROJECT_ROOT/.env.docker" ]; then
    cp "$PROJECT_ROOT/.env.docker" "$VM_DIR/.env.docker"
fi
cp requirements.txt "$VM_DIR/requirements.txt"
if [ -f "$PROJECT_ROOT/Dockerfile" ]; then
    cp "$PROJECT_ROOT/Dockerfile" "$VM_DIR/Dockerfile"
fi
if [ -f "$PROJECT_ROOT/docker-compose.yml" ]; then
    cp "$PROJECT_ROOT/docker-compose.yml" "$VM_DIR/docker-compose.yml"
fi

# 7. 同步 HTTPS 自签名证书（Docker/nginx 部署前端时需要）
if [ -d "$PROJECT_ROOT/ssl" ]; then
    rm -rf "$VM_DIR/ssl"
    cp -r "$PROJECT_ROOT/ssl" "$VM_DIR/ssl"
fi

# 8. 更新 README
cat > "$VM_DIR/README.md" <<'EOF'
# 虚拟机部署目录

这个目录是给 Linux/麒麟虚拟机准备的完整部署包，包含后端、前端源码/构建产物、RTC Bot、启动脚本和可选的 Docker 部署文件。

## 目录内容

- `backend/`：后端 API 与业务代码
- `data/`：模板、样例、模型
- `frontend/`：前端源码与构建产物（`dist/`）
- `scripts/`：启动脚本、飞书机器人脚本、数据库初始化
- `rtc_bot/`：RTC Bot C++ 源码与 SDK 压缩包
- `.env.example`：环境变量模板
- `requirements.txt`：Python 依赖
- `Dockerfile` / `docker-compose.yml`：可选的 Docker 部署文件

## 建议部署方式

1. 将整个 `deploy/vm/` 目录复制到虚拟机
2. 在虚拟机中进入该目录
3. 执行初始化脚本：

```bash
chmod +x scripts/*.sh
sudo ./scripts/deploy_kylin.sh
```

4. 编辑 `.env`
5. 启动后端：

```bash
./scripts/start_kylin.sh
```

6. （可选）一键启动后端 + 飞书事件消费者：

```bash
./scripts/start_all_vm.sh
```

## 重新同步

在项目根目录执行：

```bash
./scripts/sync_deploy_vm.sh
```

## 与本机前端配合

- 本机前端继续运行在开发机
- 手机 App 继续访问本机 `https://<电脑IP>:8443`
- 本机前端通过 `VITE_API_TARGET=http://<虚拟机IP>:8000` 访问这里的后端
EOF

echo "[OK] deploy/vm 已同步完成"
du -sh "$VM_DIR"
