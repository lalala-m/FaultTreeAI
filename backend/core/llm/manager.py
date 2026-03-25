"""
LLM Provider Manager — 统一入口，支持多 Provider + 自动回退 + A/B 对比

用法：
    manager = get_llm_manager()
    resp = await manager.generate("你的 prompt")          # 使用默认 Provider
    resp = await manager.generate("prompt", provider="ollama")  # 指定 Provider
    resp = await manager.generate_with_fallback("prompt")  # 主 Provider 失败时自动回退

A/B 对比：
    results = await manager.benchmark_providers(prompts, providers=["ollama", "minimax"])
"""

import time
import json
import re
import asyncio
from typing import Optional
from dataclasses import dataclass, field
from backend.config import settings
from backend.core.llm.base_provider import (
    BaseLLMProvider,
    LLMResponse,
    EmbedResult,
    BenchmarkResult,
)
from backend.core.llm.providers import OllamaProvider, MiniMaxProvider


_PROVIDER_REGISTRY: dict[str, type[BaseLLMProvider]] = {
    "ollama": OllamaProvider,
    "minimax": MiniMaxProvider,
}


@dataclass
class GenerationMetrics:
    provider: str
    latency_ms: float
    success: bool
    parseable: bool
    field_score: float  # 0-1，节点数/门数/置信度/summary 等字段完整性
    error: str = ""


class LLMManager:
    """
    多 Provider 统一管理器

    - primary / fallback 双轨配置
    - 自动回退：主 Provider 失败自动切换
    - A/B 对比：同一批 prompt 对比多个 Provider
    - 统计汇总 BenchmarkResult
    """

    def __init__(
        self,
        primary: str | None = None,
        fallback: str | None = None,
    ):
        self.primary_name = primary or settings.LLM_PROVIDER
        self.fallback_name = fallback or (
            settings.LLM_FALLBACK_PROVIDER
            if settings.LLM_FALLBACK_PROVIDER
            else self._infer_fallback(self.primary_name)
        )
        self._instances: dict[str, BaseLLMProvider] = {}
        self._metrics_history: list[GenerationMetrics] = []

    def _infer_fallback(self, primary: str) -> str:
        """如果主 Provider 是本地模型，备用选云端，反之亦然"""
        if primary == "ollama":
            return "minimax"
        return "ollama"

    # ── 实例获取 ──────────────────────────────────────────

    def get_provider(self, name: str | None = None) -> BaseLLMProvider:
        """按名称获取 Provider 实例（带缓存）"""
        name = name or self.primary_name
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
        provider: str | None = None,
        **kwargs,
    ) -> LLMResponse:
        """使用指定或默认 Provider 生成"""
        p = self.get_provider(provider)
        return await p.generate(prompt, **kwargs)

    async def generate_with_fallback(
        self,
        prompt: str,
        **kwargs,
    ) -> tuple[LLMResponse, str]:
        """
        主 Provider 失败则自动回退到备用 Provider。
        返回 (响应, 实际使用的 provider 名)。
        """
        try:
            resp = await self.primary.generate(prompt, **kwargs)
            self._record_metrics(self.primary_name, resp.latency_ms, success=True)
            return resp, self.primary_name
        except Exception as prim_err:
            try:
                resp = await self.fallback.generate(prompt, **kwargs)
                self._record_metrics(
                    self.fallback_name, resp.latency_ms, success=True
                )
                return resp, self.fallback_name
            except Exception as fall_err:
                raise RuntimeError(
                    f"主 Provider [{self.primary_name}] 失败: {prim_err}；"
                    f"备用 Provider [{self.fallback_name}] 也失败: {fall_err}"
                ) from fall_err

    # ── Embedding ──────────────────────────────────────────

    async def embed(self, text: str, provider: str | None = None) -> EmbedResult:
        return await self.get_provider(provider).embed(text)

    async def embed_batch(
        self, texts: list[str], provider: str | None = None
    ) -> list[EmbedResult]:
        return await self.get_provider(provider).embed_batch(texts)

    # ── A/B 对比 ────────────────────────────────────────────

    async def benchmark_providers(
        self,
        prompts: list[str],
        providers: list[str] | None = None,
    ) -> dict[str, BenchmarkResult]:
        """
        对同一批 prompt 运行多个 Provider，汇总结果。

        返回 {
            "ollama": BenchmarkResult(...),
            "minimax": BenchmarkResult(...),
        }
        """
        providers = providers or [self.primary_name, self.fallback_name]
        results: dict[str, list[GenerationMetrics]] = {p: [] for p in providers}

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
        """评估 LLM 输出的可解析性和字段完整度"""
        # 1. 可解析 JSON 比例
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

        # 2. 字段完整度评分（满分 1.0）
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

        # 节点结构质量
        if "nodes" in data:
            node_fields = ["id", "type", "name", "description"]
            complete_nodes = sum(
                all(f in n for f in node_fields) for n in data["nodes"]
            )
            node_score = complete_nodes / len(data["nodes"]) if data["nodes"] else 0
            score += node_score / total_fields

        return True, min(score, 1.0)

    def _summarize(self, provider: str, metrics: list[GenerationMetrics]) -> BenchmarkResult:
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
            field_completeness=(
                sum(m.field_score for m in parseable) / len(parseable)
                if parseable else 0.0
            ),
        )

    def _record_metrics(self, provider: str, latency_ms: float, success: bool):
        self._metrics_history.append(
            GenerationMetrics(
                provider=provider,
                latency_ms=latency_ms,
                success=success,
                parseable=success,
                field_score=0.0,
            )
        )


# ──────────────────────────────────────────────────────────
# 全局单例（兼容现有代码）
# ──────────────────────────────────────────────────────────

_llm_manager: Optional[LLMManager] = None


def get_llm_manager() -> LLMManager:
    global _llm_manager
    if _llm_manager is None:
        _llm_manager = LLMManager()
    return _llm_manager
