#!/usr/bin/env python3
"""
生成 SQL 导入脚本
用于将 Markdown 文件转换为 SQL INSERT 语句
"""

import uuid
import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

from backend.core.parser.document import parse_document

def generate_sql(file_path: str) -> str:
    """生成 SQL INSERT 语句"""
    chunks = parse_document(file_path)
    
    doc_id = str(uuid.uuid4())
    filename = Path(file_path).name
    
    sql = f"-- 导入文件: {filename}\n"
    sql += f"INSERT INTO documents (doc_id, filename, file_type) VALUES ('{doc_id}', '{filename}', 'markdown');\n\n"
    
    for i, chunk in enumerate(chunks):
        chunk_id = str(uuid.uuid4())
        text = chunk["text"].replace("'", "''").replace("\n", "\\n")  # 转义单引号和换行
        page = chunk.get("page", 0)
        
        sql += f"INSERT INTO document_chunks (chunk_id, doc_id, chunk_index, page_num, text) "
        sql += f"VALUES ('{chunk_id}', '{doc_id}', {i}, {page}, '{text}');\n"
        
        # 向量部分需要实际嵌入，暂时跳过
        sql += f"-- TODO: 添加向量嵌入 (chunk_id: {chunk_id})\n\n"
    
    return sql

def main():
    print("=" * 50)
    print("生成 SQL 导入脚本")
    print("=" * 50)
    
    samples_dir = Path("data/samples")
    files = list(samples_dir.glob("*.md"))
    
    all_sql = "-- FaultTreeAI 知识库导入 SQL\n"
    all_sql += "-- 生成时间: 2024\n\n"
    all_sql += "BEGIN;\n\n"
    
    for file in files:
        print(f"处理: {file.name}")
        sql = generate_sql(str(file))
        all_sql += sql
    
    all_sql += "COMMIT;\n"
    
    # 保存 SQL 文件
    output_file = "data/import_knowledge.sql"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(all_sql)
    
    print(f"\n已生成 SQL 文件: {output_file}")
    print("\n下一步:")
    print(f"  docker exec -i faulttree-db psql -U postgres -d faulttree < {output_file}")

if __name__ == "__main__":
    main()
