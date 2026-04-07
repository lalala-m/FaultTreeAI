import asyncio
from fastapi import APIRouter
from backend.core.llm.manager import get_llm_manager

router = APIRouter(tags=["LLM"])


async def _provider_status(name: str) -> dict:
    mgr = get_llm_manager()
    return await mgr.get_provider_status(name)


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
    items = await asyncio.gather(*[_provider_status(n) for n in ordered])
    return {
        "primary": mgr.primary_name,
        "fallback": mgr.fallback_name,
        "providers": items,
    }
