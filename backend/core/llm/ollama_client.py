import requests
import asyncio
from concurrent.futures import ThreadPoolExecutor
from backend.config import settings

_executor = ThreadPoolExecutor(max_workers=4)

class OllamaClient:
    def __init__(self):
        self.base_url = settings.OLLAMA_BASE_URL
        self.model = settings.LLM_MODEL

    def _generate_sync(self, prompt: str) -> str:
        resp = requests.post(
            f"{self.base_url}/api/generate",
            json={
                "model": self.model,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": settings.LLM_TEMPERATURE,
                    "num_predict": settings.LLM_MAX_TOKENS,
                }
            },
            timeout=120
        )
        resp.raise_for_status()
        return resp.json()["response"]

    def _embed_sync(self, text: str) -> list:
        resp = requests.post(
            f"{self.base_url}/api/embed",
            json={"model": settings.EMBED_MODEL, "input": text},
            timeout=60
        )
        resp.raise_for_status()
        return resp.json()["embeddings"][0]

    async def generate(self, prompt: str) -> str:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._generate_sync, prompt)

    async def embed(self, text: str) -> list:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_executor, self._embed_sync, text)

ollama_client = OllamaClient()
