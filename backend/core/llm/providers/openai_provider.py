"""
OpenAI 兼容 LLM Provider

用于对接 OpenAI-compatible 的中转/网关（如百度千帆 v2 /v2/chat/completions）。
仅实现文本生成（chat completions）；Embedding 仍建议走现有 minimax/ollama 方案。
"""

import time
import httpx

from backend.config import settings
from backend.core.llm.base_provider import BaseLLMProvider, LLMResponse, EmbedResult


class OpenAIProvider(BaseLLMProvider):
    name = "openai"

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ):
        self.api_key = api_key or settings.OPENAI_API_KEY
        self.base_url = (base_url or settings.OPENAI_BASE_URL).rstrip("/")
        self.model = model or settings.LLM_MODEL
        self.temperature = temperature if temperature is not None else settings.LLM_TEMPERATURE
        self.max_tokens = max_tokens if max_tokens is not None else settings.LLM_MAX_TOKENS

    def is_available(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)

    def _headers(self) -> dict:
        if not self.api_key:
            raise RuntimeError("缺少 OPENAI_API_KEY")
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _endpoint(self) -> str:
        return f"{self.base_url}/chat/completions"

    async def generate(self, prompt: str, **kwargs) -> LLMResponse:
        t0 = time.time()
        model = str(kwargs.get("model") or self.model or "").strip()
        if not model:
            raise RuntimeError("缺少 LLM_MODEL（模型名）")

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": str(prompt or "")}],
            "temperature": float(kwargs.get("temperature", self.temperature)),
        }
        max_tokens = kwargs.get("max_tokens", self.max_tokens)
        if max_tokens is not None:
            payload["max_tokens"] = int(max_tokens)

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self._endpoint(), json=payload, headers=self._headers())
            try:
                resp.raise_for_status()
            except Exception:
                try:
                    data = resp.json()
                    detail = data.get("error") or data.get("message") or data.get("detail") or str(data)
                except Exception:
                    detail = (resp.text or "").strip()[:400] or f"HTTP {resp.status_code}"
                raise RuntimeError(detail)

            data = resp.json()
            choices = data.get("choices") or []
            content = ""
            if choices:
                msg = (choices[0] or {}).get("message") or {}
                content = str(msg.get("content") or "")

        return LLMResponse(content=content, latency_ms=round((time.time() - t0) * 1000.0, 2), raw=None)

    async def embed(self, text: str) -> EmbedResult:
        raise NotImplementedError("OpenAIProvider 不提供 Embedding，请改用 EMBED_PROVIDER 配置")

    async def embed_batch(self, texts: list) -> list[EmbedResult]:
        raise NotImplementedError("OpenAIProvider 不提供 Embedding，请改用 EMBED_PROVIDER 配置")

