#!/usr/bin/env python3
"""批量导入样本文件到向量数据库"""

import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

import asyncio
import uuid
from backend.core.parser.document import parse_document
from backend.core.rag.pgvector_retriever import add_chunks_to_db
from backend.core.database.connection import AsyncSessionLocal


async def import_file(file_path: str) -> int:
    """导入单个文件，返回文本块数量"""
    print(f"解析: {file_path}")
    chunks = parse_document(file_path)
    print(f"  提取 {len(chunks)} 个文本块")
    
    doc_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as db:
        await add_chunks_to_db(chunks, doc_id, db)
    print(f"  ✓ 已导入")
    return len(chunks)


async def main():
    print("=" * 50)
    print("批量导入样本文件")
    print("=" * 50)
    
    samples_dir = Path("data/samples")
    files = list(samples_dir.glob("*.md"))
    
    print(f"\n找到 {len(files)} 个样本文件\n")
    
    total_chunks = 0
    for file in files:
        try:
            chunks = await import_file(str(file))
            total_chunks += chunks
        except Exception as e:
            print(f"  ✗ 错误: {e}")
    
    print(f"\n{'=' * 50}")
    print(f"完成! 共导入 {len(files)} 个文件, {total_chunks} 个文本块")


if __name__ == "__main__":
    asyncio.run(main())
