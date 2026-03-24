"""
PostgreSQL + pgvector RAG 检索层
使用 psycopg2（同步）直连，asyncpg 在 Windows Python 3.13 上有兼容性问题
支持混合检索（向量 + BM25）
"""

from typing import Optional, List
import psycopg2
import psycopg2.extras
import httpx
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
            if doc_ids:
                cur.execute("""
                    SELECT
                        ce.doc_id::text,
                        dc.chunk_id::text,
                        dc.page_num,
                        dc.text,
                        d.filename,
                        1 - (ce.embedding <=> %s::vector) AS cosine_sim
                    FROM chunk_embeddings ce
                    JOIN document_chunks dc ON dc.chunk_id = ce.chunk_id
                    JOIN documents d ON d.doc_id = ce.doc_id
                    WHERE d.status = 'active'
                      AND ce.doc_id = ANY(%s)
                    ORDER BY ce.embedding <=> %s::vector
                    LIMIT %s
                """, (query_vector, doc_ids, query_vector, top_k))
            else:
                cur.execute("""
                    SELECT
                        ce.doc_id::text,
                        dc.chunk_id::text,
                        dc.page_num,
                        dc.text,
                        d.filename,
                        1 - (ce.embedding <=> %s::vector) AS cosine_sim
                    FROM chunk_embeddings ce
                    JOIN document_chunks dc ON dc.chunk_id = ce.chunk_id
                    JOIN documents d ON d.doc_id = ce.doc_id
                    WHERE d.status = 'active'
                    ORDER BY ce.embedding <=> %s::vector
                    LIMIT %s
                """, (query_vector, query_vector, top_k))
            return cur.fetchall()


# ─────────────────────────────────────────────
# MiniMax Embedding（与 llm_client.py 保持一致）
# ─────────────────────────────────────────────

class MiniMaxEmbeddingService:
    """独立的 MiniMax Embedding 服务（避免与 llm_client 循环导入）"""

    def __init__(self, api_key: str = None, group_id: str = None, model: str = None):
        self.api_key = api_key or settings.MINIMAX_API_KEY
        self.group_id = group_id or settings.MINIMAX_GROUP_ID
        self.model = model or settings.MINIMAX_EMBED_MODEL
        self.base_url = settings.MINIMAX_BASE_URL + "/v1/embeddings"
        self.embedding_dim = settings.EMBED_DIM

    async def aembed_query(self, text: str) -> list[float]:
        """异步单条向量化"""
        payload = {
            "model": self.model,
            "input": text,
            "type": "float",
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(self.base_url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            vectors = data.get("vectors", [])
            return vectors[0] if vectors else data.get("vector", [])

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        """异步批量向量化"""
        payload = {
            "model": self.model,
            "texts": texts,
            "type": "float",
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self.base_url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            vectors = data.get("vectors", data.get("data", []))
            return [v if isinstance(v, list) else v.get("vector", []) for v in vectors]


_embed_service = MiniMaxEmbeddingService()


# ─────────────────────────────────────────────
# RAG 检索核心函数
# ─────────────────────────────────────────────

async def add_chunks_to_db(
    chunks: list[dict],
    doc_id: str,
    db=None,  # 忽略此参数，使用 psycopg2 直连
) -> int:
    """
    将文档分块存入 PostgreSQL（文本 + 向量双写）
    psycopg2 直连（绕过 asyncpg Windows bug）
    """
    texts = [c["text"] for c in chunks]
    vectors = await _embed_service.aembed_documents(texts)

    with _get_sync_conn() as conn:
        with conn.cursor() as cur:
            chunk_ids = []
            for i, chunk in enumerate(chunks):
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

                # 插入向量记录
                cur.execute("""
                    INSERT INTO chunk_embeddings (chunk_id, doc_id, embedding, model_name)
                    VALUES (%s, %s, %s, %s)
                """, (
                    chunk_id, doc_id,
                    psycopg2.extras.Json(vectors[i]),
                    settings.MINIMAX_EMBED_MODEL
                ))
            conn.commit()
    return len(chunks)


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

    # 查询向量（异步 HTTP），embedding 失败时返回空列表
    try:
        query_vector = await _embed_service.aembed_query(query)
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
        chunks.append({
            "ref_id": f"REF{i+1:03d}",
            "text": row[3],
            "source": row[4] if len(row) > 4 else "unknown",
            "page": row[2] or 0,
            "score": round(sim, 4),
        })

    return chunks


# ─────────────────────────────────────────────
# 混合检索（向量 + BM25）
# ─────────────────────────────────────────────

async def retrieve_hybrid(
    query: str,
    top_k: int = None,
    doc_ids: Optional[list[str]] = None,
    vector_weight: float = 0.5,
) -> list[dict]:
    """
    混合检索：结合向量检索和 BM25 关键词检索
    """
    from backend.core.rag.bm25_retriever import retrieve_bm25
    
    k = top_k or settings.RAG_TOP_K
    
    # 并行执行两种检索
    vector_results = await retrieve(query, top_k=k, doc_ids=doc_ids)
    bm25_results = await retrieve_bm25(query, top_k=k, doc_ids=doc_ids)
    
    # 归一化分数
    def normalize_scores(results: list[dict], weight: float) -> list[dict]:
        if not results:
            return []
        max_score = max(r["score"] for r in results)
        min_score = min(r["score"] for r in results)
        score_range = max_score - min_score if max_score > min_score else 1
        
        normalized = []
        for r in results:
            normalized_r = r.copy()
            normalized_score = (r["score"] - min_score) / score_range if score_range > 0 else 0.5
            normalized_r["score"] = round(normalized_score * weight, 4)
            normalized_r["retrieval_type"] = "vector"
            normalized.append(normalized_r)
        return normalized
    
    vector_norm = normalize_scores(vector_results, vector_weight)
    bm25_norm = normalize_scores(bm25_results, 1 - vector_weight)
    
    # 合并结果
    all_results = vector_norm + bm25_norm
    
    # 去重
    seen = {}
    for r in all_results:
        text_key = r["text"][:100]
        if text_key not in seen or r["score"] > seen[text_key]["score"]:
            seen[text_key] = r
    
    # 排序并返回 top_k
    sorted_results = sorted(seen.values(), key=lambda x: x["score"], reverse=True)[:k]
    
    for i, r in enumerate(sorted_results):
        r["ref_id"] = f"Hybrid-{i+1:03d}"
    
    return sorted_results
