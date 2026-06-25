from pydantic import BaseModel
from typing import List, Optional, Literal

class Position(BaseModel):
    x: float
    y: float

class FTANode(BaseModel):
    id: str
    type: Literal["top", "intermediate", "basic"]
    name: str
    description: str
    source_ref: Optional[str] = None
    position: Optional[Position] = None

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
    provider: Optional[str] = None        # 指定调用的 LLM Provider（如 'minimax' / 'ollama'）
    use_fallback: Optional[bool] = True   # 失败时是否允许自动回退
    manual_weight: Optional[float] = None # 文档权重(0.0~1.0)，用于混合检索时的向量占比

class GenerateResponse(BaseModel):
    tree_id: Optional[str] = None
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


# ── 二次澄清（Clarify）相关 ────────────────────────

class ClarifyQuestion(BaseModel):
    id: str                       # 问题 ID，前端回传答案时用
    text: str                     # 问题正文，如 "异响是连续的还是间歇的？"
    hint: str = ""                # 输入提示，如 "如：沉闷、尖锐、间歇3秒一次"
    required: bool = False        # 是否必填


class ClarifyRequest(BaseModel):
    top_event: str                # 用户的原始问题描述
    doc_ids: Optional[List[str]] = None   # 指定知识来源文档
    provider: Optional[str] = None        # 指定 LLM Provider
    rag_top_k: Optional[int] = 3          # 是否用 RAG 上下文辅助生成澄清问题
    max_questions: Optional[int] = 4      # 最多生成几个问题（2~5）


class ClarifyResponse(BaseModel):
    questions: List[ClarifyQuestion]
    refined_query_hint: str = ""  # LLM 给出的"完善后的查询"提示，便于后续 generate
    provider: Optional[str] = None
    raw_intro: str = ""           # 助手开场白，如 "为了更精准地分析，请补充以下信息："
