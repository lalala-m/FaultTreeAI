from fastapi import APIRouter
from backend.config import settings
from backend.core.llm.manager import get_llm_manager

router = APIRouter(tags=["LLM"])


def _provider_status(name: str) -> dict:
    mgr = get_llm_manager()
    try:
        p = mgr.get_provider(name)
        available = getattr(p, "is_available", None)
        ok = bool(available()) if callable(available) else True
    except Exception:
        ok = False
    reason = None
    if name.lower() == "minimax":
        if not settings.MINIMAX_API_KEY or not settings.MINIMAX_GROUP_ID:
            reason = "缺少 MINIMAX_API_KEY 或 MINIMAX_GROUP_ID"
    if name.lower() == "ollama":
        # 简单可用性提示由 provider 自身判断，这里不做额外探测
        pass
    return {
        "name": name,
        "available": ok,
        "reason": reason,
    }


@router.get("/api/llm/providers")
async def list_providers():
    mgr = get_llm_manager()
    names = [mgr.primary_name, mgr.fallback_name]
    # 去重并保序
    seen = set()
    ordered = []
    for n in names + ["ollama", "minimax"]:
        k = (n or "").lower()
        if k and k not in seen:
            seen.add(k)
            ordered.append(k)
    items = [_provider_status(n) for n in ordered]
    return {
        "primary": mgr.primary_name,
        "fallback": mgr.fallback_name,
        "providers": items,
    }

