"""
Ollama 本地 LLM Provider
支持 Qwen / Llama / DeepSeek 等本地模型，无需 API Key
"""

import time
import httpx
from backend.config import settings
from backend.core.llm.base_provider import BaseLLMProvider, LLMResponse, EmbedResult


class OllamaProvider(BaseLLMProvider):
    """Ollama 本地模型 Provider"""

    name = "ollama"

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        embed_model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ):
        self.base_url = (base_url or settings.OLLAMA_BASE_URL).rstrip("/")
        self.model = model or settings.OLLAMA_MODEL
        self.embed_model = embed_model or settings.OLLAMA_EMBED_MODEL
        self.temperature = temperature if temperature is not None else settings.LLM_TEMPERATURE
        self.max_tokens = max_tokens if max_tokens is not None else settings.LLM_MAX_TOKENS

    def is_available(self) -> bool:
        """检查 Ollama 服务是否可达"""
        try:
            resp = httpx.get(f"{self.base_url}/api/tags", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False

    def _extract_http_error(self, response: httpx.Response) -> str:
        try:
            data = response.json()
            if isinstance(data, dict):
                candidates = [
                    data.get("error"),
                    data.get("message"),
                    data.get("detail"),
                ]
                for item in candidates:
                    if isinstance(item, str) and item.strip():
                        return item.strip()
        except Exception:
            pass

        text = (response.text or "").strip()
        if text:
            return text[:300]
        return "响应体为空"

    async def generate(self, prompt: str, **kwargs) -> LLMResponse:
        """调用 Ollama /api/generate"""
        start = time.perf_counter()
        temperature = kwargs.get("temperature", self.temperature)
        max_tokens = kwargs.get("max_tokens", self.max_tokens)
        model = kwargs.get("model", self.model)

        payload = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }

        async with httpx.AsyncClient(timeout=120) as client:
            try:
                resp = await client.post(f"{self.base_url}/api/generate", json=payload)
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                detail = self._extract_http_error(exc.response)
                raise RuntimeError(
                    f"Ollama generate 接口异常 [{exc.response.status_code}]: {detail}"
                ) from exc
            except httpx.RequestError as exc:
                raise RuntimeError(f"Ollama 请求失败: {exc}") from exc

            data = resp.json()

        if data.get("error"):
            raise RuntimeError(f"Ollama 返回错误: {data['error']}")

        latency_ms = (time.perf_counter() - start) * 1000
        return LLMResponse(
            content=data.get("response", ""),
            latency_ms=latency_ms,
            raw=data,
        )

    async def embed(self, text: str) -> EmbedResult:
        """单条向量化"""
        start = time.perf_counter()
        payload = {"model": self.embed_model, "input": text}

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{self.base_url}/api/embed", json=payload)
            resp.raise_for_status()
            data = resp.json()

        latency_ms = (time.perf_counter() - start) * 1000
        return EmbedResult(
            embedding=data["embeddings"][0],
            latency_ms=latency_ms,
            model=self.embed_model,
        )

    async def embed_batch(self, texts: list[str]) -> list[EmbedResult]:
        """批量向量化（逐条调用 Ollama）"""
        results = []
        for text in texts:
            results.append(await self.embed(text))
        return results
