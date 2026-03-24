from pydantic import BaseModel
from typing import List, Optional, Literal

class FTANode(BaseModel):
    id: str
    type: Literal["top", "intermediate", "basic"]
    name: str
    description: str
    source_ref: Optional[str] = None

class FTAGate(BaseModel):
    id: str
    type: Literal["AND", "OR"]
    output_node: str
    input_nodes: List[str]

class FaultTree(BaseModel):
    top_event: str
    nodes: List[FTANode]
    gates: List[FTAGate]
    confidence: float
    analysis_summary: str

class GenerateRequest(BaseModel):
    top_event: str
    user_prompt: str
    doc_ids: Optional[List[str]] = None  # 指定知识来源文档
    template_id: Optional[str] = None     # 故障树模板ID（可选）
    rag_top_k: Optional[int] = 5          # RAG 检索的 Top K

class GenerateResponse(BaseModel):
    fault_tree: FaultTree
    mcs: List[List[str]]           # 最小割集
    importance: List[dict]          # 重要度排序
    validation_issues: List[str]    # 校验问题列表
    provider: Optional[str] = None   # 本次生成使用的 LLM Provider

class ValidationResult(BaseModel):
    is_valid: bool
    issues: List[dict]              # [{node_id, reason, suggestion}]

class UploadResponse(BaseModel):
    doc_id: str
    filename: str
    chunk_count: int
    status: str

class EditRequest(BaseModel):
    nodes: List[FTANode]
    gates: List[FTAGate]
    fault_tree: FaultTree
    mcs: Optional[List[List[str]]] = None
    importance: Optional[List[dict]] = None
    validation_issues: Optional[List[str]] = None
