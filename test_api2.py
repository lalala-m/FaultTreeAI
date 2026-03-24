import requests

key = 'sk-cp-OYs0AQHYrELPRPhZm9jYv9Z1-LTA5ICetacRLfi1BaI6KycmSyz9UAFGN-OHw4ZKZ6FcmQ_ripVAIAmszBeUt_cuEBFy7371uBVu2YA2FiJL5rMKIMOQA5Y'

# 测试更详细的请求
headers = {
    'Authorization': f'Bearer {key}',
    'Content-Type': 'application/json'
}

# 测试1: minimaxi.com 完整参数
data1 = {
    'model': 'abab6.5s-chat',
    'messages': [{'role': 'user', 'content': '你好'}],
    'stream': False,
    'max_tokens': 100,
    'temperature': 0.7
}

print("=== Test 1: minimaxi.com full params ===")
r1 = requests.post('https://api.minimaxi.com/v1/text/chatcompletion_v2', json=data1, headers=headers, verify=False, timeout=30)
print(f"Status: {r1.status_code}")
print(f"Response: {r1.text}")

# 测试2: 尝试不同的模型
print("\n=== Test 2: MiniMax-M2 model ===")
data2 = {
    'model': 'MiniMax-M2',
    'messages': [{'role': 'user', 'content': '你好'}],
    'stream': False
}
r2 = requests.post('https://api.minimaxi.com/v1/text/chatcompletion_v2', json=data2, headers=headers, verify=False, timeout=30)
print(f"Status: {r2.status_code}")
print(f"Response: {r2.text[:300]}")

# 测试3: 检查账户信息（如果有的话）
print("\n=== Test 3: 用户信息 ===")
r3 = requests.get('https://api.minimaxi.com/v1/user/info', headers=headers, verify=False, timeout=30)
print(f"Status: {r3.status_code}")
print(f"Response: {r3.text}")
