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
    except Exception as e:
        print(f"⚠️  init_db 警告（不影响运行）: {e}")


async def close_db():
    """关闭连接池（应用退出时调用）"""
    await engine.dispose()
