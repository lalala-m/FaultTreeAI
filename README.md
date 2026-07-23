# 故障检修系统

基于知识驱动与多模型推理的工业设备故障树智能诊断系统。

## GitHub 项目描述（可直接用于仓库简介）

故障检修系统是一个面向工业场景的 FTA（Fault Tree Analysis）智能系统，集成 RAG 知识检索、结构化故障树生成、MOCUS 最小割集与 Birnbaum 重要度分析，并支持 Ollama / MiniMax 多模型可切换与自动回退，适合本地离线开发与竞赛/生产演示。

**关键词**：`FastAPI` `React` `RAG` `pgvector` `Ollama` `MiniMax` `FTA` `MOCUS` `Fault Tree`

## 核心能力

- **RAG 知识库**：上传设备手册、维修日志等文档，系统自动解析分块并向量化存入 PostgreSQL 向量库
- **智能生成**：基于 MiniMax 大模型 + RAG 检索，自动生成符合 IEC 61025 / GB/T 7829 规范的故障树
- **FTA 算法**：内置 MOCUS 最小割集算法、Birnbaum 结构重要度分析
- **三层校验**：自动检测循环依赖、孤立节点、逻辑门错误，保证故障树结构正确
- **专家辅助**：前端可视化编辑，支持手动调整并更新知识库

## 技术栈

| 层级 | 技术 |
|------|------|
| LLM | MiniMax M2（外部 API） |
| Embedding | MiniMax embo-01 |
| 向量数据库 | PostgreSQL 18 + pgvector |
| RAG 框架 | LangChain 0.3.x |
| 后端 | FastAPI + SQLAlchemy（异步） |
| 图计算 | NetworkX（MOCUS、Birnbaum） |
| 前端 | React + ReactFlow + Ant Design |

## 项目结构

```
故障检修系统/
├── backend/
│   ├── api/                    # API 路由
│   │   ├── knowledge.py        # 文档上传 / 列表 / 删除
│   │   ├── generate.py         # 故障树生成
│   │   ├── validate.py         # 逻辑校验
│   │   └── export.py           # Word 报告导出
│   ├── core/
│   │   ├── database/           # PostgreSQL 连接 + ORM 模型
│   │   ├── llm/                # LLM 客户端 + 结构化生成器
│   │   ├── rag/                # PostgreSQL 向量检索
│   │   ├── fta/                # MOCUS、最小割集、重要度
│   │   ├── validator/          # 三层逻辑校验
│   │   └── parser/             # PDF/TXT/DOCX 文档解析
│   ├── models/                 # Pydantic 数据模型
│   ├── main.py                 # FastAPI 入口
│   └── config.py               # 环境配置
├── frontend/                   # React 前端（规划中）
├── scripts/
│   └── init_db.sql             # PostgreSQL Schema
├── docs/
│   └── 技术方案.md
├── requirements.txt
└── README.md
```

## 快速开始

### 1. 环境准备

**PostgreSQL 18 + pgvector**

下载安装：https://www.postgresql.org/download/windows/

```bash
# 创建数据库
psql -U postgres -c "CREATE DATABASE faulttree;"

# 初始化 Schema
psql -U postgres -d faulttree -f scripts/init_db.sql
```

**Python 环境**

```bash
conda create -n faulttree python=3.11
conda activate faulttree
pip install -r requirements.txt
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入以下内容：
```

| 变量 | 说明 |
|------|------|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` | PostgreSQL 连接信息 |
| `MINIMAX_API_KEY` | MiniMax API Key（从 https://platform.minimax.io 获取） |
| `MINIMAX_GROUP_ID` | MiniMax Group ID |
| `LLM_PROVIDER` | `minimax`（默认，可切换 openai / anthropic / azure_openai） |

### 3. 启动服务

```bash
# 后端
cd backend
uvicorn main:app --reload --port 8000

# 前端（另开终端）
cd frontend
npm install
npm run dev
```

访问 http://localhost:5173

### 4. 手机 App 本地 HTTPS 代理（8443）

当 Android App 需要通过 `https://<电脑IP>:8443` 访问前端，以启用 WebView 内的摄像头、麦克风和音视频通话能力时，可使用前端自带的本地 HTTPS 代理。

先在项目根目录 `.env` 中设置后端地址：

```bash
VITE_API_TARGET=http://<Linux虚拟机IP>:8000
```

然后启动前端 HTTPS 开发入口：

```bash
cd frontend
npm install
npm run dev:https
```

默认行为：

- `https://<电脑IP>:8443` -> 代理到前端 Vite 开发服务 `http://127.0.0.1:5173`
- `/api`、`/ws`、`/docs` -> 代理到 `VITE_API_TARGET`
- HTTPS 证书默认读取项目根目录 `ssl/cert.pem` 和 `ssl/key.pem`

可选环境变量：

- `HTTPS_PROXY_PORT`：本地 HTTPS 代理端口，默认 `8443`
- `VITE_DEV_TARGET`：前端开发服务地址，默认 `http://127.0.0.1:5173`
- `HTTPS_PROXY_API_TARGET`：覆盖 `.env` 中的 `VITE_API_TARGET`
- `HTTPS_PROXY_CERT` / `HTTPS_PROXY_KEY`：自定义证书路径

## 虚拟机部署

本项目支持将后端单独部署到 Linux/麒麟虚拟机，本机只跑前端和手机 App。

**所有需要同步到虚拟机的文件都收敛在 `deploy/vm/` 目录。**

### 准备部署包

在项目根目录执行：

```bash
./scripts/sync_deploy_vm.sh
```

该脚本会把 `backend/`、`data/`、`scripts/`、`.env.example`、`requirements.txt`、`rtc_bot/` 等同步到 `deploy/vm/`。

### 同步到虚拟机

```bash
# 备份 VM 上的 .env
ssh wcd@192.168.222.135 "cd /home/wcd/故障检修系统 && cp .env .env.bak.$(date +%Y%m%d%H%M%S)"

# 同步整个 deploy/vm/ 到虚拟机
rsync -avz --delete deploy/vm/ wcd@192.168.222.135:/home/wcd/故障检修系统/
```

### 在虚拟机上启动

```bash
ssh wcd@192.168.222.135
cd /home/wcd/故障检修系统
cp .env.example .env
# 编辑 .env 填入真实 API Key
./scripts/start_kylin.sh
```

详细说明见 `deploy/vm/README.md`。

## API 文档

启动服务后访问 http://localhost:8000/docs

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/knowledge/upload` | POST | 上传设备文档（PDF/TXT/DOCX） |
| `/api/knowledge/list` | GET | 列出已上传文档 |
| `/api/knowledge/stats` | GET | 系统统计信息 |
| `/api/generate/` | POST | 生成故障树 |
| `/api/validate/` | POST | 校验故障树逻辑 |
| `/api/export/word` | POST | 导出 Word 报告 |
| `/health` | GET | 健康检查 |

## 知识库构建建议

故障树生成质量高度依赖知识库。推荐按以下优先级构建：

1. **设备手册**：厂家操作手册、维修手册（PDF）
2. **维修工单**：真实故障记录（整理为结构化文本）
3. **FMEA 表格**：设备故障模式与影响分析表
4. **行业标准**：GB/T 7829、IEC 61025 等规范文本
5. **历史故障树**：经专家审核的高质量样本

## 注意事项

- 首次上传文档后，向量入库需要几秒到几十秒（取决于文档大小）
- MiniMax embo-01 向量维度为 1024，与 PostgreSQL `VECTOR(1024)` 必须一致
- 故障树生成涉及外部 API 调用，响应时间约 10-60 秒
