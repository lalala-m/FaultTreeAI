"""
BM25 关键词检索模块
使用 rank_bm25 库实现传统的关键词检索
psycopg2 直连（Windows Python 3.13 兼容）
"""

from typing import List, Optional
from rank_bm25 import BM25Okapi
import jieba

from backend.config import settings


def _sync_bm25(query: str, top_k: int, doc_ids: Optional[List[str]]) -> List[dict]:
    """同步 BM25 检索实现"""
    import psycopg2

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME, connect_timeout=10,
    ) as conn:
        with conn.cursor() as cur:
            if doc_ids:
                cur.execute("""
                    SELECT dc.chunk_id::text, dc.doc_id::text, dc.page_num, dc.text, d.filename
                    FROM document_chunks dc
                    JOIN documents d ON d.doc_id = dc.doc_id
                    WHERE d.status = 'active' AND dc.doc_id = ANY(%s)
                """, (doc_ids,))
            else:
                cur.execute("""
                    SELECT dc.chunk_id::text, dc.doc_id::text, dc.page_num, dc.text, d.filename
                    FROM document_chunks dc
                    JOIN documents d ON d.doc_id = dc.doc_id
                    WHERE d.status = 'active'
                """)
            rows = cur.fetchall()

    if not rows:
        return []

    texts = [row[3] for row in rows]
    tokenized_texts = [list(jieba.cut_for_search(doc)) for doc in texts]
    bm25 = BM25Okapi(tokenized_texts)

    query_terms = list(jieba.cut_for_search(query))
    if not query_terms:
        query_terms = list(query)

    scores = bm25.get_scores(query_terms)
    top_indices = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]

    results = []
    for idx in top_indices:
        score = scores[idx]
        if score <= 0:
            continue
        row = rows[idx]
        results.append({
            "ref_id": f"BM25-{idx+1:03d}",
            "text": row[3],
            "source": row[4] if len(row) > 4 else "unknown",
            "page": row[2] or 0,
            "score": round(score, 4),
        })
    return results


async def retrieve_bm25(
    query: str,
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
) -> List[dict]:
    """BM25 关键词检索（线程池执行同步 DB 查询）"""
    import asyncio
    return await asyncio.get_event_loop().run_in_executor(
        None, _sync_bm25, query, top_k, doc_ids
    )
