from fastapi import APIRouter
from backend.config import settings
from backend.core.llm.manager import get_llm_manager

router = APIRouter(tags=["LLM"])


@router.get("/api/llm/providers")
async def list_providers():
    """获取可用的 LLM Provider 列表"""
    mgr = get_llm_manager()
    
    # 检查每个 Provider 的可用性
    providers = []

    # 千帆（OpenAI 兼容接口，统一走 openai provider）
    openai_available = bool(getattr(settings, "OPENAI_API_KEY", "") and getattr(settings, "OPENAI_BASE_URL", ""))
    providers.append({
        "name": "openai",
        "display_name": "千帆",
        "model": getattr(settings, "LLM_MODEL", ""),
        "available": openai_available,
        "reason": None if openai_available else "缺少 OPENAI_API_KEY 或 OPENAI_BASE_URL"
    })
    
    return {
        "primary": getattr(settings, "LLM_PROVIDER", "openai"),
        "fallback": getattr(settings, "LLM_FALLBACK_PROVIDER", None),
        "providers": providers,
    }
