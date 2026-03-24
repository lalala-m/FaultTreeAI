"""
LangChain 统一 LLM 客户端 — 支持 MiniMax / OpenAI / Anthropic / Azure OpenAI
MiniMax 使用自定义实现，其他 provider 使用 langchain-* 官方包
"""

import json
import re
from typing import Optional, Any
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage, AIMessage
from langchain_core.outputs import ChatResult, ChatGeneration
from langchain_core.callbacks import CallbackManagerForLLMRun
from pydantic import Field
import httpx

from backend.config import settings


# ─────────────────────────────────────────────
# MiniMax 自定义 LangChain 实现
# ─────────────────────────────────────────────

class MiniMaxChatModel(BaseChatModel):
    """MiniMax M2 模型的自定义 LangChain 实现"""

    model_name: str = Field(default=settings.MINIMAX_MODEL)
    api_key: str = Field(default=settings.MINIMAX_API_KEY)
    group_id: str = Field(default=settings.MINIMAX_GROUP_ID)
    temperature: float = Field(default=settings.LLM_TEMPERATURE)
    max_tokens: int = Field(default=settings.LLM_MAX_TOKENS)
    base_url: str = Field(default=settings.MINIMAX_BASE_URL + "/v1/text/chatcompletion_v2")

    @property
    def _llm_type(self) -> str:
        return "minimax_chat"

    def _convert_messages_to_minimax(self, messages: list[BaseMessage]) -> list[dict]:
        result = []
        for msg in messages:
            role = msg.type if msg.type in ("user", "assistant", "system") else "user"
            result.append({"role": role, "content": msg.content})
        return result

    def _create_chat_request(self, messages: list[dict]) -> dict:
        return {
            "model": self.model_name,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": False,
        }

    def _parse_response(self, data: dict) -> str:
        choices = data.get("choices", [])
        if not choices:
            raise ValueError(f"MiniMax API 返回格式异常: {data}")
        return choices[0].get("message", {}).get("content", "")

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        minimax_messages = self._convert_messages_to_minimax(messages)
        payload = self._create_chat_request(minimax_messages)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            response = httpx.post(
                self.base_url,
                json=payload,
                headers=headers,
                timeout=120,
            )
            response.raise_for_status()
            data = response.json()

            if data.get("base_resp", {}).get("status_code", 0) != 0:
                err_code = data["base_resp"]["status_code"]
                err_msg = data["base_resp"].get("status_msg", "未知错误")
                raise RuntimeError(f"MiniMax API 错误 [{err_code}]: {err_msg}")

            content = self._parse_response(data)
            ai_msg = AIMessage(content=content)
            generation = ChatGeneration(message=ai_msg)
            return ChatResult(generations=[generation])

        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"MiniMax HTTP 请求失败: {e.response.status_code} {e.response.text}")
        except Exception as e:
            raise RuntimeError(f"MiniMax 调用异常: {str(e)}")

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        """异步生成"""
        minimax_messages = self._convert_messages_to_minimax(messages)
        payload = self._create_chat_request(minimax_messages)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=120) as client:
            try:
                response = await client.post(self.base_url, json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()

                if data.get("base_resp", {}).get("status_code", 0) != 0:
                    err_code = data["base_resp"]["status_code"]
                    err_msg = data["base_resp"].get("status_msg", "未知错误")
                    raise RuntimeError(f"MiniMax API 错误 [{err_code}]: {err_msg}")

                content = self._parse_response(data)
                ai_msg = AIMessage(content=content)
                generation = ChatGeneration(message=ai_msg)
                return ChatResult(generations=[generation])

            except httpx.HTTPStatusError as e:
                raise RuntimeError(f"MiniMax HTTP 请求失败: {e.response.status_code}")
            except Exception as e:
                raise RuntimeError(f"MiniMax 异步调用异常: {str(e)}")


class MiniMaxEmbeddings:
    """MiniMax Embedding 模型的自定义实现"""

    def __init__(
        self,
        api_key: str = settings.MINIMAX_API_KEY,
        group_id: str = settings.MINIMAX_GROUP_ID,
        model: str = settings.MINIMAX_EMBED_MODEL,
        dimensions: int = settings.EMBED_DIM,
    ):
        self.api_key = api_key
        self.group_id = group_id
        self.model = model
        self.dimensions = dimensions
        self.base_url = settings.MINIMAX_BASE_URL + "/v1/embeddings"

    def _cosine_to_dot(self, embedding: list[float]) -> list[float]:
        """余弦相似度转点积：MiniMax 返回的是余弦相似度，需要归一化"""
        norm = sum(x * x for x in embedding) ** 0.5
        return [x / norm for x in embedding]

    def embed_query(self, text: str) -> list[float]:
        """单条文本向量化"""
        payload = {
            "model": self.model,
            "input": text,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        resp = httpx.post(self.base_url, json=payload, headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data.get("vectors", [data.get("vector", [])])[0]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """批量文本向量化"""
        payload = {
            "model": self.model,
            "texts": texts,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        resp = httpx.post(self.base_url, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        vectors = data.get("vectors", data.get("data", []))
        return [v if isinstance(v, list) else v.get("vector", []) for v in vectors]

    async def aembed_query(self, text: str) -> list[float]:
        """异步单条向量化"""
        payload = {"model": self.model, "input": text}
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(self.base_url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data.get("vectors", [data.get("vector", [])])[0]

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        """异步批量向量化"""
        payload = {"model": self.model, "texts": texts}
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(self.base_url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            vectors = data.get("vectors", data.get("data", []))
            return [v if isinstance(v, list) else v.get("vector", []) for v in vectors]


# ─────────────────────────────────────────────
# 统一客户端工厂
# ─────────────────────────────────────────────

class LLMClient:
    """统一 LLM 客户端，根据配置自动选择 provider"""

    def __init__(self):
        self._chat: Optional[BaseChatModel] = None
        self._embed: Optional[MiniMaxEmbeddings] = None

    def _get_chat_model(self) -> BaseChatModel:
        if self._chat is not None:
            return self._chat

        provider = settings.LLM_PROVIDER.lower()

        if provider == "minimax":
            self._chat = MiniMaxChatModel(
                model_name=settings.MINIMAX_MODEL,
                api_key=settings.MINIMAX_API_KEY,
                group_id=settings.MINIMAX_GROUP_ID,
                temperature=settings.LLM_TEMPERATURE,
                max_tokens=settings.LLM_MAX_TOKENS,
            )

        elif provider == "openai":
            from langchain_openai import ChatOpenAI
            self._chat = ChatOpenAI(
                model=settings.LLM_MODEL,
                api_key=settings.OPENAI_API_KEY,
                base_url=settings.OPENAI_BASE_URL,
                temperature=settings.LLM_TEMPERATURE,
                max_tokens=settings.LLM_MAX_TOKENS,
                timeout=120,
            )

        elif provider == "anthropic":
            from langchain_anthropic import ChatAnthropic
            self._chat = ChatAnthropic(
                model=settings.ANTHROPIC_MODEL,
                api_key=settings.ANTHROPIC_API_KEY,
                temperature=settings.LLM_TEMPERATURE,
                max_tokens=settings.LLM_MAX_TOKENS,
                timeout=120,
            )

        elif provider == "azure_openai":
            from langchain_openai import AzureChatOpenAI
            self._chat = AzureChatOpenAI(
                azure_deployment=settings.AZURE_OPENAI_DEPLOYMENT,
                openai_api_key=settings.AZURE_OPENAI_KEY,
                azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                api_version=settings.AZURE_OPENAI_API_VERSION,
                temperature=settings.LLM_TEMPERATURE,
                max_tokens=settings.LLM_MAX_TOKENS,
            )

        else:
            raise ValueError(f"不支持的 LLM_PROVIDER: {provider}")

        return self._chat

    def _get_embedding_model(self):
        if self._embed is not None:
            return self._embed

        provider = settings.EMBED_PROVIDER.lower()

        if provider == "minimax":
            self._embed = MiniMaxEmbeddings(
                api_key=settings.MINIMAX_API_KEY,
                group_id=settings.MINIMAX_GROUP_ID,
                model=settings.MINIMAX_EMBED_MODEL,
                dimensions=settings.EMBED_DIM,
            )

        elif provider == "openai":
            from langchain_openai import OpenAIEmbeddings
            self._embed = OpenAIEmbeddings(
                model=settings.EMBED_MODEL,
                api_key=settings.OPENAI_API_KEY,
                dimensions=settings.EMBED_DIM,
            )

        else:
            raise ValueError(f"不支持的 EMBED_PROVIDER: {provider}")

        return self._embed

    async def agenerate(self, prompt: str) -> str:
        """异步生成（非流式），直接传字符串 prompt"""
        from langchain_core.messages import HumanMessage
        chat = self._get_chat_model()
        response = await chat._agenerate([HumanMessage(content=prompt)])
        return response.generations[0].message.content

    async def aembed(self, text: str) -> list[float]:
        """异步单条 Embedding"""
        embed = self._get_embedding_model()
        return await embed.aembed_query(text)

    async def aembed_batch(self, texts: list[str]) -> list[list[float]]:
        """异步批量 Embedding（推荐，性能更优）"""
        embed = self._get_embedding_model()
        return await embed.aembed_documents(texts)


llm_client = LLMClient()
