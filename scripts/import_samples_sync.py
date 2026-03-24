#!/usr/bin/env python3
"""
知识库导入脚本 - 使用同步方式 (psycopg2)
解决 Windows + asyncpg 的连接问题
"""

import sys
import os
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

import uuid
import psycopg2
from psycopg2 import sql
from backend.core.parser.document import parse_document

# 配置数据库连接
DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "user": "postgres",
    "password": "faulttree123",
    "dbname": "faulttree",
    "client_encoding": "UTF8",
    "connect_timeout": 10
}

# MiniMax Embedding API
import requests

EMBED_URL = "https://api.minimax.io/v1/embeddings"
API_KEY = os.getenv("MINIMAX_API_KEY", "")

def get_embedding(text: str) -> list:
    """获取文本向量"""
    if not API_KEY:
        # 如果没有 API key，使用随机向量（仅用于测试）
        import random
        return [random.random() for _ in range(1024)]
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "embo-01",
        "input": text
    }
    resp = requests.post(EMBED_URL, json=payload, headers=headers, timeout=60)
    data = resp.json()
    vectors = data.get("vectors", [])
    return vectors[0] if vectors else data.get("vector", [])

def get_embeddings_batch(texts: list) -> list:
    """批量获取向量"""
    if not API_KEY:
        import random
        return [[random.random() for _ in range(1024)] for _ in texts]
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "embo-01",
        "texts": texts
    }
    resp = requests.post(EMBED_URL, json=payload, headers=headers, timeout=120)
    data = resp.json()
    vectors = data.get("vectors", data.get("data", []))
    return [v if isinstance(v, list) else v.get("vector", []) for v in vectors]

def create_tables_if_not_exists(conn):
    """创建必要的表"""
    cursor = conn.cursor()
    
    # 启用 pgvector 扩展
    cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")
    
    # 创建 documents 表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS documents (
            doc_id UUID PRIMARY KEY,
            filename VARCHAR(255) NOT NULL,
            file_size BIGINT,
            file_type VARCHAR(20) NOT NULL,
            upload_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            status VARCHAR(20) DEFAULT 'active',
            metadata JSONB DEFAULT '{}'
        )
    """)
    
    # 创建 document_chunks 表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS document_chunks (
            chunk_id UUID PRIMARY KEY,
            doc_id UUID REFERENCES documents(doc_id) ON DELETE CASCADE,
            chunk_index INTEGER NOT NULL,
            page_num INTEGER DEFAULT 0,
            text TEXT NOT NULL,
            token_count INTEGER,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
    """)
    
    # 创建 chunk_embeddings 表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS chunk_embeddings (
            embedding_id UUID PRIMARY KEY,
            chunk_id UUID UNIQUE REFERENCES document_chunks(chunk_id) ON DELETE CASCADE,
            doc_id UUID REFERENCES documents(doc_id) ON DELETE CASCADE,
            embedding VECTOR(1024) NOT NULL,
            model_name VARCHAR(50) DEFAULT 'embo-01',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
    """)
    
    # 创建索引
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON document_chunks(doc_id)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_embeddings_doc_id ON chunk_embeddings(doc_id)
    """)
    
    conn.commit()
    print("✓ 数据库表已创建/验证")

def import_file(conn, file_path: str) -> int:
    """导入单个文件"""
    print(f"\n解析: {file_path}")
    
    # 解析文件
    chunks = parse_document(file_path)
    print(f"  提取 {len(chunks)} 个文本块")
    
    # 生成文档 ID
    doc_id = str(uuid.uuid4())
    filename = Path(file_path).name
    
    cursor = conn.cursor()
    
    # 插入文档记录
    cursor.execute(
        "INSERT INTO documents (doc_id, filename, file_type) VALUES (%s, %s, %s)",
        (doc_id, filename, "markdown")
    )
    
    # 批量获取嵌入向量
    texts = [c["text"] for c in chunks]
    print("  获取向量嵌入...")
    vectors = get_embeddings_batch(texts)
    
    # 插入文本块和向量
    for i, chunk in enumerate(chunks):
        chunk_id = str(uuid.uuid4())
        
        # 插入文本块
        cursor.execute(
            """INSERT INTO document_chunks 
               (chunk_id, doc_id, chunk_index, page_num, text) 
               VALUES (%s, %s, %s, %s, %s)""",
            (chunk_id, doc_id, i, chunk.get("page", 0), chunk["text"])
        )
        
        # 插入向量
        embedding_id = str(uuid.uuid4())
        cursor.execute(
            """INSERT INTO chunk_embeddings 
               (embedding_id, chunk_id, doc_id, embedding, model_name) 
               VALUES (%s, %s, %s, %s, %s)""",
            (embedding_id, chunk_id, doc_id, vectors[i], "embo-01")
        )
    
    conn.commit()
    print(f"  ✓ 已导入 {len(chunks)} 个文本块")
    return len(chunks)

def main():
    print("=" * 50)
    print("知识库导入 - 同步版本")
    print("=" * 50)
    
    # 连接数据库
    print("\n连接数据库...")
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        print("✓ 数据库连接成功")
    except Exception as e:
        print(f"✗ 数据库连接失败: {e}")
        print("\n请确保:")
        print("1. Docker 容器正在运行: docker ps")
        print("2. 端口 5432 未被占用")
        return
    
    # 创建表
    create_tables_if_not_exists(conn)
    
    # 导入样本文件
    samples_dir = Path("data/samples")
    files = list(samples_dir.glob("*.md"))
    
    print(f"\n找到 {len(files)} 个样本文件")
    
    total_chunks = 0
    for file in files:
        try:
            chunks = import_file(conn, str(file))
            total_chunks += chunks
        except Exception as e:
            print(f"  ✗ 错误: {e}")
            conn.rollback()
    
    conn.close()
    
    print(f"\n{'=' * 50}")
    print(f"完成! 共导入 {len(files)} 个文件, {total_chunks} 个文本块")

if __name__ == "__main__":
    main()
