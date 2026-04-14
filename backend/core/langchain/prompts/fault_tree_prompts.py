"""
故障树生成 Prompt 模板 - LangChain 标准格式

本模块提供：
- SYSTEM_PROMPT: 系统提示词（角色定义、约束规则、Few-shot 示例）
- USER_PROMPT_TEMPLATE: 用户提示模板
- chat_prompt: LangChain ChatPromptTemplate 对象
- load_template, build_template_context: 模板辅助函数
"""

from pathlib import Path
from typing import Optional, List
import json

from langchain_core.prompts import ChatPromptTemplate, PromptTemplate
from langchain_core.messages import SystemMessage, HumanMessage


# ─────────────────────────────────────────────
# 模板目录
# ─────────────────────────────────────────────

TEMPLATES_DIR = Path(__file__).parent.parent.parent.parent.parent / "data" / "templates"


# ─────────────────────────────────────────────
# System Prompt（从 structured_generator.py 迁移）
# ─────────────────────────────────────────────

SYSTEM_PROMPT = """你是工业设备故障分析专家，精通IEC 61025和GB/T 7829故障树分析规范。

## 核心能力
1. 将复杂顶事件分解为逻辑严密、**多层分类**的故障树
2. 正确区分 AND 门（所有子事件同时发生才触发）和 OR 门（任一子事件发生即触发）
3. 底事件（basic）不能再有子节点，必须是最底层不可再分的故障源
4. 故障树必须从顶事件自上而下构建，每一层都是对上一层事件的细化，并遵循"领域 → 子领域 → 底事件"的多层分类思路

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
7. **顶层下必须先按"领域"进行分类**，例如：电源与供电/控制与通讯/机械本体/液压气动/环境与外部/其他；再在各领域下细分子领域，然后才是底事件
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
    {"id": "N006", "type": "basic", "name": "轴承损坏", "description": "电机轴承磨损或破裂", "source_ref": null},
    {"id": "N007", "type": "basic", "name": "绕组短路", "description": "电机绕组发生短路故障", "source_ref": null}
  ],
  "gates": [
    {"id": "G001", "type": "OR", "output_node": "N001", "input_nodes": ["N002", "N003"]},
    {"id": "G002", "type": "OR", "output_node": "N002", "input_nodes": ["N004", "N005"]},
    {"id": "G003", "type": "OR", "output_node": "N003", "input_nodes": ["N006", "N007"]}
  ],
  "confidence": 0.92,
  "analysis_summary": "电机无法启动主要分为电源供电异常和电机本体故障两大类原因。"
}

## 重要提醒
- 学习以上示例的输出格式，严格按照JSON格式输出
- nodes中的id必须按序编号（如N001, N002...）
- gates中的input_nodes必须引用nodes中已定义的id
- 每个非top节点都必须被某个gate引用
- 只输出JSON，不要有任何其他文字
"""


# ─────────────────────────────────────────────
# User Prompt Template
# ─────────────────────────────────────────────

USER_PROMPT_TEMPLATE = """## 知识来源
{context}

## 任务
基于以上知识，针对顶事件：{top_event}
用户要求：{user_prompt}
生成完整的故障树。

请直接输出JSON，不要有任何其他内容："""


# ─────────────────────────────────────────────
# LangChain PromptTemplate 对象
# ─────────────────────────────────────────────

system_message = SystemMessage(content=SYSTEM_PROMPT)

# 使用 tuple 格式: ("role", "template") 或 ("role", PromptTemplate(...))
user_prompt_template = PromptTemplate(
    template=USER_PROMPT_TEMPLATE,
    input_variables=["context", "top_event", "user_prompt"],
)

# ChatPromptTemplate.from_messages() 只接受 Message 对象和 ("role", "template") 元组
chat_prompt = ChatPromptTemplate.from_messages([
    system_message,
    ("user", USER_PROMPT_TEMPLATE),
])


# ─────────────────────────────────────────────
# 辅助函数
# ─────────────────────────────────────────────

def load_template(template_id: str) -> Optional[dict]:
    """
    加载模板信息
    
    Args:
        template_id: 模板ID
    
    Returns:
        dict: 模板数据，如果不存在返回 None
    """
    if not template_id:
        return None
    template_path = TEMPLATES_DIR / f"{template_id}.json"
    if not template_path.exists():
        return None
    with open(template_path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_template_context(template: dict) -> str:
    """
    构建模板上下文，注入到 Prompt 中
    
    Args:
        template: 模板数据字典
    
    Returns:
        str: 格式化的模板上下文字符串
    """
    if not template:
        return ""
    
    ctx = f"\n\n## 故障树模板参考: {template.get('name', '')}\n"
    ctx += f"模板类型: {template.get('description', '')}\n"
    
    basic_events = template.get("common_basic_events", [])
    if basic_events:
        ctx += f"\n常见底事件（供参考）:\n"
        for event in basic_events[:15]:  # 限制数量
            ctx += f"- {event}\n"
    
    tips = template.get("analysis_tips", "")
    if tips:
        ctx += f"\n分析提示: {tips}\n"
    
    return ctx


def build_chat_prompt(
    context: str,
    top_event: str,
    user_prompt: str,
    template_id: Optional[str] = None,
) -> list:
    """
    构建完整的 Chat Prompt（兼容现有代码）
    
    Args:
        context: RAG 检索的上下文
        top_event: 顶事件
        user_prompt: 用户提示
        template_id: 可选，模板ID
    
    Returns:
        list: [SystemMessage, HumanMessage]
    """
    template_context = ""
    if template_id:
        template = load_template(template_id)
        if template:
            template_context = build_template_context(template)
    
    system_content = SYSTEM_PROMPT
    if template_context:
        system_content += template_context
    
    return [
        SystemMessage(content=system_content),
        HumanMessage(content=USER_PROMPT_TEMPLATE.format(
            context=context,
            top_event=top_event,
            user_prompt=user_prompt,
        )),
    ]
