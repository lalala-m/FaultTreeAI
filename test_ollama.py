"""测试 Ollama API"""
import httpx

url = "http://127.0.0.1:11434/api/embeddings"
payload = {"model": "nomic-embed-text", "prompt": "hello"}

print("测试 Ollama embeddings...")
try:
    response = httpx.post(url, json=payload, timeout=30)
    print(f"状态码: {response.status_code}")
    data = response.json()
    print(f"Embedding 维度: {len(data.get('embedding', []))}")
except Exception as e:
    print(f"错误: {e}")
