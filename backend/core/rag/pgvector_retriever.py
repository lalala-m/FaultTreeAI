"""
PostgreSQL + pgvector RAG 检索层
使用纯 SQLAlchemy 异步操作，不依赖 langchain-postgres 以避免兼容性问题
"""

from typing import Optional
from sqlalchemy import text, select
from sqlalchemy.ext.asyncio import AsyncSession
import httpx
from backend.config import settings


# ─────────────────────────────────────────────
# MiniMax Embedding（与 llm_client.py 保持一致）
# ─────────────────────────────────────────────

class MiniMaxEmbeddingService:
    """独立的 MiniMax Embedding 服务（避免与 llm_client 循环导入）"""

    def __init__(self, api_key: str = None, group_id: str = None, model: str = None):
        self.api_key = api_key or settings.MINIMAX_API_KEY
        self.group_id = group_id or settings.MINIMAX_GROUP_ID
        self.model = model or settings.MINIMAX_EMBED_MODEL
        self.base_url = "https://api.minimax.io/v1/embeddings"
        self.embedding_dim = settings.EMBED_DIM

    async def aembed_query(self, text: str) -> list[float]:
        """异步单条向量化"""
        payload = {
            "model": self.model,
            "input": text,
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
    db: AsyncSession,
) -> int:
    """
    将文档分块存入 PostgreSQL（文本 + 向量双写）
    - document_chunks: 原始文本
    - chunk_embeddings: 向量（HNSW 索引加速）
    """
    from core.database.models import DocumentChunk, ChunkEmbedding

    chunk_records = []
    embedding_records = []

    # 批量向量化（推荐，效率高）
    texts = [c["text"] for c in chunks]
    vectors = await _embed_service.aembed_documents(texts)

    for i, chunk in enumerate(chunks):
        chunk_record = DocumentChunk(
            doc_id=doc_id,
            chunk_index=i,
            page_num=chunk.get("page", 0),
            text=chunk["text"],
            token_count=chunk.get("tokens"),
        )
        db.add(chunk_record)
        await db.flush()
        chunk_records.append(chunk_record)

        embedding_record = ChunkEmbedding(
            chunk_id=chunk_record.chunk_id,
            doc_id=doc_id,
            embedding=vectors[i],
            model_name=settings.MINIMAX_EMBED_MODEL,
        )
        db.add(embedding_record)
        embedding_records.append(embedding_record)

    await db.commit()
    return len(chunks)


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
    """
    from core.database.models import ChunkEmbedding, DocumentChunk
    from sqlalchemy import select
    from core.database.connection import AsyncSessionLocal

    k = top_k or settings.RAG_TOP_K
    threshold = settings.RAG_SIMILARITY_THRESHOLD

    # 查询向量
    query_vector = await _embed_service.aembed_query(query)

    # 构造余弦距离 SQL
    # cosine_distance = 1 - cosine_similarity
    # pgvector 余弦距离: embedding <=> $1
    # 这里用点积近似（MiniMax emb 返回的向量已归一化）
    sql = text("""
        SELECT
            ce.doc_id,
            dc.chunk_id,
            dc.page_num,
            dc.text,
            (ce.embedding <=> :query_vec::vector) AS cosine_dist,
            1 - (ce.embedding <=> :query_vec::vector) AS cosine_sim
        FROM chunk_embeddings ce
        JOIN document_chunks dc ON dc.chunk_id = ce.chunk_id
        JOIN documents d ON d.doc_id = ce.doc_id
        WHERE d.status = 'active'
        ORDER BY ce.embedding <=> :query_vec::vector
        LIMIT :k
    """)

    async with AsyncSessionLocal() as session:
        if doc_ids:
            # 带 doc_ids 过滤的查询
            sql_filtered = text("""
                SELECT
                    ce.doc_id,
                    dc.chunk_id,
                    dc.page_num,
                    dc.text,
                    d.filename,
                    (ce.embedding <=> :query_vec::vector) AS cosine_dist,
                    1 - (ce.embedding <=> :query_vec::vector) AS cosine_sim
                FROM chunk_embeddings ce
                JOIN document_chunks dc ON dc.chunk_id = ce.chunk_id
                JOIN documents d ON d.doc_id = ce.doc_id
                WHERE d.status = 'active'
                  AND ce.doc_id = ANY(:doc_ids::uuid[])
                ORDER BY ce.embedding <=> :query_vec::vector
                LIMIT :k
            """)
            result = await session.execute(
                sql_filtered,
                {"query_vec": query_vector, "doc_ids": doc_ids, "k": k}
            )
        else:
            result = await session.execute(
                sql,
                {"query_vec": query_vector, "k": k}
            )
        rows = result.fetchall()

    chunks = []
    for i, row in enumerate(rows):
        sim = float(row.cosine_sim) if hasattr(row, 'cosine_sim') else float(row.cosine_sim)
        if sim < threshold:
            continue
        chunks.append({
            "ref_id": f"REF{i+1:03d}",
            "text": row.text,
            "source": getattr(row, 'filename', 'unknown'),
            "page": row.page_num,
            "score": round(sim, 4),
        })

    return chunks


async def delete_doc_vectors(doc_id: str, db: AsyncSession):
    """删除指定文档的所有向量（级联删除通过外键自动处理）"""
    from core.database.models import Document
    from sqlalchemy import update

    await db.execute(
        update(Document)
        .where(Document.doc_id == doc_id)
        .values(status="deleted")
    )
    await db.commit()
