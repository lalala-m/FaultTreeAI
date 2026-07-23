"""
全局复用的异步 HTTP 客户端

用途：LLM / Embedding / VLM 等外部 API 调用复用同一连接池，
避免每次请求都重建 TCP/TLS 连接，降低延迟。
"""

from typing import Optional
import httpx


_async_http_client: Optional[httpx.AsyncClient] = None


def get_async_http_client() -> httpx.AsyncClient:
    """获取全局异步 HTTP 客户端（懒加载）"""
    global _async_http_client
    if _async_http_client is None:
        _async_http_client = httpx.AsyncClient(
            timeout=120.0,
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )
    return _async_http_client


def reset_async_http_client() -> None:
    """重置全局异步 HTTP 客户端（配置变更后调用）"""
    global _async_http_client
    if _async_http_client is not None:
        try:
            _async_http_client.aclose()
        except Exception:
            pass
    _async_http_client = None
