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
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(self.base_url, json=payload, headers=self._get_headers())
            resp.raise_for_status()
            data = resp.json()
            return data.get("vectors", [data.get("vector", [])])[0]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"model": self.model_name, "texts": texts}
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self.base_url, json=payload, headers=self._get_headers())
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
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{self.base_url}/api/embed", json={"model": self.model_name, "input": text})
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
        self.dimensions = dimensions
        self.base_url = (base_url or settings.OPENAI_BASE_URL).rstrip("/") + "/embeddings"

    def _get_headers(self) -> dict:
        if not self.api_key:
            raise ValueError("缺少 OPENAI_API_KEY")
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def embed_query(self, text: str) -> List[float]:
        payload = {"model": self.model_name, "input": text}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        resp = httpx.post(self.base_url, json=payload, headers=self._get_headers(), timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data["data"][0]["embedding"]

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"model": self.model_name, "input": texts}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        resp = httpx.post(self.base_url, json=payload, headers=self._get_headers(), timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return [item["embedding"] for item in data["data"]]

    async def aembed_query(self, text: str) -> List[float]:
        payload = {"model": self.model_name, "input": text}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(self.base_url, json=payload, headers=self._get_headers())
            resp.raise_for_status()
            return resp.json()["data"][0]["embedding"]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"model": self.model_name, "input": texts}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self.base_url, json=payload, headers=self._get_headers())
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
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(self._get_url(), json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()["data"][0]["embedding"]

    async def aembed_documents(self, texts: List[str]) -> List[List[float]]:
        payload = {"input": texts}
        if self.dimensions:
            payload["dimensions"] = self.dimensions
        headers = {"api-key": self.api_key, "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self._get_url(), json=payload, headers=headers)
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
        configured_provider = (provider or settings.EMBED_PROVIDER or "minimax").lower()
        provider_cls = self.PROVIDER_MAP.get(configured_provider)
        
        if provider_cls is None:
            print(f"[WARN] Provider '{configured_provider}' not supported, using 'minimax'")
            configured_provider = "minimax"
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
        elif configured_provider in ("openai", "azure_openai"):
            kwargs = {"api_key": api_key, "dimensions": dimensions}
            if configured_provider == "openai":
                kwargs["model"] = model
                kwargs["base_url"] = base_url
            elif configured_provider == "azure_openai":
                kwargs["azure_deployment"] = model
            self._impl = provider_cls(**kwargs)
        else:
            # 默认 MiniMax
            self._impl = MiniMaxEmbeddings(
                api_key=api_key,
                group_id=group_id,
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
