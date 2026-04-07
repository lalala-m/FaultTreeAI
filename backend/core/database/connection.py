"""
PostgreSQL + SQLAlchemy 异步连接管理
支持 psycopg2（同步）和 asyncpg（异步）两种驱动
"""

from contextlib import asynccontextmanager
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy.pool import NullPool
from sqlalchemy import text
from backend.config import settings

Base = declarative_base()

# Windows 上 asyncpg + QueuePool 有兼容性问题，改用 NullPool
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    poolclass=NullPool,
    connect_args={
        "timeout": 30,
        "command_timeout": 60,
    },
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)


async def get_db() -> AsyncSession:
    """FastAPI 依赖注入：每个请求获得一个独立的数据库会话"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


@asynccontextmanager
async def get_db_context() -> AsyncSession:
    """非 FastAPI 上下文中使用（如后台任务）"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    """启动时初始化：创建 pgvector 扩展（表已在 SQL 中定义，启动时跳过 create_all）"""
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS knowledge_doc_weights (
                    doc_id UUID PRIMARY KEY REFERENCES documents(doc_id) ON DELETE CASCADE,
                    helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                    misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                    feedback_count INTEGER NOT NULL DEFAULT 0,
                    current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS knowledge_chunk_weights (
                    chunk_id UUID PRIMARY KEY REFERENCES document_chunks(chunk_id) ON DELETE CASCADE,
                    doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
                    helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                    misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                    feedback_count INTEGER NOT NULL DEFAULT 0,
                    current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_weights_doc_id
                ON knowledge_chunk_weights(doc_id)
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_doc_weights_weight
                ON knowledge_doc_weights(current_weight DESC)
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_weights_weight
                ON knowledge_chunk_weights(current_weight DESC)
            """))
    except Exception as e:
        print(f"[WARN] init_db warning (non-critical): {e}")


async def close_db():
    """关闭连接池（应用退出时调用）"""
    await engine.dispose()
