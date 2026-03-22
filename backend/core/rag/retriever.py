import chromadb
from chromadb.config import Settings as ChromaSettings
from backend.core.llm.ollama_client import ollama_client
from backend.config import settings

_client = chromadb.PersistentClient(
    path=settings.CHROMA_PATH,
    settings=ChromaSettings(anonymized_telemetry=False)
)
_collection = _client.get_or_create_collection("fault_knowledge")

async def add_chunks(chunks: list[dict], doc_id: str):
    """将文档分块向量化存入ChromaDB"""
    texts = [c["text"] for c in chunks]
    ids = [f"{doc_id}_{i}" for i, c in enumerate(chunks)]
    metadatas = [{"source": c["source"], "page": c["page"], "doc_id": doc_id} for c in chunks]

    embeddings = []
    for text in texts:
        emb = await ollama_client.embed(text)
        embeddings.append(emb)

    _collection.upsert(ids=ids, embeddings=embeddings, documents=texts, metadatas=metadatas)

async def retrieve(query: str, top_k: int = None, doc_ids: list[str] = None) -> list[dict]:
    """检索与query最相关的段落"""
    k = top_k or settings.RAG_TOP_K
    query_emb = await ollama_client.embed(query)

    where = {"doc_id": {"$in": doc_ids}} if doc_ids else None
    results = _collection.query(
        query_embeddings=[query_emb],
        n_results=k,
        where=where,
        include=["documents", "metadatas", "distances"]
    )

    chunks = []
    for i, (doc, meta, dist) in enumerate(zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0]
    )):
        chunks.append({
            "ref_id": f"REF{i+1:03d}",
            "text": doc,
            "source": meta["source"],
            "page": meta["page"],
            "score": round(1 - dist / 2, 4)  # 余弦距离[0,2]转相似度[0,1]
        })
    return chunks
