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
        minimax = mgr.get_provider("minimax")
        available = bool(settings.MINIMAX_API_KEY and settings.MINIMAX_GROUP_ID)
        providers.append({
            "name": "minimax",
            "available": available,
            "reason": None if available else "缺少 API Key 或 Group ID"
        })
    except Exception as e:
        providers.append({
            "name": "minimax",
            "available": False,
            "reason": str(e)
        })
    
    # Ollama
    try:
        ollama = mgr.get_provider("ollama")
        # Ollama 有 embeddings 但 LLM 生成有问题
        providers.append({
            "name": "ollama",
            "available": False,
            "reason": "Ollama LLM 生成服务暂不可用"
        })
    except Exception as e:
        providers.append({
            "name": "ollama",
            "available": False,
            "reason": str(e)
        })
    
    return {
        "primary": "minimax",
        "fallback": None,
        "providers": providers,
    }
