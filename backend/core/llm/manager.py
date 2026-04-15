"""
LLM Provider 管理器 - 支持多 Provider + 自动回退 + A/B 对比

提供两种接口：
1. ProviderFactory: LangChain 标准接口（推荐新代码使用）
2. LLMManager: 现有接口（向后兼容）
"""

import time
import json
import re
import asyncio
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field
from backend.config import settings
from backend.core.llm.base_provider import (
    BaseLLMProvider,
    LLMResponse,
    EmbedResult,
    BenchmarkResult,
)
from backend.core.llm.providers import OllamaProvider, MiniMaxProvider, OpenAIProvider


# ─────────────────────────────────────────────
# Provider 注册表
# ─────────────────────────────────────────────

_PROVIDER_REGISTRY: dict[str, type[BaseLLMProvider]] = {
    "ollama": OllamaProvider,
    "minimax": MiniMaxProvider,
    "openai": OpenAIProvider,
}


# ─────────────────────────────────────────────
# LangChain 标准接口 - ProviderFactory
# ─────────────────────────────────────────────

class ProviderFactory:
    """
    LangChain 风格 Provider 工厂
    
    Usage:
        from backend.core.llm.manager import ProviderFactory
        
        # 获取 ChatModel
        chat_model = ProviderFactory.get_chat_model("minimax")
        
        # 获取 Embeddings
        embeddings = ProviderFactory.get_embeddings("minimax")
        
        # 列出支持的 Provider
        print(ProviderFactory.list_chat_providers())
        print(ProviderFactory.list_embed_providers())
    """

    _chat_instances: Dict[str, Any] = {}
    _embed_instances: Dict[str, Any] = {}

    @classmethod
    def get_chat_model(cls, provider: Optional[str] = None) -> Any:
        """
        获取 ChatModel 实例
        
        Args:
            provider: Provider 名称，支持 "minimax", "ollama", "openai", "azure_openai"
        
        Returns:
            BaseChatModel: ChatModel 实例
        """
        provider = (provider or settings.LLM_PROVIDER).lower()
        
        if provider in cls._chat_instances:
            return cls._chat_instances[provider]
        
        if provider == "minimax":
            from backend.core.llm.llm_client import MiniMaxChatModel
            instance = MiniMaxChatModel()
        elif provider == "ollama":
            from backend.core.llm.llm_client import OllamaChatModel
            instance = OllamaChatModel()
        elif provider == "openai":
            from langchain_openai import ChatOpenAI
            instance = ChatOpenAI(
                model=settings.LLM_MODEL,
                api_key=settings.OPENAI_API_KEY,
                base_url=settings.OPENAI_BASE_URL,
                temperature=settings.LLM_TEMPERATURE,
                max_tokens=settings.LLM_MAX_TOKENS,
                timeout=120,
            )
        elif provider == "azure_openai":
            from langchain_openai import AzureChatOpenAI
            instance = AzureChatOpenAI(
                azure_deployment=settings.AZURE_OPENAI_DEPLOYMENT,
                openai_api_key=settings.AZURE_OPENAI_KEY,
                azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                api_version=settings.AZURE_OPENAI_API_VERSION,
                temperature=settings.LLM_TEMPERATURE,
                max_tokens=settings.LLM_MAX_TOKENS,
            )
        else:
            raise ValueError(f"不支持的 ChatModel Provider: {provider}，支持的: {cls.list_chat_providers()}")
        
        cls._chat_instances[provider] = instance
        return instance

    @classmethod
    def get_embeddings(cls, provider: Optional[str] = None) -> Any:
        """
        获取 Embeddings 实例
        
        Args:
            provider: Provider 名称，支持 "minimax", "ollama", "openai", "azure_openai"
        
        Returns:
            Embeddings: Embeddings 实例
        """
        from backend.core.llm.embeddings import UnifiedEmbeddings
        provider = (provider or settings.EMBED_PROVIDER or "minimax").lower()
        return UnifiedEmbeddings(provider=provider)

    @classmethod
    def list_chat_providers(cls) -> List[str]:
        """列出支持的 ChatModel Provider"""
        return ["minimax", "ollama", "openai", "azure_openai"]

    @classmethod
    def list_embed_providers(cls) -> List[str]:
        """列出支持的 Embeddings Provider"""
        return ["minimax", "ollama", "openai", "azure_openai"]

    @classmethod
    def reset(cls):
        """重置所有缓存实例"""
        cls._chat_instances.clear()
        cls._embed_instances.clear()


# ─────────────────────────────────────────────
# 向后兼容别名
# ─────────────────────────────────────────────

LLMManager = None  # 延迟导入，见下方


# ─────────────────────────────────────────────
# LLMManager（向后兼容）
# ─────────────────────────────────────────────

@dataclass
class GenerationMetrics:
    provider: str
    latency_ms: float
    success: bool
    parseable: bool
    field_score: float = 0.0
    error: str = ""


