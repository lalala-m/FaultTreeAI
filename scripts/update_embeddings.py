#!/usr/bin/env python3
"""
更新向量嵌入 - 使用 Ollama
为已导入的文本块生成向量嵌入
"""

import sys
import os
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

import uuid
import psycopg2
import requests

# 配置数据库连接
DB_CONFIG = {
    "host": "db",
    "port": 5432,
    "user": "postgres",
    "password": "faulttree123",
    "dbname": "faulttree",
    "client_encoding": "UTF8",
}

# Ollama Embedding API
OLLAMA_URL = "http://host.docker.internal:11434/v1/embeddings"
OLLAMA_MODEL = "nomic-embed-text"
OLLAMA_API_KEY = "ollama"

def get_embeddings_batch(texts: list) -> list:
    """批量获取向量 - 使用 Ollama"""
    vectors = []
    
    headers = {
        "Authorization": f"Bearer {OLLAMA_API_KEY}",
        "Content-Type": "application/json"
    }
    
    for text in texts:
        payload = {
            "model": OLLAMA_MODEL,
            "input": text
        }
        
        try:
            resp = requests.post(OLLAMA_URL, json=payload, headers=headers, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            # Ollama v1 API 格式: {"data": [{"embedding": [...]}]}
            embedding = data.get("data", [{}])[0].get("embedding", [])
            vectors.append(embedding)
        except Exception as e:
            print(f"获取向量失败: {e}")
            return None
    
    return vectors

def update_embeddings(conn):
    """更新缺失向量的文本块"""
    cursor = conn.cursor()
    
    # 查找没有向量的文本块
    cursor.execute("""
        SELECT dc.chunk_id, dc.text 
        FROM document_chunks dc
        LEFT JOIN chunk_embeddings ce ON dc.chunk_id = ce.chunk_id
        WHERE ce.chunk_id IS NULL
    """)
    
    chunks = cursor.fetchall()
    
    if not chunks:
        print("✓ 所有文本块已有向量嵌入")
        return 0
    
    print(f"找到 {len(chunks)} 个文本块需要生成向量")
    
    # 批量处理
    batch_size = 5
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i+batch_size]
        texts = [c[1] for c in batch]
        
        print(f"处理批次 {i//batch_size + 1}/{(len(chunks)-1)//batch_size + 1}...")
        
        vectors = get_embeddings_batch(texts)
        if vectors is None:
            print("获取向量失败")
            return -1
        
        for j, (chunk_id, text) in enumerate(batch):
            embedding_id = str(uuid.uuid4())
            vector = vectors[j]
            
            if not vector:
                print(f"  警告: chunk {j} 没有向量")
                continue
            
            # 转换为 PostgreSQL 向量格式
            vector_str = "[" + ",".join(str(v) for v in vector) + "]"
            
            try:
                cursor.execute(
                    """INSERT INTO chunk_embeddings 
                       (embedding_id, chunk_id, doc_id, embedding, model_name)
                       SELECT %s, %s, doc_id, %s::vector, %s
                       FROM document_chunks WHERE chunk_id = %s""",
                    (embedding_id, chunk_id, vector_str, OLLAMA_MODEL, chunk_id)
                )
            except Exception as e:
                print(f"  插入向量失败: {e}")
                conn.rollback()
                return -1
        
        conn.commit()
        print(f"  已处理 {len(batch)} 个")
    
    return len(chunks)

def main():
    print("=" * 50)
    print("更新向量嵌入 - 使用 Ollama")
    print("=" * 50)
    
    print(f"\nOllama URL: {OLLAMA_URL}")
    print(f"Model: {OLLAMA_MODEL}")
    
    # 连接数据库
    print("\n连接数据库...")
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        print("✓ 数据库连接成功")
    except Exception as e:
        print(f"✗ 数据库连接失败: {e}")
        return
    
    # 更新向量
    result = update_embeddings(conn)
    
    conn.close()
    
    if result > 0:
        print(f"\n✓ 成功更新 {result} 个向量嵌入")
    elif result == 0:
        print("\n✓ 无需更新")

if __name__ == "__main__":
    main()
