"""
结构化输出生成器 — 替代手写正则提取 JSON
使用 LangChain PromptTemplate + MiniMax LLM + PydanticOutputParser
"""

import json
import re
from typing import Optional
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings
from core.llm.llm_client import llm_client
from core.rag.pgvector_retriever import retrieve
from core.validator.checker import validate_fault_tree
from models.schemas import FaultTree, GenerateRequest


# ─────────────────────────────────────────────
# Prompt 模板（强约束结构化输出）
# ─────────────────────────────────────────────

SYSTEM_PROMPT = """你是工业设备故障分析专家，精通IEC 61025和GB/T 7829故障树分析规范。

## 核心能力
1. 将复杂顶事件分解为逻辑严密的故障树
2. 正确区分 AND 门（所有子事件同时发生才触发）和 OR 门（任一子事件发生即触发）
3. 底事件（basic）不能再有子节点，必须是最底层不可再分的故障源

## 故障树节点类型定义
- top: 顶事件，整个分析的起点，通常是系统失效或严重事故
- intermediate: 中间事件，通过逻辑门将多个子事件连接的中间层事件
- basic: 底事件，最底层的故障原因，不可再分

## 输出格式（严格遵守）
你必须且只能输出一个有效的JSON对象，不能包含任何解释文字、代码块标记或额外内容：

{
  "top_event": "顶事件名称",
  "nodes": [
    {
      "id": "N001",
      "type": "top|intermediate|basic",
      "name": "事件名称（简洁专业）",
      "description": "事件详细描述",
      "source_ref": "REF001或null"
    }
  ],
  "gates": [
    {
      "id": "G001",
      "type": "AND|OR",
      "output_node": "N001",
      "input_nodes": ["N002", "N003"]
    }
  ],
  "confidence": 0.0到1.0之间的置信度值,
  "analysis_summary": "简要分析说明（50字以内）"
}

## 关键约束
- nodes 和 gates 数量要匹配（每个非顶层节点必须在 gates 中有对应入口）
- 顶事件只能有1个，其 type 必须是 "top"
- 每个中间事件和底事件必须至少有一个父级 gate
- 每个 gate 必须有至少2个输入节点
- confidence 反映你对这次分析的确信程度，低于0.5请谨慎使用"""

USER_PROMPT_TEMPLATE = """## 知识来源
{context}

## 任务
基于以上知识，针对顶事件：{top_event}
用户要求：{user_prompt}
生成完整的故障树。

请直接输出JSON，不要有任何其他内容："""


# ─────────────────────────────────────────────
# JSON 提取（带格式化修复）
# ─────────────────────────────────────────────

def extract_json(text: str) -> dict:
    """从 LLM 输出中提取 JSON，处理 Markdown 代码块包裹"""
    # 去掉 markdown 代码块包裹
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
    text = text.strip()

    match = re.search(r'\{[\s\S]*\}', text)
    if not match:
        raise ValueError("LLM输出中未找到JSON")
    return json.loads(match.group())


# ─────────────────────────────────────────────
# 带重试的生成函数
# ─────────────────────────────────────────────

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=20),
    reraise=True,
)
async def _call_llm_with_retry(
    full_prompt: str,
    attempt: int,
) -> str:
    """带指数退避重试的 LLM 调用"""
    try:
        return await llm_client.agenerate(full_prompt)
    except Exception as e:
        raise RuntimeError(f"第{attempt}次尝试失败: {str(e)}") from e


# ─────────────────────────────────────────────
# 主生成函数
# ─────────────────────────────────────────────

async def generate_fault_tree(req: GenerateRequest) -> tuple[FaultTree, list]:
    """
    RAG检索 + MiniMax LLM生成 + 三层校验，最多重试3次

    流程：
    1. 从 PostgreSQL 向量库检索相关知识片段
    2. 组装 SYSTEM + USER prompt 发给 MiniMax
    3. 从输出中提取 JSON，转换为 Pydantic 模型
    4. 三层逻辑校验（循环依赖、孤立节点、逻辑门）
    5. 任何环节失败自动重试，最多3次
    """
    # Step 1: RAG 检索
    chunks = await retrieve(req.top_event, doc_ids=req.doc_ids)
    context = "\n\n".join(
        f"[{c['ref_id']}] (来源:{c['source']} 第{c['page']}页, 相似度:{c['score']})\n{c['text']}"
        for c in chunks
    )
    context_str = context or "暂无相关知识，请基于通用FTA规范和你的领域知识生成。"

    # Step 2: 组装 prompt
    user_prompt = USER_PROMPT_TEMPLATE.format(
        context=context_str,
        top_event=req.top_event,
        user_prompt=req.user_prompt,
    )
    full_prompt = f"{SYSTEM_PROMPT}\n\n{user_prompt}"

    # Step 3: 带重试的 LLM 调用
    last_error = None
    for attempt in range(1, settings.MAX_RETRY + 1):
        try:
            raw = await _call_llm_with_retry(full_prompt, attempt)
            data = extract_json(raw)
            ft = FaultTree(**data)

            # Step 4: 三层逻辑校验
            validation_result = validate_fault_tree(ft)
            return ft, validation_result["issues"]

        except json.JSONDecodeError as e:
            last_error = f"JSON解析失败: {e}"
            continue
        except Exception as e:
            last_error = str(e)
            continue

    # 全部重试失败
    raise RuntimeError(f"生成失败，已重试{settings.MAX_RETRY}次。最后错误: {last_error}")
