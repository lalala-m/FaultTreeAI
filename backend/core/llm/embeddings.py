"""
统一的 Embedding 实现 - LangChain 标准接口

支持的 Provider:
- minimax: MiniMax Embedding
- ollama: Ollama 本地模型
- openai: OpenAI Embedding
- azure_openai: Azure OpenAI Embedding
"""

from typing import List, Optional
from langchain_core.embeddings import Embeddings
from pydantic import Field
import httpx
import asyncio

from backend.config import settings
from backend.core.llm.async_http import get_async_http_client


# ─────────────────────────────────────────────
# MiniMax Embedding
# ─────────────────────────────────────────────

class MiniMaxEmbeddings(Embeddings):
    """MiniMax Embedding 实现"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        group_id: Optional[str] = None,
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        base_url: Optional[str] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.api_key = api_key or settings.MINIMAX_API_KEY
        self.group_id = group_id or settings.MINIMAX_GROUP_ID
        self.model_name = model or settings.MINIMAX_EMBED_MODEL
        self.dimensions = dimensions or settings.EMBED_DIM
        self.base_url = (base_url or settings.MINIMAX_BASE_URL).rstrip("/") + "/v1/embeddings"

    def _get_headers(self) -> dict:
        if not self.api_key:
            raise ValueError("缺少 MINIMAX_API_KEY")
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        if self.group_id:
            headers["GroupId"] = self.group_id
        return headers

    def embed_query(self, text: str) -> List[float]:
        payload = {"model": self.model_name, "input": text}
        resp = httpx.post(self.base_url, json=payload, headers=self._get_headers(), timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data.get("vectors", [data.get("vector", [])])[0]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"model": self.model_name, "texts": texts}
        resp = httpx.post(self.base_url, json=payload, headers=self._get_headers(), timeout=120)
        resp.raise_for_status()
        data = resp.json()
        vectors = data.get("vectors", data.get("data", []))
        return [v if isinstance(v, list) else v.get("vector", []) for v in vectors]

    async def aembed_query(self, text: str) -> List[float]:
        payload = {"model": self.model_name, "input": text}
        client = get_async_http_client()
        resp = await client.post(self.base_url, json=payload, headers=self._get_headers(), timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data.get("vectors", [data.get("vector", [])])[0]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"model": self.model_name, "texts": texts}
        client = get_async_http_client()
        resp = await client.post(self.base_url, json=payload, headers=self._get_headers(), timeout=120)
        resp.raise_for_status()
        data = resp.json()
        vectors = data.get("vectors", data.get("data", []))
        return [v if isinstance(v, list) else v.get("vector", []) for v in vectors]

    def is_available(self) -> bool:
        return bool(self.api_key and self.group_id)


# ─────────────────────────────────────────────
# Ollama Embedding
# ─────────────────────────────────────────────

class OllamaEmbeddings(Embeddings):
    """Ollama 本地模型 Embedding"""

    def __init__(self, model: Optional[str] = None, base_url: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self.model_name = model or settings.OLLAMA_EMBED_MODEL
        self.base_url = (base_url or settings.OLLAMA_BASE_URL).rstrip("/")

    def embed_query(self, text: str) -> List[float]:
        resp = httpx.post(f"{self.base_url}/api/embed", json={"model": self.model_name, "input": text}, timeout=60)
        resp.raise_for_status()
        return resp.json()["embeddings"][0]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return [self.embed_query(t) for t in texts]

    async def aembed_query(self, text: str) -> List[float]:
        client = get_async_http_client()
        resp = await client.post(f"{self.base_url}/api/embed", json={"model": self.model_name, "input": text}, timeout=60)
        resp.raise_for_status()
        return resp.json()["embeddings"][0]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        return [await self.aembed_query(t) for t in texts]

    def is_available(self) -> bool:
        try:
            resp = httpx.get(f"{self.base_url}/api/tags", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False


# ─────────────────────────────────────────────
# 百度千帆/文心 Embedding
# ─────────────────────────────────────────────

class BaiduEmbeddings(Embeddings):
    """百度千帆/文心 Embedding（bge-large-zh / embedding-v1 / tao-8k 等）"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
    ):
        super().__init__()
        self.api_key = api_key or settings.BAIDU_EMBED_API_KEY
        self.secret_key = secret_key or settings.BAIDU_EMBED_SECRET_KEY
        self.model_name = model or settings.BAIDU_EMBED_MODEL or "bge-large-zh"
        self.dimensions = dimensions or settings.EMBED_DIM
        self._token: Optional[str] = None

    def _get_token(self) -> str:
        if self._token:
            return self._token
        if not self.api_key or not self.secret_key:
            raise ValueError("缺少 BAIDU_EMBED_API_KEY 或 BAIDU_EMBED_SECRET_KEY")
        url = (
            "https://aip.baidubce.com/oauth/2.0/token"
            f"?grant_type=client_credentials&client_id={self.api_key}&client_secret={self.secret_key}"
        )
        resp = httpx.post(url, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        token = data.get("access_token", "")
        if not token:
            raise ValueError(f"百度 Embedding token 获取失败: {data}")
        self._token = token
        return token

    def _embed(self, texts: List[str]) -> List[List[float]]:
        token = self._get_token()
        url = f"https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/embeddings/{self.model_name}?access_token={token}"
        payload = {"input": texts}
        resp = httpx.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        if data.get("error_code"):
            raise ValueError(f"百度 Embedding 错误 {data.get('error_code')}: {data.get('error_msg')}")
        items = data.get("data", [])
        # 按 index 排序
        items = sorted(items, key=lambda x: x.get("index", 0))
        return [item["embedding"] for item in items]

    def embed_query(self, text: str) -> List[float]:
        return self._embed([text])[0]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return self._embed(texts)

    async def _aembed(self, texts: List[str]) -> List[List[float]]:
        token = self._get_token()
        url = f"https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/embeddings/{self.model_name}?access_token={token}"
        payload = {"input": texts}
        client = get_async_http_client()
        resp = await client.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        if data.get("error_code"):
            raise ValueError(f"百度 Embedding 错误 {data.get('error_code')}: {data.get('error_msg')}")
        items = data.get("data", [])
        items = sorted(items, key=lambda x: x.get("index", 0))
        return [item["embedding"] for item in items]

    async def aembed_query(self, text: str) -> List[float]:
        return (await self._aembed([text]))[0]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        return await self._aembed(texts)

    def is_available(self) -> bool:
        return bool(self.api_key and self.secret_key)


# ─────────────────────────────────────────────
# OpenAI Embedding
# ─────────────────────────────────────────────

class OpenAIEmbeddings(Embeddings):
    """OpenAI Embedding (text-embedding-ada-002, text-embedding-3-*)"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        base_url: Optional[str] = None,
    ):
        super().__init__()  # LangChain 基类不接受 kwargs
        self.api_key = api_key or settings.OPENAI_API_KEY
        self.model_name = model or "text-embedding-ada-002"
        base = (base_url or settings.OPENAI_BASE_URL).rstrip("/")
        # 千帆 OpenAI 兼容接口使用 /v2/embeddings，且不支持 dimensions 参数
        if "qianfan" in base or "baidubce" in base:
            self.base_url = base + "/embeddings"
            self.dimensions = None
            # 千帆没有 text-embedding-ada-002，自动切换到可用的百度模型
            if self.model_name in ("text-embedding-ada-002", "text-embedding-3-small", "text-embedding-3-large"):
                print(f"[WARN] 千帆/百度 Embedding 不支持模型 '{self.model_name}'，已自动切换为 'bge-large-zh'")
                self.model_name = "bge-large-zh"
        else:
            self.dimensions = dimensions or settings.EMBED_DIM
            if base.endswith("/v2"):
                self.base_url = base[:-3] + "/v1/embeddings"
            else:
                self.base_url = base + "/embeddings"

    def _get_headers(self) -> dict:
        if not self.api_key:
            raise ValueError("缺少 OPENAI_API_KEY")
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def _alt_url(self, url: str) -> str:
        # 千帆固定使用 /v2/embeddings，不再降级到 /v1
        if "qianfan" in url or "baidubce" in url:
            return ""
        try:
            if "/v2/embeddings" in url:
                return url.replace("/v2/embeddings", "/v1/embeddings")
            if url.endswith("/v2/embeddings"):
                return url[:-len("/v2/embeddings")] + "/v1/embeddings"
        except Exception:
            return ""
        return ""

    def _post_with_fallback(self, url: str, payload: dict, timeout: float) -> httpx.Response:
        resp = httpx.post(url, json=payload, headers=self._get_headers(), timeout=timeout)
        if resp.status_code == 404:
            alt = self._alt_url(url)
            if alt:
                resp2 = httpx.post(alt, json=payload, headers=self._get_headers(), timeout=timeout)
                if resp2.status_code != 404:
                    return resp2
        if resp.status_code >= 400:
            print(f"[WARN] Embedding request failed: {resp.status_code} {url}\n  payload={payload}\n  response={resp.text[:500]}")
        return resp

    def embed_query(self, text: str) -> List[float]:
        if not text or not str(text).strip():
            return [0.0] * (self.dimensions or settings.EMBED_DIM)
        payload = {"model": self.model_name, "input": text}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        resp = self._post_with_fallback(self.base_url, payload, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data["data"][0]["embedding"]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        filtered = [t for t in texts if t and str(t).strip()]
        if not filtered:
            dim = self.dimensions or settings.EMBED_DIM
            return [[0.0] * dim for _ in texts]
        payload = {"model": self.model_name, "input": filtered}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        resp = self._post_with_fallback(self.base_url, payload, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return [item["embedding"] for item in data["data"]]

    async def aembed_query(self, text: str) -> List[float]:
        if not text or not str(text).strip():
            return [0.0] * (self.dimensions or settings.EMBED_DIM)
        payload = {"model": self.model_name, "input": text}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        client = get_async_http_client()
        resp = await client.post(self.base_url, json=payload, headers=self._get_headers(), timeout=60)
        if resp.status_code == 404:
            alt = self._alt_url(self.base_url)
            if alt:
                resp2 = await client.post(alt, json=payload, headers=self._get_headers(), timeout=60)
                if resp2.status_code != 404:
                    resp = resp2
        if resp.status_code >= 400:
            print(f"[WARN] Embedding request failed: {resp.status_code} {self.base_url}\n  payload={payload}\n  response={resp.text[:500]}")
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        filtered = [t for t in texts if t and str(t).strip()]
        if not filtered:
            dim = self.dimensions or settings.EMBED_DIM
            return [[0.0] * dim for _ in texts]
        payload = {"model": self.model_name, "input": filtered}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        client = get_async_http_client()
        resp = await client.post(self.base_url, json=payload, headers=self._get_headers(), timeout=120)
        if resp.status_code == 404:
            alt = self._alt_url(self.base_url)
            if alt:
                resp2 = await client.post(alt, json=payload, headers=self._get_headers(), timeout=120)
                if resp2.status_code != 404:
                    resp = resp2
        if resp.status_code >= 400:
            print(f"[WARN] Embedding request failed: {resp.status_code} {self.base_url}\n  payload={payload}\n  response={resp.text[:500]}")
        resp.raise_for_status()
        data = resp.json()
        return [item["embedding"] for item in data["data"]]

    def is_available(self) -> bool:
        return bool(self.api_key)


# ─────────────────────────────────────────────
# Azure OpenAI Embedding
# ─────────────────────────────────────────────

class AzureOpenAIEmbeddings(Embeddings):
    """Azure OpenAI Embedding"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_version: Optional[str] = None,
        azure_deployment: Optional[str] = None,
        dimensions: Optional[int] = None,
    ):
        super().__init__()  # LangChain 基类不接受 kwargs
        self.api_key = api_key or settings.AZURE_OPENAI_KEY
        self.api_version = api_version or settings.AZURE_OPENAI_API_VERSION
        self.azure_deployment = azure_deployment or "text-embedding-ada-002"
        self.endpoint = settings.AZURE_OPENAI_ENDPOINT.rstrip("/")
        self.dimensions = dimensions

    def _get_url(self) -> str:
        return f"{self.endpoint}/openai/deployments/{self.azure_deployment}/embeddings?api-version={self.api_version}"

    def embed_query(self, text: str) -> List[float]:
        payload = {"input": text}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        headers = {"api-key": self.api_key, "Content-Type": "application/json"}
        resp = httpx.post(self._get_url(), json=payload, headers=headers, timeout=60)
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"input": texts}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        headers = {"api-key": self.api_key, "Content-Type": "application/json"}
        resp = httpx.post(self._get_url(), json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return [item["embedding"] for item in data["data"]]

    async def aembed_query(self, text: str) -> List[float]:
        payload = {"input": text}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        headers = {"api-key": self.api_key, "Content-Type": "application/json"}
        client = get_async_http_client()
        resp = await client.post(self._get_url(), json=payload, headers=headers, timeout=60)
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"input": texts}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        headers = {"api-key": self.api_key, "Content-Type": "application/json"}
        client = get_async_http_client()
        resp = await client.post(self._get_url(), json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return [item["embedding"] for item in data["data"]]

    def is_available(self) -> bool:
        return bool(self.api_key and self.endpoint)


# ─────────────────────────────────────────────
# 统一工厂类
# ─────────────────────────────────────────────

class UnifiedEmbeddings:
    """
    统一 Embedding 工厂类
    
    支持的 Provider: minimax, ollama, openai, azure_openai
    """
    
    PROVIDER_MAP = {
        "minimax": MiniMaxEmbeddings,
        "ollama": OllamaEmbeddings,
        "openai": OpenAIEmbeddings,
        "azure_openai": AzureOpenAIEmbeddings,
        "baidu": BaiduEmbeddings,
    }

    def __init__(
        self,
        provider: Optional[str] = None,
        api_key: Optional[str] = None,
        group_id: Optional[str] = None,
        model: Optional[str] = None,
        dimensions: Optional[int] = None,
        base_url: Optional[str] = None,
        **kwargs,
    ):
        configured_provider = (provider or settings.EMBED_PROVIDER or "openai").lower()
        provider_cls = self.PROVIDER_MAP.get(configured_provider)
        
        if provider_cls is None:
            print(f"[WARN] Provider '{configured_provider}' not supported, using 'openai'")
            configured_provider = "openai"
            provider_cls = self.PROVIDER_MAP.get(configured_provider)
        
        self.provider = configured_provider
        
        # 只传递特定 Provider 支持的参数
        if configured_provider == "minimax":
            self._impl = provider_cls(
                api_key=api_key,
                group_id=group_id,
                model=model,
                base_url=base_url,
                dimensions=dimensions,
            )
        elif configured_provider == "ollama":
            self._impl = provider_cls(
                model=model,
                base_url=base_url,
            )
        elif configured_provider == "baidu":
            self._impl = provider_cls(
                api_key=api_key,
                secret_key=kwargs.get("secret_key"),
                model=model,
                dimensions=dimensions,
            )
        elif configured_provider in ("openai", "azure_openai"):
            kwargs = {"api_key": api_key, "dimensions": dimensions}
            if configured_provider == "openai":
                kwargs["model"] = model
                kwargs["base_url"] = base_url
            elif configured_provider == "azure_openai":
                kwargs["azure_deployment"] = model
            self._impl = provider_cls(**kwargs)
        else:
            self._impl = OpenAIEmbeddings(
                api_key=api_key,
                model=model,
                base_url=base_url,
                dimensions=dimensions,
            )

    def embed_query(self, text: str) -> List[float]:
        return self._impl.embed_query(text)

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return self._impl.embed_documents(texts)

    async def aembed_query(self, text: str) -> List[float]:
        return await self._impl.aembed_query(text)

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        return await self._impl.aembed_documents(texts)

    @property
    def embedding_dim(self) -> int:
        return getattr(self._impl, "dimensions", getattr(self._impl, "model_name", settings.EMBED_DIM))

    @property
    def model_name(self) -> str:
        return getattr(self._impl, "model_name", "")

    def is_available(self) -> bool:
        checker = getattr(self._impl, "is_available", None)
        return checker() if callable(checker) else True


# ─────────────────────────────────────────────
# 全局单例
# ─────────────────────────────────────────────

_unified_embeddings: Optional[UnifiedEmbeddings] = None


def get_unified_embeddings(provider: Optional[str] = None, **kwargs) -> UnifiedEmbeddings:
    global _unified_embeddings
    if provider and _unified_embeddings and _unified_embeddings.provider != provider.lower():
        _unified_embeddings = UnifiedEmbeddings(provider=provider, **kwargs)
        return _unified_embeddings
    if _unified_embeddings is None:
        _unified_embeddings = UnifiedEmbeddings(provider=provider, **kwargs)
    return _unified_embeddings


def reset_unified_embeddings():
    global _unified_embeddings
    _unified_embeddings = None


# 向后兼容别名
MiniMaxEmbeddingService = MiniMaxEmbeddings
