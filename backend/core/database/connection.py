"""
PostgreSQL + SQLAlchemy 异步连接管理
支持 psycopg2（同步）和 asyncpg（异步）两种驱动
"""

from contextlib import asynccontextmanager, contextmanager
from typing import Optional
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


# ─────────────────────────────────────────────
# 同步 psycopg2 连接（用于绕过 asyncpg 问题）
# ─────────────────────────────────────────────

_pg_conn_cache: Optional[object] = None


def pg_conn():
    """
    获取 psycopg2 连接（兼容旧代码）
    返回一个 context manager
    """
    import psycopg2
    return psycopg2.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        user=settings.DB_USER,
        password=settings.DB_PASSWORD,
        database=settings.DB_NAME,
        connect_timeout=10,
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
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
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
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS knowledge_graph_cache (
                    line VARCHAR(120) PRIMARY KEY,
                    graph_json JSONB NOT NULL,
                    doc_count INTEGER NOT NULL DEFAULT 0,
                    device_count INTEGER NOT NULL DEFAULT 0,
                    fault_count INTEGER NOT NULL DEFAULT 0,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_graph_cache_updated_at
                ON knowledge_graph_cache(updated_at DESC)
            """))
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS knowledge_items (
                    item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    pipeline VARCHAR(64) NOT NULL DEFAULT '流水线1',
                    machine_category VARCHAR(120) NOT NULL DEFAULT '',
                    machine VARCHAR(160) NOT NULL DEFAULT '',
                    problem_category VARCHAR(120) NOT NULL DEFAULT '',
                    problem TEXT NOT NULL,
                    root_cause TEXT NOT NULL DEFAULT '',
                    solution TEXT NOT NULL DEFAULT '',
                    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_items_pipeline
                ON knowledge_items(pipeline)
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_items_machine
                ON knowledge_items(machine)
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_items_problem_category
                ON knowledge_items(problem_category)
            """))
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS knowledge_item_embeddings (
                    embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    item_id UUID NOT NULL REFERENCES knowledge_items(item_id) ON DELETE CASCADE UNIQUE,
                    embedding VECTOR(1024),
                    model_name VARCHAR(50) NOT NULL DEFAULT 'embo-01',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_item_embeddings_hnsw
                ON knowledge_item_embeddings USING hnsw (embedding vector_cosine_ops)
                WITH (m = 16, ef_construction = 64)
            """))
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS knowledge_item_weights (
                    item_id UUID PRIMARY KEY REFERENCES knowledge_items(item_id) ON DELETE CASCADE,
                    helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                    misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                    feedback_count INTEGER NOT NULL DEFAULT 0,
                    current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_knowledge_item_weights_weight
                ON knowledge_item_weights(current_weight DESC)
            """))
    except Exception as e:
        print(f"[WARN] init_db warning (non-critical): {e}")


async def close_db():
    """关闭连接池（应用退出时调用）"""
    await engine.dispose()
