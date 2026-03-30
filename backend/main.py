"""
FastAPI 应用入口
包含数据库 lifespan 管理（启动初始化、退出清理）
"""

import sys
from pathlib import Path

# 将项目根目录与 backend 目录加入 Python 路径（支持从任意目录启动）
# - 项目根：import backend.xxx
# - backend 目录：兼容 import core.xxx（core 包位于 backend/core/）
_project_root = Path(__file__).resolve().parent.parent
_backend_root = Path(__file__).resolve().parent
for _p in (_project_root, _backend_root):
    _s = str(_p)
    if _s not in sys.path:
        sys.path.insert(0, _s)

# 顶层 `core` 与 `backend.core` 指向同一包（兼容依赖或旧字节码里的 `import core.xxx`）
import backend.core

sys.modules.setdefault("core", sys.modules["backend.core"])

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api import knowledge, generate, validate, export, edit, template, feedback
from backend.api import llm
from backend.api import vision  # 视觉识别 API
from backend.core.database.connection import init_db, close_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时：初始化数据库（创建 pgvector 扩展和表结构）
    await init_db()
    print("[OK] Database initialized (pgvector + schema)")
    yield
    # 退出时：关闭连接池
    await close_db()
    print("[INFO] Database connections closed")


app = FastAPI(
    title="FaultTreeAI",
    version="2.0.0",
    description="基于知识的工业设备故障树智能生成与辅助构建系统",
    lifespan=lifespan,
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(knowledge.router, prefix="/api/knowledge", tags=["knowledge"])
app.include_router(generate.router, prefix="/api/generate", tags=["generate"])
app.include_router(validate.router, prefix="/api/validate", tags=["validate"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(edit.router, prefix="/api/edit", tags=["edit"])
app.include_router(template.router, prefix="/api/template", tags=["template"])
app.include_router(feedback.router, prefix="/api/feedback", tags=["feedback"])
app.include_router(llm.router, tags=["llm"])
app.include_router(vision.router, prefix="/api/vision", tags=["vision"])


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": "2.0.0",
        "llm_provider": "minimax",
        "vector_db": "postgresql + pgvector",
    }


@app.get("/")
def root():
    return {
        "message": "FaultTreeAI API",
        "docs": "/docs",
        "health": "/health",
    }
