"""
基础数据模型 - 被 manager.py 和 providers/ 依赖
"""

from dataclasses import dataclass
from typing import Optional, List, Any


@dataclass
class LLMResponse:
    """LLM 生成响应"""
    content: str
    latency_ms: float
    raw: Optional[Any] = None


@dataclass
class EmbedResult:
    """Embedding 结果"""
    embedding: List[float]
    latency_ms: float
    model: str = ""


@dataclass
class BenchmarkResult:
    """Provider 性能基准测试结果"""
    provider: str
    total_requests: int
    success_count: int
    parseable_json_count: int
    avg_latency_ms: float
    min_latency_ms: float = 0.0
    max_latency_ms: float = 0.0
    errors: List[str] = None
    field_completeness: float = 0.0


class BaseLLMProvider:
    """LLM Provider 基类（向后兼容）"""

    name: str = ""

    def is_available(self) -> bool:
        """检查 Provider 是否可用"""
        raise NotImplementedError

    async def generate(self, prompt: str, **kwargs) -> LLMResponse:
        """生成文本"""
        raise NotImplementedError

    async def embed(self, text: str) -> EmbedResult:
        """单条向量化"""
        raise NotImplementedError

    async def embed_batch(self, texts: list) -> list[EmbedResult]:
        """批量向量化"""
        raise NotImplementedError
