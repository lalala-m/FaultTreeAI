"""
MiniMax 云端 LLM Provider
支持 MiniMax-M2 及 embedding 模型
"""

import time
import httpx
from backend.config import settings
from backend.core.llm.base_provider import BaseLLMProvider, LLMResponse, EmbedResult


class MiniMaxProvider(BaseLLMProvider):
    """MiniMax 云端模型 Provider"""

    name = "minimax"

    def __init__(
        self,
        api_key: str | None = None,
        group_id: str | None = None,
        model: str | None = None,
        embed_model: str | None = None,
        base_url: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        embed_dim: int | None = None,
    ):
        self.api_key = api_key or settings.MINIMAX_API_KEY
        self.group_id = group_id or settings.MINIMAX_GROUP_ID
        self.model = model or settings.MINIMAX_MODEL
        self.embed_model = embed_model or settings.MINIMAX_EMBED_MODEL
        self.base_url = (base_url or settings.MINIMAX_BASE_URL).rstrip("/")
        self.temperature = temperature if temperature is not None else settings.LLM_TEMPERATURE
        self.max_tokens = max_tokens if max_tokens is not None else settings.LLM_MAX_TOKENS
        self.embed_dim = embed_dim if embed_dim is not None else settings.EMBED_DIM

    def is_available(self) -> bool:
        return bool(self.api_key and self.group_id)

    def _extract_http_error(self, response: httpx.Response) -> str:
        try:
            data = response.json()
            if isinstance(data, dict):
                base_resp = data.get("base_resp") or {}
                candidates = [
                    base_resp.get("status_msg"),
                    data.get("message"),
                    data.get("detail"),
                    data.get("error"),
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

    def _extract_request_error(self, error: httpx.RequestError) -> str:
        parts: list[str] = []

        message = str(error).strip()
        if message:
            parts.append(message)

        cause = getattr(error, "__cause__", None) or getattr(error, "__context__", None)
        if cause is not None:
            cause_text = str(cause).strip()
            if cause_text:
                parts.append(cause_text)
            elif getattr(cause, "args", None):
                arg_text = "；".join(str(item).strip() for item in cause.args if str(item).strip())
                if arg_text:
                    parts.append(arg_text)
                else:
                    parts.append(repr(cause))
            else:
                parts.append(repr(cause))

        combined = " | ".join(parts)
        if "EndOfStream" in combined:
            parts = ["连接流被远端中断（EndOfStream）"]

        request = getattr(error, "request", None)
        if request is not None and getattr(request, "url", None):
            parts.append(f"请求地址: {request.url}")

        if not parts:
            parts.append(error.__class__.__name__)

        return " | ".join(parts)

    async def generate(self, prompt: str, **kwargs) -> LLMResponse:
        """调用 MiniMax ChatCompletion V2 API"""
        if not self.api_key or not self.group_id:
            raise RuntimeError("缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID")

        start = time.perf_counter()
        temperature = kwargs.get("temperature", self.temperature)
        max_tokens = kwargs.get("max_tokens", self.max_tokens)
        model = kwargs.get("model", self.model)

        messages = [{"role": "user", "content": prompt}]
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "GroupId": self.group_id,
        }

        async with httpx.AsyncClient(timeout=120) as client:
            try:
                resp = await client.post(
                    f"{self.base_url}/v1/text/chatcompletion_v2",
                    json=payload,
                    headers=headers,
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                detail = self._extract_http_error(exc.response)
                raise RuntimeError(
                    f"MiniMax 接口异常 [{exc.response.status_code}]: {detail}"
                ) from exc
            except httpx.RequestError as exc:
                raise RuntimeError(
                    f"MiniMax 请求失败: {self._extract_request_error(exc)}"
                ) from exc

            data = resp.json()

            if data.get("base_resp", {}).get("status_code", 0) != 0:
                err_code = data["base_resp"]["status_code"]
                err_msg = data["base_resp"].get("status_msg", "未知错误")
                raise RuntimeError(f"MiniMax API 错误 [{err_code}]: {err_msg}")

        latency_ms = (time.perf_counter() - start) * 1000
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return LLMResponse(content=content, latency_ms=latency_ms, raw=data)

    async def embed(self, text: str) -> EmbedResult:
        """单条向量化"""
        start = time.perf_counter()
        payload = {"model": self.embed_model, "input": text}
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "GroupId": self.group_id,
        }

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self.base_url}/v1/embeddings",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

        latency_ms = (time.perf_counter() - start) * 1000
        vectors = data.get("vectors", [data.get("vector", [])])
        embedding = vectors[0] if vectors else []
        return EmbedResult(embedding=embedding, latency_ms=latency_ms, model=self.embed_model)

    async def embed_batch(self, texts: list[str]) -> list[EmbedResult]:
        """批量向量化"""
        start = time.perf_counter()
        payload = {"model": self.embed_model, "texts": texts}
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "GroupId": self.group_id,
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{self.base_url}/v1/embeddings",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

        latency_ms = (time.perf_counter() - start) * 1000
        vectors = data.get("vectors", data.get("data", []))
        return [
            EmbedResult(
                embedding=v if isinstance(v, list) else v.get("vector", []),
                latency_ms=latency_ms / len(texts),  # 均摊
                model=self.embed_model,
            )
            for v in vectors
        ]
