"""
故障树生成链 - LangChain LCEL 实现

本模块提供：
- create_fault_tree_chain: 创建故障树生成 LCEL Chain
- generate_fault_tree_with_chain: 使用 Chain 生成故障树（带重试）
- get_fault_tree_chain: 获取全局 Chain 实例

Usage:
    from backend.core.langchain.chains.fault_tree_chain import (
        create_fault_tree_chain,
        generate_fault_tree_with_chain,
        get_fault_tree_chain,
    )
    
    # 方式1：使用全局实例
    chain = get_fault_tree_chain()
    
    # 方式2：自定义 Chain
    from backend.core.llm.llm_client import MiniMaxChatModel
    chat_model = MiniMaxChatModel()
    chain = create_fault_tree_chain(chat_model)
    
    # 方式3：带重试的生成
    result, issues = await generate_fault_tree_with_chain(
        chain=chain,
        top_event="电机无法启动",
        user_prompt="请生成完整的故障树",
    )
"""

import asyncio
from typing import Optional, List, Dict, Any, Union
from pathlib import Path

from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import Runnable, RunnableLambda

from backend.config import settings
from backend.models.schemas import FaultTree


# ─────────────────────────────────────────────
# Chain 创建
# ─────────────────────────────────────────────

def create_fault_tree_chain(
    chat_model: BaseChatModel,
    prompt: Optional[Any] = None,
    output_parser: Optional[Any] = None,
) -> Runnable:
    """
    创建故障树生成 LCEL Chain
    
    Chain 流程：
    1. 输入 dict (context, top_event, user_prompt)
    2. 组装 Prompt
    3. 调用 LLM
    4. 解析输出为 FaultTree 对象
    
    Args:
        chat_model: LangChain Chat Model（如 MiniMaxChatModel）
        prompt: ChatPromptTemplate（可选，默认使用 fault_tree_prompts）
        output_parser: Output Parser（可选）
    
    Returns:
        Runnable: 可执行的 LCEL Chain
    
    Example:
        from backend.core.llm.llm_client import MiniMaxChatModel
        chat_model = MiniMaxChatModel()
        chain = create_fault_tree_chain(chat_model)
        
        result = await chain.ainvoke({
            "context": "相关知识...",
            "top_event": "电机无法启动",
            "user_prompt": "请生成完整的故障树",
        })
    """
    # 导入默认 Prompt
    if prompt is None:
        from backend.core.langchain.prompts.fault_tree_prompts import chat_prompt
        prompt = chat_prompt
    
    # 导入默认 Parser
    if output_parser is None:
        from backend.core.langchain.output_parsers.fault_tree_parser import FaultTreeOutputParser
        output_parser = FaultTreeOutputParser()
    
    # 创建 LCEL Chain
    chain = (
        {
            "context": RunnableLambda(lambda x: x.get("context", "")),
            "top_event": RunnableLambda(lambda x: x.get("top_event", "")),
            "user_prompt": RunnableLambda(lambda x: x.get("user_prompt", "")),
        }
        | prompt
        | chat_model
        | RunnableLambda(lambda msg: msg.content if hasattr(msg, 'content') else str(msg))
        | RunnableLambda(lambda text: output_parser.parse_to_fault_tree(text))
    )
    
    return chain


# ─────────────────────────────────────────────
# 生成函数（带重试）
# ─────────────────────────────────────────────

async def generate_fault_tree_with_chain(
    chain: Runnable,
    top_event: str,
    user_prompt: str,
    context: Optional[str] = None,
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
    max_retries: int = 3,
    vector_weight: float = 0.5,
    template_id: Optional[str] = None,
) -> tuple[FaultTree, List[str]]:
    """
    使用 LCEL Chain 生成故障树（带重试）
    
    这是推荐的使用方式，自动处理 RAG 检索、Prompt 组装和错误重试。
    
    Args:
        chain: 已配置的 LCEL Chain
        top_event: 顶事件
        user_prompt: 用户提示
        context: 可选，预先检索的上下文
        top_k: RAG 检索数量
        doc_ids: 可选，按文档ID过滤
        max_retries: 最大重试次数
        vector_weight: 向量检索权重
        template_id: 可选，模板ID
    
    Returns:
        tuple[FaultTree, List[str]]: (故障树, 验证问题列表)
    
    Raises:
        RuntimeError: 所有重试都失败
    
    Example:
        chain = get_fault_tree_chain()
        result, issues = await generate_fault_tree_with_chain(
            chain=chain,
            top_event="电机无法启动",
            user_prompt="请生成完整的故障树",
            top_k=5,
        )
    """
    from backend.core.langchain.chains.retrieval_chain import retrieve_context
    from backend.core.validator.checker import validate_fault_tree
    
    last_error: Optional[Exception] = None
    
    for attempt in range(1, max_retries + 1):
        try:
            # Step 1: 检索上下文（首次或重试时）
            if context is None or attempt > 1:
                context = await retrieve_context(
                    query=top_event,
                    top_k=top_k,
                    doc_ids=doc_ids,
                    vector_weight=vector_weight,
                )
            
            # Step 2: 调用 Chain
            result = await chain.ainvoke({
                "context": context,
                "top_event": top_event,
                "user_prompt": user_prompt,
            })
            
            # Step 3: 校验
            validation_result = validate_fault_tree(result)
            issues = validation_result.get("issues", [])
            
            return result, [str(issue) for issue in issues]
            
        except Exception as e:
            last_error = e
            context = None  # 重试时重新检索
            continue
    
    raise RuntimeError(
        f"生成失败，已重试{max_retries}次。最后错误: {last_error}"
    )


