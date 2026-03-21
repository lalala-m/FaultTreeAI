import httpx
import asyncio

async def test():
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            "http://localhost:11434/api/embed",
            json={"model": "nomic-embed-text", "input": "test drive system failure"}
        )
        print("status:", resp.status_code)
        data = resp.json()
        emb = data["embeddings"][0]
        print("embedding dims:", len(emb))
        print("first 5 values:", emb[:5])

asyncio.run(test())
