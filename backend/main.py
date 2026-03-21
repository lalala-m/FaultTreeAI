"""
FastAPI 应用入口
包含数据库 lifespan 管理（启动初始化、退出清理）
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import knowledge, generate, validate, export
from core.database.connection import init_db, close_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时：初始化数据库（创建 pgvector 扩展和表结构）
    await init_db()
    print("✅ 数据库初始化完成（pgvector + 表结构）")
    yield
    # 退出时：关闭连接池
    await close_db()
    print("🔌 数据库连接已关闭")


app = FastAPI(
    title="FaultTreeAI",
    version="2.0.0",
    description="基于知识的工业设备故障树智能生成与辅助构建系统",
    lifespan=lifespan,
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(knowledge.router, prefix="/api/knowledge", tags=["knowledge"])
app.include_router(generate.router, prefix="/api/generate", tags=["generate"])
app.include_router(validate.router, prefix="/api/validate", tags=["validate"])
app.include_router(export.router, prefix="/api/export", tags=["export"])


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
