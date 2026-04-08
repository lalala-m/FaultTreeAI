"""
混合检索器 - 向量检索 + BM25

整合 pgvector_retriever 和 bm25_retriever，提供统一的混合检索接口。

本模块提供：
- retrieve_hybrid: 混合检索函数

Usage:
    from backend.core.rag.hybrid_retriever import retrieve_hybrid
    
    results = await retrieve_hybrid(
        query="电机无法启动",
        top_k=5,
        vector_weight=0.5,  # 向量权重，BM25 权重为 0.5
    )
"""

from typing import List, Optional
import asyncio

from backend.config import settings


async def retrieve_hybrid(
    query: str,
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
    vector_weight: float = 0.5,
) -> List[dict]:
    """
    混合检索：结合向量检索和 BM25 关键词检索
    
    通过加权融合向量相似度和 BM25 关键词得分，返回最相关的结果。
    
    Args:
        query: 检索查询
        top_k: 返回结果数量
        doc_ids: 可选，按文档ID过滤
        vector_weight: 向量检索权重（0-1），BM25 权重为 1-vector_weight
    
    Returns:
        List[dict]: 检索结果列表，每项包含:
            - ref_id: 引用ID
            - chunk_id: chunk ID
            - doc_id: 文档ID
            - text: 文本内容
            - source: 来源文件
            - page: 页码
            - score: 综合得分
            - retrieval_type: 检索类型 ("vector" 或 "bm25")
    
    Example:
        results = await retrieve_hybrid("电机故障", top_k=5)
        for r in results:
            print(f"[{r['ref_id']}] {r['source']} - 相似度: {r['score']:.4f}")
    """
    async def vector_search():
        """向量检索"""
        from backend.core.rag.pgvector_retriever import retrieve
        return await retrieve(query, top_k=top_k, doc_ids=doc_ids)
    
    async def bm25_search():
        """BM25 检索"""
        from backend.core.rag.bm25_retriever import retrieve_bm25
        return await retrieve_bm25(query, top_k=top_k, doc_ids=doc_ids)
    
    # 并行执行两种检索
    vector_results, bm25_results = await asyncio.gather(
        vector_search(),
        bm25_search(),
        return_exceptions=True,
    )
    
    # 处理异常
    if isinstance(vector_results, Exception):
        print(f"[WARN] Vector retrieval failed: {vector_results}")
        vector_results = []
    
    if isinstance(bm25_results, Exception):
        print(f"[WARN] BM25 retrieval failed: {bm25_results}")
        bm25_results = []
    
    # 归一化分数并合并
    vector_norm = _normalize_scores(vector_results, vector_weight, "vector")
    bm25_norm = _normalize_scores(bm25_results, 1 - vector_weight, "bm25")
    
    all_results = vector_norm + bm25_norm
    
    # 去重（基于文本前100字符）
    seen = {}
    for r in all_results:
        text_key = r["text"][:100]
        if text_key not in seen or r["score"] > seen[text_key]["score"]:
            seen[text_key] = r
    
    # 排序并返回 top_k
    sorted_results = sorted(seen.values(), key=lambda x: x["score"], reverse=True)[:top_k]
    
    # 更新引用ID
    for i, r in enumerate(sorted_results):
        r["ref_id"] = f"Hybrid-{i+1:03d}"
    
    return sorted_results


def _normalize_scores(
    results: List[dict], 
    weight: float,
    retrieval_type: str,
) -> List[dict]:
    """
    归一化分数并应用权重
    
    Args:
        results: 检索结果列表
        weight: 应用权重
        retrieval_type: 检索类型
    
    Returns:
        List[dict]: 归一化后的结果
    """
    if not results:
        return []
    
    max_score = max(r["score"] for r in results)
    min_score = min(r["score"] for r in results)
    score_range = max_score - min_score if max_score > min_score else 1
    
    normalized = []
    for r in results:
        normalized_r = r.copy()
        
        # Min-Max 归一化
        normalized_score = (r["score"] - min_score) / score_range if score_range > 0 else 0.5
        
        # 应用文档/Chunk 权重
        doc_weight = float(r.get("doc_weight") or 0.5)
        chunk_weight = float(r.get("chunk_weight") or 0.5)
        weight_boost = 0.65 + 0.2 * doc_weight + 0.15 * chunk_weight
        
        normalized_r["base_score"] = round(normalized_score, 4)
        normalized_r["score"] = round(normalized_score * weight * weight_boost, 4)
        normalized_r["retrieval_type"] = retrieval_type
        normalized.append(normalized_r)
    
    return normalized


async def retrieve_vector_only(
    query: str,
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
) -> List[dict]:
    """
    仅使用向量检索
    
    Args:
        query: 检索查询
        top_k: 返回结果数量
        doc_ids: 可选，按文档ID过滤
    
    Returns:
        List[dict]: 检索结果
    """
    from backend.core.rag.pgvector_retriever import retrieve
    results = await retrieve(query, top_k=top_k, doc_ids=doc_ids)
    
    for i, r in enumerate(results):
        r["ref_id"] = f"Vector-{i+1:03d}"
        r["retrieval_type"] = "vector"
    
    return results


async def retrieve_bm25_only(
    query: str,
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
) -> List[dict]:
    """
    仅使用 BM25 检索
    
    Args:
        query: 检索查询
        top_k: 返回结果数量
        doc_ids: 可选，按文档ID过滤
    
    Returns:
        List[dict]: 检索结果
    """
    from backend.core.rag.bm25_retriever import retrieve_bm25
    results = await retrieve_bm25(query, top_k=top_k, doc_ids=doc_ids)
    
    for i, r in enumerate(results):
        r["ref_id"] = f"BM25-{i+1:03d}"
        r["retrieval_type"] = "bm25"
    
    return results
