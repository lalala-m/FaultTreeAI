"""
PostgreSQL + pgvector RAG 检索层
使用 psycopg2（同步）直连，asyncpg 在 Windows Python 3.13 上有兼容性问题
"""

from typing import Optional, List
import psycopg2
import psycopg2.extras

from backend.config import settings


# ─────────────────────────────────────────────
# 同步数据库连接（psycopg2，直连绕过 asyncpg）
# ─────────────────────────────────────────────

def _get_sync_conn():
    """获取同步 psycopg2 连接（Windows Python 3.13 兼容）"""
    return psycopg2.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        user=settings.DB_USER,
        password=settings.DB_PASSWORD,
        database=settings.DB_NAME,
        connect_timeout=10,
        options="-c statement_timeout=60000",
    )


def _sync_retrieve(query_vector: list[float], top_k: int, doc_ids: Optional[list[str]]) -> list[tuple]:
    """同步向量检索实现（在线程池中执行）"""
    with _get_sync_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    to_regclass('public.knowledge_doc_weights') IS NOT NULL,
                    to_regclass('public.knowledge_chunk_weights') IS NOT NULL
            """)
            row = cur.fetchone() or (False, False)
            use_weights = bool(row[0]) and bool(row[1])
            if doc_ids:
                cur.execute(f"""
                    SELECT
                        ce.doc_id::text,
                        dc.chunk_id::text,
                        dc.page_num,
                        dc.text,
                        d.filename,
                        {"COALESCE(kdw.current_weight, 0.5)" if use_weights else "0.5"} AS doc_weight,
                        {"COALESCE(kcw.current_weight, 0.5)" if use_weights else "0.5"} AS chunk_weight,
                        1 - (ce.embedding <=> %s::vector) AS cosine_sim
                    FROM chunk_embeddings ce
                    JOIN document_chunks dc ON dc.chunk_id = ce.chunk_id
                    JOIN documents d ON d.doc_id = ce.doc_id
                    {"LEFT JOIN knowledge_doc_weights kdw ON kdw.doc_id = d.doc_id" if use_weights else ""}
                    {"LEFT JOIN knowledge_chunk_weights kcw ON kcw.chunk_id = dc.chunk_id" if use_weights else ""}
                    WHERE d.status = 'active'
                      AND ce.doc_id = ANY(%s::uuid[])
                    ORDER BY ce.embedding <=> %s::vector
                    LIMIT %s
                """, (query_vector, doc_ids, query_vector, top_k))
            else:
                cur.execute(f"""
                    SELECT
                        ce.doc_id::text,
                        dc.chunk_id::text,
                        dc.page_num,
                        dc.text,
                        d.filename,
                        {"COALESCE(kdw.current_weight, 0.5)" if use_weights else "0.5"} AS doc_weight,
                        {"COALESCE(kcw.current_weight, 0.5)" if use_weights else "0.5"} AS chunk_weight,
                        1 - (ce.embedding <=> %s::vector) AS cosine_sim
                    FROM chunk_embeddings ce
                    JOIN document_chunks dc ON dc.chunk_id = ce.chunk_id
                    JOIN documents d ON d.doc_id = ce.doc_id
                    {"LEFT JOIN knowledge_doc_weights kdw ON kdw.doc_id = d.doc_id" if use_weights else ""}
                    {"LEFT JOIN knowledge_chunk_weights kcw ON kcw.chunk_id = dc.chunk_id" if use_weights else ""}
                    WHERE d.status = 'active'
                    ORDER BY ce.embedding <=> %s::vector
                    LIMIT %s
                """, (query_vector, query_vector, top_k))
            return cur.fetchall()


# ─────────────────────────────────────────────
# Embedding 服务（使用统一实现）
# ─────────────────────────────────────────────

def _get_embeddings():
    """获取统一的 Embedding 服务（延迟导入避免循环依赖）"""
    from backend.core.llm.embeddings import get_unified_embeddings
    return get_unified_embeddings()


# ─────────────────────────────────────────────
# RAG 检索核心函数
# ─────────────────────────────────────────────

async def add_chunks_to_db(
    chunks: list[dict],
    doc_id: str,
    db=None,  # 忽略此参数，使用 psycopg2 直连
) -> dict:
    """
    将文档分块存入 PostgreSQL（文本 + 向量双写）
    psycopg2 直连（绕过 asyncpg Windows bug）
    """
    texts = [c["text"] for c in chunks]
    vectors = None
    embedded = False
    embeddings = _get_embeddings()
    
    try:
        vectors = await embeddings.aembed_documents(texts)
        embedded = True
    except Exception as e:
        if settings.SKIP_EMBED_ON_FAIL:
            embedded = False
            print(f"[WARN] Embedding failed, storing text only: {e}")
        else:
            raise

    def _to_vector_literal(vec: list[float]) -> str:
        # pgvector 接受形如 '[1,2,3]' 的文本表示
        return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"

    with _get_sync_conn() as conn:
        with conn.cursor() as cur:
            chunk_ids = []
            for i, chunk in enumerate(chunks):
                if embedded:
                    if i >= len(vectors) or not vectors[i]:
                        raise ValueError("Embedding 返回为空或数量不匹配")
                # 插入 chunk 记录
                cur.execute("""
                    INSERT INTO document_chunks (doc_id, chunk_index, page_num, text, token_count)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING chunk_id
                """, (
                    doc_id, i, chunk.get("page", 0),
                    chunk["text"], chunk.get("tokens")
                ))
                row = cur.fetchone()
                chunk_id = row[0]
                chunk_ids.append(chunk_id)

                # 插入向量记录（可跳过）
                if embedded:
                    cur.execute("""
                        INSERT INTO chunk_embeddings (chunk_id, doc_id, embedding, model_name)
                        VALUES (%s, %s, %s, %s)
                    """, (
                        chunk_id, doc_id,
                        _to_vector_literal(vectors[i]),
                        embeddings.model_name
                    ))
            conn.commit()
    return {"chunk_count": len(chunks), "embedded": embedded}


async def delete_doc_vectors(doc_id: str, db=None):
    """删除指定文档的所有向量（psycopg2 直连）"""
    with _get_sync_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET status = 'deleted' WHERE doc_id = %s",
                (doc_id,)
            )
            conn.commit()


async def retrieve(
    query: str,
    top_k: int = None,
    doc_ids: Optional[list[str]] = None,
) -> list[dict]:
    """
    RAG 检索：余弦相似度搜索（HNSW 索引加速）
    - query: 用户输入的顶事件
    - doc_ids: 可选，按文档ID过滤
    返回: [{ref_id, text, source, page, score}]
    - 若 embedding 服务不可用，返回空列表
    """
    import asyncio

    k = top_k or settings.RAG_TOP_K
    threshold = settings.RAG_SIMILARITY_THRESHOLD
    embeddings = _get_embeddings()

    # 查询向量（异步 HTTP），embedding 失败时返回空列表
    try:
        query_vector = await embeddings.aembed_query(query)
    except Exception as e:
        print(f"[WARN] Embedding failed, skipping RAG: {e}")
        return []

    # 空向量直接返回
    if not query_vector or len(query_vector) == 0:
        print("[WARN] Empty embedding vector, skipping RAG")
        return []

    # 同步 DB 查询通过线程池执行（绕过 asyncpg Windows bug）
    try:
        rows = await asyncio.get_event_loop().run_in_executor(
            None, _sync_retrieve, query_vector, k, doc_ids
        )
    except Exception as e:
        print(f"[WARN] Vector DB query failed: {e}")
        return []

    chunks = []
    for i, row in enumerate(rows):
        sim = float(row[-1])
        if sim < threshold:
            continue
        doc_weight = float(row[5] if row[5] is not None else 0.5)
        chunk_weight = float(row[6] if row[6] is not None else 0.5)
        chunks.append({
            "ref_id": f"REF{i+1:03d}",
            "doc_id": row[0],
            "chunk_id": row[1],
            "text": row[3],
            "source": row[4] if len(row) > 4 else "unknown",
            "page": row[2] or 0,
            "score": round(sim, 4),
            "doc_weight": round(doc_weight, 4),
            "chunk_weight": round(chunk_weight, 4),
        })

    return chunks


# ─────────────────────────────────────────────
# 混合检索（已移至 rag/hybrid_retriever.py，此处保留用于兼容）
# ─────────────────────────────────────────────

async def retrieve_hybrid(
    query: str,
    top_k: int = None,
    doc_ids: Optional[list[str]] = None,
    vector_weight: float = 0.5,
) -> list[dict]:
    """
    混合检索：结合向量检索和 BM25 关键词检索
    
    注意：此函数已移至 backend.core.rag.hybrid_retriever.py
    此处保留用于向后兼容
    """
    from backend.core.rag.hybrid_retriever import retrieve_hybrid as _retrieve_hybrid
    return await _retrieve_hybrid(query, top_k, doc_ids, vector_weight)
