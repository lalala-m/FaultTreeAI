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

import platform
from sqlalchemy.pool import NullPool, AsyncAdaptedQueuePool

Base = declarative_base()

# Windows 上 asyncpg + 连接池有兼容性问题，改用 NullPool
# Linux / Docker 环境使用 AsyncAdaptedQueuePool 复用连接，降低连接创建开销与内存碎片
_is_windows = platform.system().lower() == "windows"
_pool_class = NullPool if _is_windows else AsyncAdaptedQueuePool
_pool_kwargs = (
    {}
    if _is_windows
    else {
        "pool_size": 5,
        "max_overflow": 10,
        "pool_recycle": 3600,
        "pool_pre_ping": True,
    }
)

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    poolclass=_pool_class,
    connect_args={
        "timeout": 30,
        "command_timeout": 60,
    },
    **_pool_kwargs,
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


async def _table_exists(conn, table_name: str) -> bool:
    """检查表是否存在。"""
    result = await conn.execute(
        text("SELECT to_regclass(:name) IS NOT NULL"),
        {"name": table_name},
    )
    row = result.fetchone()
    return bool(row and row[0])


async def _safe_execute(conn, sql: str, label: str = "") -> None:
    """在 SAVEPOINT 中执行 SQL，失败时回滚到 SAVEPOINT，不影响外层事务。"""
    try:
        async with conn.begin_nested():
            await conn.execute(text(sql))
    except Exception as e:
        prefix = f"[{label}] " if label else ""
        print(f"[WARN] init_db warning (non-critical): {prefix}{e}")


