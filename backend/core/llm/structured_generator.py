"""
结构化输出生成器 — 替代手写正则提取 JSON
使用 LangChain PromptTemplate + MiniMax LLM + PydanticOutputParser
支持模板功能
"""

import json
import re
from pathlib import Path
from typing import Optional
from tenacity import retry, stop_after_attempt, wait_exponential

from backend.config import settings
from backend.core.llm.manager import get_llm_manager
from backend.core.rag.pgvector_retriever import retrieve, retrieve_hybrid
from backend.core.validator.checker import validate_fault_tree
from backend.models.schemas import FaultTree, GenerateRequest

# 模板目录
TEMPLATES_DIR = Path(__file__).parent.parent.parent / "data" / "templates"


def load_template(template_id: str) -> Optional[dict]:
    """加载模板信息"""
    if not template_id:
        return None
    template_path = TEMPLATES_DIR / f"{template_id}.json"
    if not template_path.exists():
        return None
    with open(template_path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_template_context(template: dict) -> str:
    """构建模板上下文，注入到 Prompt 中"""
    if not template:
        return ""
    
    ctx = f"\n\n## 故障树模板参考: {template.get('name', '')}\n"
    ctx += f"模板类型: {template.get('description', '')}\n"
    
    # 添加常见底事件
    basic_events = template.get("common_basic_events", [])
    if basic_events:
        ctx += f"\n常见底事件（供参考）:\n"
        for event in basic_events[:15]:  # 限制数量
            ctx += f"- {event}\n"
    
    # 添加分析提示
    tips = template.get("analysis_tips", "")
    if tips:
        ctx += f"\n分析提示: {tips}\n"
    
    return ctx


# ─────────────────────────────────────────────
# Prompt 模板（强约束结构化输出 + Few-shot）
# ─────────────────────────────────────────────

SYSTEM_PROMPT = """你是工业设备故障分析专家，精通IEC 61025和GB/T 7829故障树分析规范。

## 核心能力
1. 将复杂顶事件分解为逻辑严密、**多层分类**的故障树
2. 正确区分 AND 门（所有子事件同时发生才触发）和 OR 门（任一子事件发生即触发）
3. 底事件（basic）不能再有子节点，必须是最底层不可再分的故障源
4. 故障树必须从顶事件自上而下构建，每一层都是对上一层事件的细化，并遵循“领域 → 子领域 → 底事件”的多层分类思路

## 故障树节点类型定义
- top: 顶事件，整个分析的起点，通常是系统失效或严重事故（如"电机无法启动"）
- intermediate: 中间事件，通过逻辑门将多个子事件连接的中间层事件
- basic: 底事件，最底层的故障原因，不可再分（如"电源线断开"、"轴承损坏"）

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

## 关键约束（必须遵守）
1. nodes 和 gates 数量要匹配（每个非顶层节点必须在 gates 中有对应入口）
2. 顶事件只能有1个，其 type 必须是 "top"
3. 每个中间事件和底事件必须至少有一个父级 gate
4. 每个 gate 必须有至少2个输入节点
5. 底事件（basic）不能出现在任何 gate 的 input_nodes 中作为输出
6. 禁止循环依赖（A→B→A）
7. **顶层下必须先按“领域”进行分类**，例如：电源与供电/控制与通讯/机械本体/液压气动/环境与外部/其他；再在各领域下细分子领域，然后才是底事件
8. **最少三层**：top → 至少1层 intermediate（领域） → basic（底事件）。若底事件超过6个，必须引入第二层 intermediate 进行归类
9. confidence 反映你对这次分析的确信程度，低于0.5请谨慎使用

## Few-shot 示例（学习输出格式）

### 示例1：电机无法启动
输入：顶事件="电机无法启动"
输出：
{
  "top_event": "电机无法启动",
  "nodes": [
    {"id": "N001", "type": "top", "name": "电机无法启动", "description": "电机接通电源后无法正常运转", "source_ref": null},
    {"id": "N002", "type": "intermediate", "name": "电源供电异常", "description": "电机未获得正常供电", "source_ref": null},
    {"id": "N003", "type": "intermediate", "name": "电机本体故障", "description": "电机机械或电气部件损坏", "source_ref": null},
    {"id": "N004", "type": "basic", "name": "电源开关未闭合", "description": "主电源开关处于断开状态", "source_ref": null},
    {"id": "N005", "type": "basic", "name": "缺相运行", "description": "三相电源某一相缺失", "source_ref": null},
    {"id": "N006", "type": "basic", "name": "电压不足", "description": "供电电压低于额定值", "source_ref": null},
    {"id": "N007", "type": "basic", "name": "轴承损坏", "description": "电机轴承磨损或破裂", "source_ref": null},
    {"id": "N008", "type": "basic", "name": "绕组短路", "description": "电机绕组发生短路故障", "source_ref": null},
    {"id": "N009", "type": "basic", "name": "转子卡死", "description": "转子被异物卡住或变形", "source_ref": null}
  ],
  "gates": [
    {"id": "G001", "type": "OR", "output_node": "N001", "input_nodes": ["N002", "N003"]},
    {"id": "G002", "type": "OR", "output_node": "N002", "input_nodes": ["N004", "N005", "N006"]},
    {"id": "G003", "type": "OR", "output_node": "N003", "input_nodes": ["N007", "N008", "N009"]}
  ],
  "confidence": 0.92,
  "analysis_summary": "电机无法启动主要分为电源供电异常和电机本体故障两大类原因。"
}

### 示例2：液压系统无压力
输入：顶事件="液压系统无压力"
输出：
{
  "top_event": "液压系统无压力",
  "nodes": [
    {"id": "N001", "type": "top", "name": "液压系统无压力", "description": "液压系统无法建立工作压力", "source_ref": null},
    {"id": "N002", "type": "intermediate", "name": "液压泵故障", "description": "液压泵无法正常工作", "source_ref": null},
    {"id": "N003", "type": "intermediate", "name": "油箱故障", "description": "油箱油液异常", "source_ref": null},
    {"id": "N004", "type": "intermediate", "name": "控制阀组故障", "description": "控制阀组无法正常工作", "source_ref": null},
    {"id": "N005", "type": "basic", "name": "泵内磨损", "description": "液压泵内部零件磨损", "source_ref": null},
    {"id": "N006", "type": "basic", "name": "泵电机故障", "description": "驱动泵的电机故障", "source_ref": null},
    {"id": "N007", "type": "basic", "name": "油量不足", "description": "油箱油液位过低", "source_ref": null},
    {"id": "N008", "type": "basic", "name": "油液污染", "description": "油液含有杂质或水分", "source_ref": null},
    {"id": "N009", "type": "basic", "name": "阀芯卡滞", "description": "控制阀阀芯卡住", "source_ref": null},
    {"id": "N010", "type": "basic", "name": "阀内泄漏", "description": "控制阀内部泄漏", "source_ref": null}
  ],
  "gates": [
    {"id": "G001", "type": "OR", "output_node": "N001", "input_nodes": ["N002", "N003", "N004"]},
    {"id": "G002", "type": "OR", "output_node": "N002", "input_nodes": ["N005", "N006"]},
    {"id": "G003", "type": "OR", "output_node": "N003", "input_nodes": ["N007", "N008"]},
    {"id": "G004", "type": "OR", "output_node": "N004", "input_nodes": ["N009", "N010"]}
  ],
  "confidence": 0.88,
  "analysis_summary": "液压系统无压力主要源于泵故障、油箱故障和阀组故障三大方面。"
}

### 示例3：控制系统通讯中断
输入：顶事件="控制系统通讯中断"
输出：
{
  "top_event": "控制系统通讯中断",
  "nodes": [
    {"id": "N001", "type": "top", "name": "控制系统通讯中断", "description": "控制系统与现场设备之间通讯中断", "source_ref": null},
    {"id": "N002", "type": "intermediate", "name": "网络硬件故障", "description": "通讯网络硬件设备故障", "source_ref": null},
    {"id": "N003", "type": "intermediate", "name": "软件配置错误", "description": "通讯参数配置不当", "source_ref": null},
    {"id": "N004", "type": "intermediate", "name": "供电异常", "description": "通讯设备供电不正常", "source_ref": null},
    {"id": "N005", "type": "basic", "name": "网线损坏", "description": "以太网网线断裂或损坏", "source_ref": null},
    {"id": "N006", "type": "basic", "name": "交换机故障", "description": "网络交换机无法正常工作", "source_ref": null},
    {"id": "N007", "type": "basic", "name": "IP地址冲突", "description": "设备IP地址配置冲突", "source_ref": null},
    {"id": "N008", "type": "basic", "name": "波特率不匹配", "description": "通讯双方波特率设置不一致", "source_ref": null},
    {"id": "N009", "type": "basic", "name": "电源模块损坏", "description": "通讯设备电源模块故障", "source_ref": null},
    {"id": "N010", "type": "basic", "name": "供电线路断开", "description": "通讯设备供电线路断开", "source_ref": null}
  ],
  "gates": [
    {"id": "G001", "type": "OR", "output_node": "N001", "input_nodes": ["N002", "N003", "N004"]},
    {"id": "G002", "type": "OR", "output_node": "N002", "input_nodes": ["N005", "N006"]},
    {"id": "G003", "type": "OR", "output_node": "N003", "input_nodes": ["N007", "N008"]},
    {"id": "G004", "type": "OR", "output_node": "N004", "input_nodes": ["N009", "N010"]}
  ],
  "confidence": 0.85,
  "analysis_summary": "控制系统通讯中断主要由网络硬件、软件配置和供电异常三方面原因导致。"
}

## 重要提醒
- 学习以上示例的输出格式，严格按照JSON格式输出
- nodes中的id必须按序编号（如N001, N002...）
- gates中的input_nodes必须引用nodes中已定义的id
- 每个非top节点都必须被某个gate引用
- 只输出JSON，不要有任何其他文字
"""

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
) -> tuple[str, str]:
    """带指数退避重试的 LLM 调用，返回 (原始输出, 实际使用的 provider 名)"""
    manager = get_llm_manager()
    try:
        resp, provider = await manager.generate_with_fallback(full_prompt)
        return resp.content, provider
    except Exception as e:
        raise RuntimeError(f"第{attempt}次尝试失败: {str(e)}") from e


