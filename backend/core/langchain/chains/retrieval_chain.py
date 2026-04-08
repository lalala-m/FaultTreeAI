"""
RAG 检索链 - LangChain LCEL 实现

本模块提供：
- retrieve_context: 检索上下文知识
- retrieval_chain: LCEL 检索链对象

Usage:
    from backend.core.langchain.chains.retrieval_chain import retrieve_context
    context = await retrieve_context("电机故障", top_k=5)
"""

from typing import List, Optional, Dict, Any
from langchain_core.runnables import RunnableLambda
from langchain_core.output_parsers import StrOutputParser

from backend.config import settings


# ─────────────────────────────────────────────
# 检索函数
# ─────────────────────────────────────────────

async def retrieve_context(
    query: str,
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
    vector_weight: float = 0.5,
) -> str:
    """
    检索上下文知识
    
    使用混合检索（向量 + BM25）获取与查询相关的上下文。
    
    Args:
        query: 检索查询（通常为顶事件）
        top_k: 返回结果数量
        doc_ids: 可选，按文档ID过滤
        vector_weight: 向量检索权重（0-1），BM25 权重为 1-vector_weight
    
    Returns:
        str: 格式化的上下文字符串
        
    Example:
        context = await retrieve_context("电机无法启动", top_k=5)
        # 返回:
        # [REF001] (来源:电机手册.pdf 第10页, 相似度:0.95)
        # 电机无法启动可能由电源故障、机械故障等原因引起...
    """
    from backend.core.rag.hybrid_retriever import retrieve_hybrid
    
    chunks = await retrieve_hybrid(
        query=query,
        top_k=top_k,
        doc_ids=doc_ids,
        vector_weight=vector_weight,
    )
    
    if not chunks:
        return "暂无相关知识，请基于通用FTA规范和你的领域知识生成。"
    
    context_parts = []
    for i, c in enumerate(chunks):
        part = f"[{c.get('ref_id', f'REF{i+1:03d}')}] "
        part += f"(来源:{c.get('source', 'unknown')} "
        part += f"第{c.get('page', 0)}页, "
        part += f"相似度:{c.get('score', 0):.4f})\n"
        part += c.get('text', '')
        context_parts.append(part)
    
    return "\n\n".join(context_parts)


async def retrieve_with_metadata(
    query: str,
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
    vector_weight: float = 0.5,
) -> Dict[str, Any]:
    """
    检索并返回完整元数据
    
    与 retrieve_context 不同，此函数返回原始 chunks 数据，
    便于调用方进行更灵活的处理。
    
    Args:
        query: 检索查询
        top_k: 返回结果数量
        doc_ids: 可选，按文档ID过滤
        vector_weight: 向量检索权重
    
    Returns:
        Dict[str, Any]: 包含 context, chunks, count 的字典
        
    Example:
        result = await retrieve_with_metadata("电机故障", top_k=5)
        print(result["count"])  # 5
        print(result["chunks"][0]["source"])  # "电机手册.pdf"
    """
    from backend.core.rag.hybrid_retriever import retrieve_hybrid
    
    chunks = await retrieve_hybrid(
        query=query,
        top_k=top_k,
        doc_ids=doc_ids,
        vector_weight=vector_weight,
    )
    
    context = await retrieve_context(query, top_k, doc_ids, vector_weight)
    
    return {
        "context": context,
        "chunks": chunks,
        "count": len(chunks),
    }


# ─────────────────────────────────────────────
# LCEL Chain（基础版本）
# ─────────────────────────────────────────────

retrieval_chain = RunnableLambda(
    lambda inputs: retrieve_context(
        query=inputs.get("query", ""),
        top_k=inputs.get("top_k", settings.RAG_TOP_K),
        doc_ids=inputs.get("doc_ids"),
        vector_weight=inputs.get("vector_weight", settings.RAG_VECTOR_WEIGHT),
    )
) | StrOutputParser()


# ─────────────────────────────────────────────
# 带元数据的 LCEL Chain
# ─────────────────────────────────────────────

retrieval_chain_with_metadata = RunnableLambda(
    lambda inputs: retrieve_with_metadata(
        query=inputs.get("query", ""),
        top_k=inputs.get("top_k", settings.RAG_TOP_K),
        doc_ids=inputs.get("doc_ids"),
        vector_weight=inputs.get("vector_weight", settings.RAG_VECTOR_WEIGHT),
    )
)
