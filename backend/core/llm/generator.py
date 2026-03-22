import json
import re
from backend.core.llm.ollama_client import ollama_client
from backend.core.rag.retriever import retrieve
from backend.core.validator.checker import validate_fault_tree
from backend.models.schemas import FaultTree, GenerateRequest
from backend.config import settings

PROMPT_TEMPLATE = """你是工业设备故障分析专家，精通IEC 61025故障树分析规范。

## 知识来源
{context}

## 任务
基于以上知识，针对顶事件"{top_event}"，按照用户要求"{user_prompt}"，生成符合FTA规范的完整故障树。

## 输出要求
严格按以下JSON格式输出，禁止输出任何其他内容：

{{
  "top_event": "顶事件名称",
  "nodes": [
    {{
      "id": "N001",
      "type": "top|intermediate|basic",
      "name": "事件名称",
      "description": "事件描述",
      "source_ref": "REF001或null"
    }}
  ],
  "gates": [
    {{
      "id": "G001",
      "type": "AND|OR",
      "output_node": "N001",
      "input_nodes": ["N002", "N003"]
    }}
  ],
  "confidence": 0.85,
  "analysis_summary": "简要分析说明"
}}"""

def _extract_json(text: str) -> dict:
    """从LLM输出中提取JSON"""
    match = re.search(r'\{[\s\S]*\}', text)
    if not match:
        raise ValueError("LLM输出中未找到JSON")
    return json.loads(match.group())

async def generate_fault_tree(req: GenerateRequest) -> tuple[FaultTree, list]:
    """RAG检索 + LLM生成 + 校验，最多重试3次"""
    chunks = await retrieve(req.top_event, doc_ids=req.doc_ids)
    context = "\n\n".join(
        f"[{c['ref_id']}] (来源:{c['source']} 第{c['page']}页)\n{c['text']}"
        for c in chunks
    )

    prompt = PROMPT_TEMPLATE.format(
        context=context or "暂无相关知识，请基于通用FTA规范生成。",
        top_event=req.top_event,
        user_prompt=req.user_prompt
    )

    last_error = None
    for attempt in range(settings.MAX_RETRY):
        try:
            raw = await ollama_client.generate(prompt)
            data = _extract_json(raw)
            ft = FaultTree(**data)
            result = validate_fault_tree(ft)
            return ft, result["issues"]
        except Exception as e:
            last_error = e
            continue

    raise RuntimeError(f"生成失败，已重试{settings.MAX_RETRY}次: {last_error}")