class LLMManager:
    """
    多 Provider 统一管理器（向后兼容）
    
    保留现有功能：
    - primary / fallback 双轨配置
    - 自动回退：主 Provider 失败自动切换
    - A/B 对比：同一批 prompt 对比多个 Provider
    - 统计汇总 BenchmarkResult
    """

    def __init__(
        self,
        primary: Optional[str] = None,
        fallback: Optional[str] = None,
    ):
        self.primary_name = primary or settings.LLM_PROVIDER
        self.fallback_name = fallback or (
            settings.LLM_FALLBACK_PROVIDER
            if settings.LLM_FALLBACK_PROVIDER
            else self._infer_fallback(self.primary_name)
        )
        self._instances: Dict[str, BaseLLMProvider] = {}
        self._metrics_history: List[GenerationMetrics] = []

    def _infer_fallback(self, primary: str) -> str:
        if primary == "ollama":
            return "minimax"
        return "ollama"

    # ── 实例获取 ──────────────────────────────────────────

    def get_provider(self, name: Optional[str] = None) -> BaseLLMProvider:
        name = (name or self.primary_name).lower()
        if name not in self._instances:
            cls = _PROVIDER_REGISTRY.get(name.lower())
            if cls is None:
                raise ValueError(f"未知的 LLM Provider: {name}，可用: {list(_PROVIDER_REGISTRY)}")
            self._instances[name] = cls()
        return self._instances[name]

    @property
    def primary(self) -> BaseLLMProvider:
        return self.get_provider(self.primary_name)

    @property
    def fallback(self) -> BaseLLMProvider:
        return self.get_provider(self.fallback_name)

    # ── 核心接口 ───────────────────────────────────────────

    async def generate(
        self,
        prompt: str,
        provider: Optional[str] = None,
        **kwargs,
    ) -> LLMResponse:
        provider_name = (provider or self.primary_name).lower()
        status = await self.get_provider_status(provider_name)
        if not status["available"]:
            reason = status["reason"] or "Provider 当前不可用"
            raise RuntimeError(f"Provider [{provider_name}] 不可用: {reason}")
        p = self.get_provider(provider_name)
        return await p.generate(prompt, **kwargs)

    async def generate_with_fallback(
        self,
        prompt: str,
        **kwargs,
    ) -> tuple[LLMResponse, str]:
        provider_order: List[str] = []
        for name in [self.primary_name, self.fallback_name]:
            normalized = (name or "").lower()
            if normalized and normalized not in provider_order:
                provider_order.append(normalized)

        errors: List[str] = []
        labels = {
            self.primary_name.lower(): "主",
            self.fallback_name.lower(): "备用",
        }

        for provider_name in provider_order:
            status = await self.get_provider_status(provider_name)
            if not status["available"]:
                reason = status["reason"] or "可用性检测失败"
                errors.append(f"{labels.get(provider_name, '候选')} Provider [{provider_name}] 不可用: {reason}")
                self._record_metrics(provider_name, 0.0, success=False, error=reason)
                continue

            provider = self.get_provider(provider_name)
            try:
                resp = await provider.generate(prompt, **kwargs)
                self._record_metrics(provider_name, resp.latency_ms, success=True)
                return resp, provider_name
            except Exception as exc:
                reason = self._format_error(exc)
                errors.append(f"{labels.get(provider_name, '候选')} Provider [{provider_name}] 失败: {reason}")
                self._record_metrics(provider_name, 0.0, success=False, error=reason)

        raise RuntimeError("；".join(errors))

    async def get_provider_status(self, name: str) -> dict:
        provider_name = (name or "").lower()
        try:
            provider = self.get_provider(provider_name)
        except Exception as exc:
            return {
                "name": provider_name,
                "available": False,
                "reason": self._format_error(exc),
            }

        reason = None
        checker = getattr(provider, "is_available", None)
        available = True
        if callable(checker):
            try:
                available = bool(
                    await asyncio.wait_for(asyncio.to_thread(checker), timeout=3)
                )
            except asyncio.TimeoutError:
                available = False
                reason = "可用性检测超时"
            except Exception as exc:
                available = False
                reason = self._format_error(exc)

        if provider_name == "minimax":
            if not getattr(provider, "api_key", None) or not getattr(provider, "group_id", None):
                available = False
                reason = "缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID"
            elif not available and not reason:
                reason = "MiniMax 服务当前不可用"
        elif provider_name == "ollama":
            if not available and not reason:
                base_url = getattr(provider, "base_url", "")
                reason = f"Ollama 服务不可达: {base_url}" if base_url else "Ollama 服务不可达"

        return {
            "name": provider_name,
            "available": available,
            "reason": reason,
        }

    # ── Embedding ──────────────────────────────────────────

    async def embed(self, text: str, provider: Optional[str] = None) -> EmbedResult:
        return await self.get_provider(provider).embed(text)

    async def embed_batch(
        self, texts: List[str], provider: Optional[str] = None
    ) -> List[EmbedResult]:
        return await self.get_provider(provider).embed_batch(texts)

    # ── A/B 对比 ────────────────────────────────────────────

    async def benchmark_providers(
        self,
        prompts: List[str],
        providers: Optional[List[str]] = None,
    ) -> Dict[str, BenchmarkResult]:
        providers = providers or [self.primary_name, self.fallback_name]
        results: Dict[str, List[GenerationMetrics]] = {p: [] for p in providers}

        for prompt in prompts:
            tasks = [self._single_provider_bench(prompt, pname) for pname in providers]
            batch_results = await asyncio.gather(*tasks, return_exceptions=True)
            for pname, result in zip(providers, batch_results):
                if isinstance(result, Exception):
                    results[pname].append(
                        GenerationMetrics(
                            provider=pname,
                            latency_ms=0,
                            success=False,
                            parseable=False,
                            field_score=0.0,
                            error=str(result),
                        )
                    )
                else:
                    results[pname].append(result)

        return {
            pname: self._summarize(pname, metrics_list)
            for pname, metrics_list in results.items()
        }

    async def _single_provider_bench(
        self, prompt: str, provider_name: str
    ) -> GenerationMetrics:
        p = self.get_provider(provider_name)
        t0 = time.perf_counter()
        try:
            resp = await p.generate(prompt)
            latency_ms = (time.perf_counter() - t0) * 1000
            parseable, field_score = self._eval_response(resp.content)
            return GenerationMetrics(
                provider=provider_name,
                latency_ms=latency_ms,
                success=True,
                parseable=parseable,
                field_score=field_score,
            )
        except Exception as e:
            return GenerationMetrics(
                provider=provider_name,
                latency_ms=(time.perf_counter() - t0) * 1000,
                success=False,
                parseable=False,
                field_score=0.0,
                error=str(e),
            )

    def _eval_response(self, content: str) -> tuple[bool, float]:
        text = content.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
        text = text.strip()
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return False, 0.0
        try:
            data = json.loads(match.group())
        except Exception:
            return False, 0.0

        score = 0.0
        total_fields = 6
        if "top_event" in data and data["top_event"]:
            score += 1.0 / total_fields
        if "nodes" in data and isinstance(data["nodes"], list) and len(data["nodes"]) >= 3:
            score += 1.0 / total_fields
        if "gates" in data and isinstance(data["gates"], list) and len(data["gates"]) >= 1:
            score += 1.0 / total_fields
        if "confidence" in data and 0 <= data["confidence"] <= 1:
            score += 1.0 / total_fields
        if "analysis_summary" in data and data["analysis_summary"]:
            score += 1.0 / total_fields
        if "nodes" in data:
            node_fields = ["id", "type", "name", "description"]
            complete_nodes = sum(all(f in n for f in node_fields) for n in data["nodes"])
            node_score = complete_nodes / len(data["nodes"]) if data["nodes"] else 0
            score += node_score / total_fields
        return True, min(score, 1.0)

    def _summarize(self, provider: str, metrics: List[GenerationMetrics]) -> BenchmarkResult:
        if not metrics:
            return BenchmarkResult(provider=provider, total_requests=0, success_count=0,
                                   parseable_json_count=0, avg_latency_ms=0.0)
        success = [m for m in metrics if m.success]
        parseable = [m for m in metrics if m.parseable]
        latencies = [m.latency_ms for m in success]
        return BenchmarkResult(
            provider=provider,
            total_requests=len(metrics),
            success_count=len(success),
            parseable_json_count=len(parseable),
            avg_latency_ms=sum(latencies) / len(latencies) if latencies else 0,
            min_latency_ms=min(latencies) if latencies else 0,
            max_latency_ms=max(latencies) if latencies else 0,
            errors=[m.error for m in metrics if m.error],
            field_completeness=sum(m.field_score for m in parseable) / len(parseable) if parseable else 0.0,
        )

    def _record_metrics(
        self,
        provider: str,
        latency_ms: float,
        success: bool,
        error: str = "",
    ):
        self._metrics_history.append(
            GenerationMetrics(
                provider=provider,
                latency_ms=latency_ms,
                success=success,
                parseable=success,
                field_score=0.0,
                error=error,
            )
        )

    def _format_error(self, error: Exception) -> str:
        message = str(error).strip() if error else ""
        if not message and getattr(error, "args", None):
            parts = [str(part).strip() for part in error.args if str(part).strip()]
            message = "；".join(parts)
        if not message:
            message = error.__class__.__name__
        if error.__class__.__name__ not in message:
            return f"{error.__class__.__name__}: {message}"
        return message


# ─────────────────────────────────────────────
# 全局单例
# ─────────────────────────────────────────────

_llm_manager: Optional[LLMManager] = None


def get_llm_manager() -> LLMManager:
    """获取 LLMManager 实例（向后兼容）"""
    global _llm_manager
    if _llm_manager is None:
        _llm_manager = LLMManager()
    return _llm_manager