async def init_db():
    """启动时初始化：创建 pgvector 扩展及代码所需的辅助表。"""
    async with engine.begin() as conn:
        # 核心扩展
        await _safe_execute(conn, "CREATE EXTENSION IF NOT EXISTS vector", "extension")
        await _safe_execute(conn, "CREATE EXTENSION IF NOT EXISTS pgcrypto", "extension")

        # 依赖 documents / document_chunks 的表
        has_documents = await _table_exists(conn, "documents")
        has_document_chunks = await _table_exists(conn, "document_chunks")

        if has_documents:
            await _safe_execute(
                conn,
                """
                    CREATE TABLE IF NOT EXISTS knowledge_doc_weights (
                        doc_id UUID PRIMARY KEY REFERENCES documents(doc_id) ON DELETE CASCADE,
                        helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        feedback_count INTEGER NOT NULL DEFAULT 0,
                        current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """,
                "knowledge_doc_weights",
            )
            await _safe_execute(
                conn,
                "CREATE INDEX IF NOT EXISTS idx_knowledge_doc_weights_weight ON knowledge_doc_weights(current_weight DESC)",
                "knowledge_doc_weights_index",
            )

        if has_documents and has_document_chunks:
            await _safe_execute(
                conn,
                """
                    CREATE TABLE IF NOT EXISTS knowledge_chunk_weights (
                        chunk_id UUID PRIMARY KEY REFERENCES document_chunks(chunk_id) ON DELETE CASCADE,
                        doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
                        helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        feedback_count INTEGER NOT NULL DEFAULT 0,
                        current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """,
                "knowledge_chunk_weights",
            )
            await _safe_execute(
                conn,
                "CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_weights_doc_id ON knowledge_chunk_weights(doc_id)",
                "knowledge_chunk_weights_doc_id_index",
            )
            await _safe_execute(
                conn,
                "CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_weights_weight ON knowledge_chunk_weights(current_weight DESC)",
                "knowledge_chunk_weights_weight_index",
            )

        # 不依赖 documents 的表，使用 SAVEPOINT 隔离每条语句
        statements = [
            (
                "knowledge_graph_cache",
                """
                    CREATE TABLE IF NOT EXISTS knowledge_graph_cache (
                        line VARCHAR(120) PRIMARY KEY,
                        graph_json JSONB NOT NULL,
                        doc_count INTEGER NOT NULL DEFAULT 0,
                        device_count INTEGER NOT NULL DEFAULT 0,
                        fault_count INTEGER NOT NULL DEFAULT 0,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """,
            ),
            (
                "knowledge_graph_cache_index",
                "CREATE INDEX IF NOT EXISTS idx_knowledge_graph_cache_updated_at ON knowledge_graph_cache(updated_at DESC)",
            ),
            (
                "knowledge_items",
                """
                    CREATE TABLE IF NOT EXISTS knowledge_items (
                        item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        pipeline VARCHAR(64) NOT NULL DEFAULT '流水线1',
                        machine_category VARCHAR(120) NOT NULL DEFAULT '',
                        machine VARCHAR(160) NOT NULL DEFAULT '',
                        problem_category VARCHAR(120) NOT NULL DEFAULT '',
                        problem TEXT NOT NULL DEFAULT '',
                        root_cause TEXT NOT NULL DEFAULT '',
                        solution TEXT NOT NULL DEFAULT '',
                        -- 维修作业类专用字段（方案 2）
                        knowledge_type VARCHAR(32) NOT NULL DEFAULT 'fault',
                        operation_category VARCHAR(120) NOT NULL DEFAULT '',
                        operation_item TEXT NOT NULL DEFAULT '',
                        operation_steps TEXT NOT NULL DEFAULT '',
                        check_standard TEXT NOT NULL DEFAULT '',
                        precautions TEXT NOT NULL DEFAULT '',
                        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                        status VARCHAR(20) NOT NULL DEFAULT 'active',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """,
            ),
            # 旧表迁移：每条 ALTER 独立执行，避免 asyncpg 不支持多命令 prepared statement
            ("knowledge_items_add_knowledge_type", "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS knowledge_type VARCHAR(32) NOT NULL DEFAULT 'fault'"),
            ("knowledge_items_add_operation_category", "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS operation_category VARCHAR(120) NOT NULL DEFAULT ''"),
            ("knowledge_items_add_operation_item", "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS operation_item TEXT NOT NULL DEFAULT ''"),
            ("knowledge_items_add_operation_steps", "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS operation_steps TEXT NOT NULL DEFAULT ''"),
            ("knowledge_items_add_check_standard", "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS check_standard TEXT NOT NULL DEFAULT ''"),
            ("knowledge_items_add_precautions", "ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS precautions TEXT NOT NULL DEFAULT ''"),
            (
                "knowledge_items_pipeline_index",
                "CREATE INDEX IF NOT EXISTS idx_knowledge_items_pipeline ON knowledge_items(pipeline)",
            ),
            (
                "knowledge_items_machine_index",
                "CREATE INDEX IF NOT EXISTS idx_knowledge_items_machine ON knowledge_items(machine)",
            ),
            (
                "knowledge_items_problem_category_index",
                "CREATE INDEX IF NOT EXISTS idx_knowledge_items_problem_category ON knowledge_items(problem_category)",
            ),
            (
                "knowledge_items_operation_category_index",
                "CREATE INDEX IF NOT EXISTS idx_knowledge_items_operation_category ON knowledge_items(operation_category)",
            ),
            (
                "knowledge_item_embeddings",
                """
                    CREATE TABLE IF NOT EXISTS knowledge_item_embeddings (
                        embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        item_id UUID NOT NULL REFERENCES knowledge_items(item_id) ON DELETE CASCADE UNIQUE,
                        embedding VECTOR(1024),
                        model_name VARCHAR(50) NOT NULL DEFAULT 'embo-01',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """,
            ),
            (
                "knowledge_item_embeddings_hnsw",
                "CREATE INDEX IF NOT EXISTS idx_knowledge_item_embeddings_hnsw ON knowledge_item_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)",
            ),
            (
                "knowledge_item_weights",
                """
                    CREATE TABLE IF NOT EXISTS knowledge_item_weights (
                        item_id UUID PRIMARY KEY REFERENCES knowledge_items(item_id) ON DELETE CASCADE,
                        helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        feedback_count INTEGER NOT NULL DEFAULT 0,
                        current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                        expert_weight DOUBLE PRECISION,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """,
            ),
            (
                "knowledge_item_weights_expert_weight",
                "ALTER TABLE knowledge_item_weights ADD COLUMN IF NOT EXISTS expert_weight DOUBLE PRECISION",
            ),
            (
                "knowledge_item_weights_index",
                "CREATE INDEX IF NOT EXISTS idx_knowledge_item_weights_weight ON knowledge_item_weights(current_weight DESC)",
            ),
            (
                "clarify_cache",
                """
                    CREATE TABLE IF NOT EXISTS clarify_cache (
                        id SERIAL PRIMARY KEY,
                        top_event TEXT NOT NULL UNIQUE,
                        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
                        raw_intro TEXT,
                        refined_query_hint TEXT,
                        provider VARCHAR(100),
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                """,
            ),
            (
                "clarify_cache_index",
                "CREATE INDEX IF NOT EXISTS idx_clarify_cache_top_event ON clarify_cache(top_event)",
            ),
        ]

        # diagnosis_cases 依赖 fault_trees，单独处理
        has_fault_trees = await _table_exists(conn, "fault_trees")
        if has_fault_trees:
            statements.extend(
                [
                    (
                        "diagnosis_cases",
                        """
                            CREATE TABLE IF NOT EXISTS diagnosis_cases (
                                case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                                top_event TEXT NOT NULL,
                                questions JSONB NOT NULL DEFAULT '[]'::jsonb,
                                answers JSONB NOT NULL DEFAULT '{}'::jsonb,
                                answers_hash VARCHAR(64) NOT NULL,
                                tree_id UUID REFERENCES fault_trees(tree_id) ON DELETE CASCADE,
                                cause_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
                                steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                                messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                                hit_count INTEGER NOT NULL DEFAULT 1,
                                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                            )
                        """,
                    ),
                    (
                        "diagnosis_cases_tree_id_nullable",
                        "ALTER TABLE diagnosis_cases ALTER COLUMN tree_id DROP NOT NULL",
                    ),
                    (
                        "diagnosis_cases_steps_json",
                        "ALTER TABLE diagnosis_cases ADD COLUMN IF NOT EXISTS steps_json JSONB NOT NULL DEFAULT '[]'::jsonb",
                    ),
                    (
                        "diagnosis_cases_messages_json",
                        "ALTER TABLE diagnosis_cases ADD COLUMN IF NOT EXISTS messages_json JSONB NOT NULL DEFAULT '[]'::jsonb",
                    ),
                    (
                        "diagnosis_cases_top_event_index",
                        "CREATE INDEX IF NOT EXISTS idx_diagnosis_cases_top_event ON diagnosis_cases(top_event)",
                    ),
                    (
                        "diagnosis_cases_top_hash_index",
                        "CREATE INDEX IF NOT EXISTS idx_diagnosis_cases_top_hash ON diagnosis_cases(top_event, answers_hash)",
                    ),
                    (
                        "diagnosis_cases_unique_top_hash",
                        "CREATE UNIQUE INDEX IF NOT EXISTS uq_diagnosis_cases_top_hash ON diagnosis_cases(top_event, answers_hash)",
                    ),
                ]
            )

        # manual_books 不依赖其他表
        statements.extend(
            [
                (
                    "manual_books",
                    """
                        CREATE TABLE IF NOT EXISTS manual_books (
                            book_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                            pipeline VARCHAR(120) NOT NULL,
                            use_ai BOOLEAN NOT NULL DEFAULT TRUE,
                            sections JSONB NOT NULL DEFAULT '[]'::jsonb,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                        )
                    """,
                ),
                (
                    "manual_books_pipeline_ai_index",
                    "CREATE INDEX IF NOT EXISTS idx_manual_books_pipeline_ai ON manual_books(pipeline, use_ai)",
                ),
                (
                    "manual_books_unique_pipeline_ai",
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_books_pipeline_ai ON manual_books(pipeline, use_ai)",
                ),
            ]
        )

        for label, sql in statements:
            await _safe_execute(conn, sql, label)


async def close_db():
    """关闭连接池（应用退出时调用）"""
    await engine.dispose()
