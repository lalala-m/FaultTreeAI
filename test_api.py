import requests

key = 'sk-cp-OYs0AQHYrELPRPhZm9jYv9Z1-LTA5ICetacRLfi1BaI6KycmSyz9UAFGN-OHw4ZKZ6FcmQ_ripVAIAmszBeUt_cuEBFy7371uBVu2YA2FiJL5rMKIMOQA5Y'

# 测试不同的 API 地址和参数组合
tests = [
    {
        'name': 'minimax.io + group_id',
        'url': 'https://api.minimax.io/v1/text/chatcompletion_v2',
        'data': {'model': 'abab6.5s-chat', 'messages': [{'role': 'user', 'content': '你好'}], 'group_id': '2033019385773302753'}
    },
    {
        'name': 'minimaxi.com + group_id',
        'url': 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
        'data': {'model': 'abab6.5s-chat', 'messages': [{'role': 'user', 'content': '你好'}], 'group_id': '2033019385773302753'}
    },
    {
        'name': 'minimaxi.com + streaming false',
        'url': 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
        'data': {'model': 'abab6.5s-chat', 'messages': [{'role': 'user', 'content': '你好'}], 'stream': False}
    },
]

for test in tests:
    headers = {
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json'
    }
    try:
        r = requests.post(test['url'], json=test['data'], headers=headers, verify=False, timeout=30)
        print(f"{test['name']}: Status={r.status_code}")
        print(f"  Response: {r.text[:200]}")
    except Exception as e:
        print(f"{test['name']}: Error={e}")
    print()
