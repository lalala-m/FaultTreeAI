"""
BM25 关键词检索模块
使用 rank_bm25 库实现传统的关键词检索
psycopg2 直连（Windows Python 3.13 兼容）
"""

from typing import List, Optional

from backend.config import settings


def _get_bm25():
    try:
        from rank_bm25 import BM25Okapi
        import jieba
        return BM25Okapi, jieba
    except Exception:
        return None, None


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
                    SELECT
                        dc.chunk_id::text,
                        dc.doc_id::text,
                        dc.page_num,
                        dc.text,
                        d.filename,
                        COALESCE(kdw.current_weight, 0.5) AS doc_weight,
                        COALESCE(kcw.current_weight, 0.5) AS chunk_weight
                    FROM document_chunks dc
                    JOIN documents d ON d.doc_id = dc.doc_id
                    LEFT JOIN knowledge_doc_weights kdw ON kdw.doc_id = d.doc_id
                    LEFT JOIN knowledge_chunk_weights kcw ON kcw.chunk_id = dc.chunk_id
                    WHERE d.status = 'active' AND dc.doc_id = ANY(%s::uuid[])
                """, (doc_ids,))
            else:
                cur.execute("""
                    SELECT
                        dc.chunk_id::text,
                        dc.doc_id::text,
                        dc.page_num,
                        dc.text,
                        d.filename,
                        COALESCE(kdw.current_weight, 0.5) AS doc_weight,
                        COALESCE(kcw.current_weight, 0.5) AS chunk_weight
                    FROM document_chunks dc
                    JOIN documents d ON d.doc_id = dc.doc_id
                    LEFT JOIN knowledge_doc_weights kdw ON kdw.doc_id = d.doc_id
                    LEFT JOIN knowledge_chunk_weights kcw ON kcw.chunk_id = dc.chunk_id
                    WHERE d.status = 'active'
                """)
            rows = cur.fetchall()

    if not rows:
        return []

    BM25Okapi, jieba = _get_bm25()
    if BM25Okapi is None or jieba is None:
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
            "chunk_id": row[0],
            "doc_id": row[1],
            "text": row[3],
            "source": row[4] if len(row) > 4 else "unknown",
            "page": row[2] or 0,
            "score": round(score, 4),
            "doc_weight": round(float(row[5] if row[5] is not None else 0.5), 4),
            "chunk_weight": round(float(row[6] if row[6] is not None else 0.5), 4),
            "retrieval_type": "bm25",
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
