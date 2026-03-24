#!/usr/bin/env python3
"""从 Wikipedia 获取故障树相关知识"""

import requests
import json
from pathlib import Path

OUTPUT_DIR = Path("data/samples")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Wikipedia API 端点
WIKI_URLS = [
    ("fta", "https://en.wikipedia.org/api/rest_v1/page/summary/Fault_tree_analysis"),
    ("reliability", "https://en.wikipedia.org/api/rest_v1/page/summary/Reliability_engineering"),
    ("maintenance", "https://en.wikipedia.org/api/rest_v1/page/summary/Industrial_maintenance"),
    ("pm", "https://en.wikipedia.org/api/rest_v1/page/summary/Preventive_maintenance"),
    ("condition_monitoring", "https://en.wikipedia.org/api/rest_v1/page/summary/Condition_monitoring"),
]

def fetch_wiki():
    """获取 Wikipedia 内容"""
    results = {}
    
    for key, url in WIKI_URLS:
        try:
            r = requests.get(url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                results[key] = {
                    "title": data.get("title", ""),
                    "extract": data.get("extract", ""),
                    "description": data.get("description", ""),
                }
                print(f"✓ {key}: {data.get('title', '')}")
            else:
                print(f"✗ {key}: {r.status_code}")
        except Exception as e:
            print(f"✗ {key}: ERROR - {e}")
    
    return results

def save_as_markdown(results):
    """保存为 Markdown"""
    content = "# 故障树分析知识库 (Wikipedia)\n\n"
    content += "> 来源: Wikipedia 公开知识\n\n"
    
    for key, data in results.items():
        content += f"## {data['title']}\n\n"
        content += f"*{data.get('description', '')}*\n\n"
        content += f"{data['extract']}\n\n"
        content += "---\n\n"
    
    filepath = OUTPUT_DIR / "wiki_fault_tree_knowledge.md"
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    
    print(f"\n已保存到: {filepath}")
    return filepath

def main():
    print("=" * 50)
    print("从 Wikipedia 获取故障树知识")
    print("=" * 50)
    
    results = fetch_wiki()
    
    if results:
        save_as_markdown(results)
        print(f"\n成功获取 {len(results)} 篇文章")
    else:
        print("\n获取失败")

if __name__ == "__main__":
    main()
