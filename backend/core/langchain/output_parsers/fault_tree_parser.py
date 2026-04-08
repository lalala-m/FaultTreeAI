"""
故障树输出解析器 - LangChain PydanticOutputParser 封装

本模块提供：
- FaultTreeOutputParser: 故障树输出解析器
- FaultTreeSchema: LangChain Pydantic Schema
- get_fault_tree_parser: 获取全局解析器实例
"""

import json
import re
from typing import List, Literal, Optional, Any, Dict
from pydantic import BaseModel, Field, ValidationError

from langchain_core.output_parsers import PydanticOutputParser

from backend.models.schemas import FaultTree, FTANode, FTAGate


# ─────────────────────────────────────────────
# LangChain Pydantic Schema
# ─────────────────────────────────────────────

class FTANodeSchema(BaseModel):
    """LangChain 输出的节点 Schema"""
    id: str
    type: Literal["top", "intermediate", "basic"]
    name: str
    description: str = ""
    source_ref: Optional[str] = None


class FTAGateSchema(BaseModel):
    """LangChain 输出的门 Schema"""
    id: str
    type: Literal["AND", "OR"]
    output_node: str
    input_nodes: List[str]


class FaultTreeSchema(BaseModel):
    """LangChain 输出的故障树 Schema"""
    top_event: str
    nodes: List[FTANodeSchema]
    gates: List[FTAGateSchema]
    confidence: float = Field(ge=0.0, le=1.0)
    analysis_summary: str = ""


# ─────────────────────────────────────────────
# 输出解析器
# ─────────────────────────────────────────────

class FaultTreeOutputParser:
    """
    故障树输出解析器
    
    使用 LangChain PydanticOutputParser 进行结构化输出解析，
    同时保留手动 JSON 解析作为后备方案。
    
    Usage:
        parser = FaultTreeOutputParser()
        result = parser.parse(llm_output)
        fault_tree = parser.parse_to_fault_tree(llm_output)
    """

    def __init__(self):
        self.parser = PydanticOutputParser(pydantic_object=FaultTreeSchema)

    @property
    def format_instructions(self) -> str:
        """
        获取格式说明
        
        Returns:
            str: 用于注入 Prompt 的格式说明
        """
        return self.parser.get_format_instructions()

    def _clean_output(self, text: str) -> str:
        """
        清理 LLM 输出，提取 JSON
        
        处理以下情况：
        - Markdown 代码块包裹 (```json ... ```)
        - 前后空白字符
        - JSON 前后可能有解释文字
        
        Args:
            text: LLM 原始输出
        
        Returns:
            str: 清理后的 JSON 字符串
        """
        text = text.strip()
        
        # 去掉 markdown 代码块包裹
        if text.startswith("```"):
            lines = text.split("\n")
            # 处理 ```json 或 ```python 等情况
            if len(lines) > 1:
                text = "\n".join(lines[1:])
            # 去掉结尾的 ```
            if text.strip().endswith("```"):
                text = text.rsplit("```", 1)[0]
        
        text = text.strip()
        
        # 提取 JSON（处理 JSON 前有解释文字的情况）
        json_match = re.search(r'\{[\s\S]*\}', text)
        if json_match:
            return json_match.group()
        
        return text

    def parse(self, text: str) -> FaultTreeSchema:
        """
        解析 LLM 输出为 Pydantic 模型
        
        优先使用 LangChain PydanticOutputParser，
        如果失败则尝试手动 JSON 解析。
        
        Args:
            text: LLM 原始输出
        
        Returns:
            FaultTreeSchema: 解析后的故障树 Schema
        
        Raises:
            ValueError: 无法解析为有效的 JSON 或 Schema
        """
        cleaned = self._clean_output(text)
        
        # 首先尝试 LangChain PydanticOutputParser
        try:
            return self.parser.parse(cleaned)
        except Exception:
            pass
        
        # 后备：手动 JSON 解析
        try:
            data = json.loads(cleaned)
            return FaultTreeSchema(**data)
        except json.JSONDecodeError as json_err:
            raise ValueError(f"无法解析 LLM 输出为 JSON: {json_err}\n原始输出: {text[:200]}...")
        except ValidationError as val_err:
            raise ValueError(f"JSON 结构不符合预期: {val_err}\n原始输出: {text[:200]}...")

    def parse_to_fault_tree(self, text: str) -> FaultTree:
        """
        解析为业务模型 FaultTree
        
        将 LangChain Schema 转换为业务使用的 FaultTree 模型。
        
        Args:
            text: LLM 原始输出
        
        Returns:
            FaultTree: 业务故障树模型
        
        Raises:
            ValueError: 解析失败
        """
        schema = self.parse(text)
        
        # 转换为业务模型
        nodes = [
            FTANode(
                id=n.id,
                type=n.type,
                name=n.name,
                description=n.description,
                source_ref=n.source_ref,
            )
            for n in schema.nodes
        ]
        
        gates = [
            FTAGate(
                id=g.id,
                type=g.type,
                output_node=g.output_node,
                input_nodes=g.input_nodes,
            )
            for g in schema.gates
        ]
        
        return FaultTree(
            top_event=schema.top_event,
            nodes=nodes,
            gates=gates,
            confidence=schema.confidence,
            analysis_summary=schema.analysis_summary,
        )

    def parse_with_fallback(
        self, 
        text: str, 
        fallback_value: Optional[FaultTree] = None
    ) -> FaultTree:
        """
        带后备方案的解析
        
        如果解析失败，返回后备值而不是抛出异常。
        
        Args:
            text: LLM 原始输出
            fallback_value: 解析失败时返回的后备值
        
        Returns:
            FaultTree: 解析结果或后备值
        """
        try:
            return self.parse_to_fault_tree(text)
        except Exception as e:
            if fallback_value is not None:
                return fallback_value
            raise

    @staticmethod
    def extract_json(text: str) -> dict:
        """
        静态方法：从文本中提取 JSON（兼容旧代码）
        
        Args:
            text: 包含 JSON 的文本
        
        Returns:
            dict: 提取的 JSON 数据
        
        Raises:
            ValueError: 未找到 JSON
        """
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
# 全局单例
# ─────────────────────────────────────────────

_fault_tree_parser: Optional[FaultTreeOutputParser] = None


def get_fault_tree_parser() -> FaultTreeOutputParser:
    """
    获取全局故障树解析器实例（延迟初始化）
    
    Returns:
        FaultTreeOutputParser: 全局解析器实例
    """
    global _fault_tree_parser
    if _fault_tree_parser is None:
        _fault_tree_parser = FaultTreeOutputParser()
    return _fault_tree_parser


def reset_fault_tree_parser():
    """重置全局解析器实例（用于测试）"""
    global _fault_tree_parser
    _fault_tree_parser = None
