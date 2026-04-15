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
    
    # MiniMax
    try:
        mgr.get_provider("minimax")
        available = bool(settings.MINIMAX_API_KEY and settings.MINIMAX_GROUP_ID)
        providers.append({
            "name": "minimax",
            "display_name": "MiniMax",
            "model": getattr(settings, "MINIMAX_MODEL", ""),
            "available": available,
            "reason": None if available else "缺少 API Key 或 Group ID"
        })
    except Exception as e:
        providers.append({
            "name": "minimax",
            "display_name": "MiniMax",
            "model": getattr(settings, "MINIMAX_MODEL", ""),
            "available": False,
            "reason": str(e)
        })
    
    # Ollama
    try:
        mgr.get_provider("ollama")
        # Ollama 有 embeddings 但 LLM 生成有问题
        providers.append({
            "name": "ollama",
            "display_name": "Ollama",
            "model": getattr(settings, "OLLAMA_MODEL", ""),
            "available": False,
            "reason": "Ollama LLM 生成服务暂不可用"
        })
    except Exception as e:
        providers.append({
            "name": "ollama",
            "display_name": "Ollama",
            "model": getattr(settings, "OLLAMA_MODEL", ""),
            "available": False,
            "reason": str(e)
        })

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
        "primary": getattr(settings, "LLM_PROVIDER", "minimax"),
        "fallback": getattr(settings, "LLM_FALLBACK_PROVIDER", None),
        "providers": providers,
    }
