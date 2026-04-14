-- ============================================================
-- FaultTreeAI 数据库 Schema
-- PostgreSQL 18 + pgvector
--
-- 使用方式：
--   1. 安装 PostgreSQL 18 + pgvector 扩展
--   2. psql -U postgres -d postgres -c "CREATE DATABASE faulttree;"
--   3. psql -U postgres -d faulttree -c "CREATE EXTENSION vector;"
--   4. psql -U postgres -d faulttree -f scripts/init_db.sql
-- ============================================================

-- 启用 pgvector 扩展（如果尚未启用）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================
-- 1. 文档表（原始文件元数据）
-- =============================================
CREATE TABLE IF NOT EXISTS documents (
    doc_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename         VARCHAR(255) NOT NULL,
    file_size        BIGINT,
    file_type        VARCHAR(20) NOT NULL,
    upload_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status           VARCHAR(20) NOT NULL DEFAULT 'active',
    metadata         JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_upload_time ON documents(upload_time);

-- =============================================
-- 2. 文档分块表（用于 RAG 检索）
-- =============================================
CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id         UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    chunk_index    INTEGER NOT NULL,
    page_num       INTEGER DEFAULT 0,
    text           TEXT NOT NULL,
    token_count    INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON document_chunks(doc_id);

-- =============================================
-- 3. 向量表（pgvector 核心）
-- MiniMax embo-01 为 1024 维向量
-- =============================================
CREATE TABLE IF NOT EXISTS chunk_embeddings (
    embedding_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id       UUID NOT NULL REFERENCES document_chunks(chunk_id) ON DELETE CASCADE UNIQUE,
    doc_id         UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    embedding      VECTOR(1024) NOT NULL,
    model_name     VARCHAR(50) NOT NULL DEFAULT 'embo-01',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW 索引（pgvector 0.5+ 内置）
-- m=16: 层间连接数，越大精度越高但内存越大
-- ef_construction=64: 构建时动态列表大小
CREATE INDEX ON chunk_embeddings USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_doc_id ON chunk_embeddings(doc_id);

-- =============================================
-- 4. 故障树表（存储生成的故障树）
-- =============================================
CREATE TABLE IF NOT EXISTS fault_trees (
    tree_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id            UUID REFERENCES documents(doc_id) ON DELETE SET NULL,
    top_event         VARCHAR(500) NOT NULL,
    user_prompt       TEXT,
    nodes_json        JSONB NOT NULL,
    gates_json        JSONB NOT NULL,
    confidence        FLOAT,
    analysis_summary  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by        VARCHAR(100) DEFAULT 'system',
    is_valid          BOOLEAN DEFAULT NULL,
    mcs_json          JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tree_top_doc
    ON fault_trees (top_event, doc_id) WHERE doc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fault_trees_top_event ON fault_trees(top_event);
CREATE INDEX IF NOT EXISTS idx_fault_trees_created_at ON fault_trees(created_at);

-- =============================================
-- 5. 校验日志表
-- =============================================
CREATE TABLE IF NOT EXISTS validation_logs (
    log_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tree_id         UUID NOT NULL REFERENCES fault_trees(tree_id) ON DELETE CASCADE,
    validation_type VARCHAR(50) NOT NULL,
    node_id         VARCHAR(50),
    issue_level     VARCHAR(20) NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validation_logs_tree_id ON validation_logs(tree_id);

-- =============================================
-- 6. 会话表（多轮对话支持）
-- =============================================
CREATE TABLE IF NOT EXISTS sessions (
    session_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tree_id       UUID REFERENCES fault_trees(tree_id) ON DELETE SET NULL,
    messages      JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================
-- 7. 统计视图
-- =============================================
CREATE OR REPLACE VIEW system_stats AS
SELECT
    (SELECT COUNT(*) FROM documents WHERE status = 'active')              AS total_docs,
    (SELECT COUNT(*) FROM document_chunks)                               AS total_chunks,
    (SELECT COUNT(*) FROM fault_trees)                                   AS total_trees,
    (SELECT ROUND(SUM(LENGTH(text)) / 1024.0 / 1024, 2)
     FROM document_chunks)                                               AS total_text_mb,
    (SELECT COUNT(*) FROM fault_trees WHERE is_valid = TRUE)             AS valid_trees,
    (SELECT COUNT(*) FROM fault_trees WHERE is_valid = FALSE)            AS invalid_trees;

-- =============================================
-- 8. 自动更新 updated_at 触发器
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_fault_trees_updated_at
    BEFORE UPDATE ON fault_trees
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- 9. 知识库权重表
-- =============================================
CREATE TABLE IF NOT EXISTS knowledge_doc_weights (
    doc_id             UUID PRIMARY KEY REFERENCES documents(doc_id) ON DELETE CASCADE,
    helpful_weight     DOUBLE PRECISION NOT NULL DEFAULT 0,
    misleading_weight  DOUBLE PRECISION NOT NULL DEFAULT 0,
    feedback_count     INTEGER NOT NULL DEFAULT 0,
    current_weight     DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_chunk_weights (
    chunk_id           UUID PRIMARY KEY REFERENCES document_chunks(chunk_id) ON DELETE CASCADE,
    doc_id             UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    helpful_weight     DOUBLE PRECISION NOT NULL DEFAULT 0,
    misleading_weight  DOUBLE PRECISION NOT NULL DEFAULT 0,
    feedback_count     INTEGER NOT NULL DEFAULT 0,
    current_weight     DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_weights_doc_id
    ON knowledge_chunk_weights(doc_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_doc_weights_weight
    ON knowledge_doc_weights(current_weight DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_weights_weight
    ON knowledge_chunk_weights(current_weight DESC);

CREATE TABLE IF NOT EXISTS knowledge_graph_cache (
    line          VARCHAR(120) PRIMARY KEY,
    graph_json    JSONB NOT NULL,
    doc_count     INTEGER NOT NULL DEFAULT 0,
    device_count  INTEGER NOT NULL DEFAULT 0,
    fault_count   INTEGER NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_cache_updated_at
    ON knowledge_graph_cache(updated_at DESC);

-- =============================================
-- 10. 结构化知识库（按流水线/设备/问题/原因组织）
-- =============================================
CREATE TABLE IF NOT EXISTS knowledge_items (
    item_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline         VARCHAR(64) NOT NULL DEFAULT '流水线1',
    machine_category VARCHAR(120) NOT NULL DEFAULT '',
    machine          VARCHAR(160) NOT NULL DEFAULT '',
    problem_category VARCHAR(120) NOT NULL DEFAULT '',
    problem          TEXT NOT NULL,
    root_cause       TEXT NOT NULL DEFAULT '',
    solution         TEXT NOT NULL DEFAULT '',
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status           VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_pipeline
    ON knowledge_items(pipeline);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_machine
    ON knowledge_items(machine);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_problem_category
    ON knowledge_items(problem_category);

CREATE TABLE IF NOT EXISTS knowledge_item_embeddings (
    embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id      UUID NOT NULL REFERENCES knowledge_items(item_id) ON DELETE CASCADE UNIQUE,
    embedding    VECTOR(1024),
    model_name   VARCHAR(50) NOT NULL DEFAULT 'embo-01',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_item_embeddings_hnsw
    ON knowledge_item_embeddings USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS knowledge_item_weights (
    item_id          UUID PRIMARY KEY REFERENCES knowledge_items(item_id) ON DELETE CASCADE,
    helpful_weight   DOUBLE PRECISION NOT NULL DEFAULT 0,
    misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
    feedback_count   INTEGER NOT NULL DEFAULT 0,
    current_weight   DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    expert_weight    DOUBLE PRECISION,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE knowledge_item_weights
    ADD COLUMN IF NOT EXISTS expert_weight DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_knowledge_item_weights_weight
    ON knowledge_item_weights(current_weight DESC);