async def generate_fault_tree_simple(
    top_event: str,
    user_prompt: str,
    provider: str = "minimax",
    top_k: int = 5,
    doc_ids: Optional[List[str]] = None,
    max_retries: int = 3,
    vector_weight: float = 0.5,
) -> tuple[FaultTree, List[str]]:
    """
    简化版的故障树生成（不需要预先创建 Chain）
    
    自动创建 Chain 并执行生成，适合一次性调用场景。
    
    Args:
        top_event: 顶事件
        user_prompt: 用户提示
        provider: LLM Provider
        top_k: RAG 检索数量
        doc_ids: 可选，按文档ID过滤
        max_retries: 最大重试次数
        vector_weight: 向量检索权重
    
    Returns:
        tuple[FaultTree, List[str]]: (故障树, 验证问题列表)
    
    Example:
        result, issues = await generate_fault_tree_simple(
            top_event="电机无法启动",
            user_prompt="请生成完整的故障树",
        )
    """
    from backend.core.llm.manager import ProviderFactory
    
    chat_model = ProviderFactory.get_chat_model(provider)
    chain = create_fault_tree_chain(chat_model)
    
    return await generate_fault_tree_with_chain(
        chain=chain,
        top_event=top_event,
        user_prompt=user_prompt,
        top_k=top_k,
        doc_ids=doc_ids,
        max_retries=max_retries,
        vector_weight=vector_weight,
    )


# ─────────────────────────────────────────────
# 全局 Chain 实例（延迟初始化）
# ─────────────────────────────────────────────

_fault_tree_chain: Optional[Runnable] = None


def get_fault_tree_chain(
    provider: Optional[str] = None,
    recreate: bool = False,
) -> Runnable:
    """
    获取全局故障树生成 Chain
    
    使用单例模式，避免重复创建 Chain 实例。
    
    Args:
        provider: LLM Provider（可选）
        recreate: 是否强制重新创建
    
    Returns:
        Runnable: 全局 Chain 实例
    
    Example:
        chain = get_fault_tree_chain()
        result = await chain.ainvoke({...})
    """
    global _fault_tree_chain
    
    if recreate:
        _fault_tree_chain = None
    
    if _fault_tree_chain is None:
        from backend.core.llm.manager import ProviderFactory
        
        provider = provider or settings.LLM_PROVIDER
        chat_model = ProviderFactory.get_chat_model(provider)
        _fault_tree_chain = create_fault_tree_chain(chat_model)
    
    return _fault_tree_chain


def reset_fault_tree_chain():
    """重置全局 Chain 实例（用于测试或配置变更后）"""
    global _fault_tree_chain
    _fault_tree_chain = None


# ─────────────────────────────────────────────
# 模板支持
# ─────────────────────────────────────────────

def load_template(template_id: str) -> Optional[dict]:
    """加载模板信息"""
    if not template_id:
        return None
    
    TEMPLATES_DIR = Path(__file__).parent.parent.parent.parent.parent / "data" / "templates"
    template_path = TEMPLATES_DIR / f"{template_id}.json"
    
    if not template_path.exists():
        return None
    
    import json
    with open(template_path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_template_context(template: dict) -> str:
    """构建模板上下文"""
    if not template:
        return ""
    
    ctx = f"\n\n## 故障树模板参考: {template.get('name', '')}\n"
    ctx += f"模板类型: {template.get('description', '')}\n"
    
    basic_events = template.get("common_basic_events", [])
    if basic_events:
        ctx += f"\n常见底事件（供参考）:\n"
        for event in basic_events[:15]:
            ctx += f"- {event}\n"
    
    tips = template.get("analysis_tips", "")
    if tips:
        ctx += f"\n分析提示: {tips}\n"
    
    return ctx
