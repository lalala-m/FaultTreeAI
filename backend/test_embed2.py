import requests

resp = requests.post(
    "http://localhost:11434/api/embed",
    json={"model": "nomic-embed-text", "input": "test"},
    timeout=60
)
print("status:", resp.status_code)
print("response:", resp.text[:200])