# ─────────────────────────────────────────────
# 主生成函数
# ─────────────────────────────────────────────

async def generate_fault_tree(req: GenerateRequest) -> tuple[FaultTree, list]:
    """
    RAG检索 + MiniMax LLM生成 + 三层校验，最多重试3次
    支持模板参数

    流程：
    1. 从 PostgreSQL 向量库检索相关知识片段
    2. 如果指定了模板，加载模板上下文
    3. 组装 SYSTEM + USER prompt 发给 MiniMax
    4. 从输出中提取 JSON，转换为 Pydantic 模型
    5. 三层逻辑校验（循环依赖、孤立节点、逻辑门）
    6. 任何环节失败自动重试，最多3次
    """
    # Step 1: RAG 检索
    top_k = req.rag_top_k or 5
    chunks = await retrieve(req.top_event, top_k=top_k, doc_ids=req.doc_ids)
    context = "\n\n".join(
        f"[{c['ref_id']}] (来源:{c['source']} 第{c['page']}页, 相似度:{c['score']})\n{c['text']}"
        for c in chunks
    )
    context_str = context or "暂无相关知识，请基于通用FTA规范和你的领域知识生成。"

    # Step 2: 加载模板上下文（可选）
    template = None
    template_context = ""
    if req.template_id:
        template = load_template(req.template_id)
        if template:
            template_context = build_template_context(template)

    # Step 3: 组装 prompt
    user_prompt = USER_PROMPT_TEMPLATE.format(
        context=context_str,
        top_event=req.top_event,
        user_prompt=req.user_prompt,
    )
    full_prompt = f"{SYSTEM_PROMPT}{template_context}\n\n{user_prompt}"

    # Step 3: 带重试的 LLM 调用
    last_error = None
    last_provider = None
    for attempt in range(1, settings.MAX_RETRY + 1):
        try:
            raw, provider = await _call_llm_with_retry(full_prompt, attempt)
            last_provider = provider
            data = extract_json(raw)
            ft = FaultTree(**data)

            # Step 4: 三层逻辑校验
            validation_result = validate_fault_tree(ft)
            return ft, validation_result["issues"], provider

        except json.JSONDecodeError as e:
            last_error = f"JSON解析失败: {e}"
            continue
        except Exception as e:
            last_error = str(e)
            continue

    # 全部重试失败
    raise RuntimeError(f"生成失败，已重试{settings.MAX_RETRY}次。最后错误: {last_error}")
