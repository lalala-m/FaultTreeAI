"""
LLM Provider 抽象基类 — 所有 Provider 必须实现此接口
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional
import time


@dataclass
class LLMResponse:
    content: str
    latency_ms: float
    cost_tokens: Optional[int] = None
    raw: Optional[dict] = None


@dataclass
class EmbedResult:
    embedding: list[float]
    latency_ms: float
    model: str


class BaseLLMProvider(ABC):
    """LLM Provider 抽象基类"""

    name: str = "base"

    @abstractmethod
    async def generate(self, prompt: str, **kwargs) -> LLMResponse:
        """同步生成（非流式）"""
        raise NotImplementedError

    @abstractmethod
    async def embed(self, text: str) -> EmbedResult:
        """单条向量化"""
        raise NotImplementedError

    @abstractmethod
    async def embed_batch(self, texts: list[str]) -> list[EmbedResult]:
        """批量向量化"""
        raise NotImplementedError

    def is_available(self) -> bool:
        """检查 Provider 是否可用（如 API Key 配置、连接正常）"""
        return True


@dataclass
class BenchmarkResult:
    provider: str
    total_requests: int
    success_count: int
    parseable_json_count: int
    avg_latency_ms: float
    min_latency_ms: float = 0.0
    max_latency_ms: float = 0.0
    errors: list[str] = field(default_factory=list)
    field_completeness: float = 0.0  # 业务字段完整度 0-1
