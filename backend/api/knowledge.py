"""
知识管理 API — PostgreSQL 持久化
支持文档上传、列表查询、删除、搜索
"""

import uuid
import tiktoken
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException
import aiofiles

from backend.core.parser.document import parse_document
from backend.core.rag.pgvector_retriever import add_chunks_to_db, retrieve
from backend.models.schemas import UploadResponse
from backend.config import settings
import psycopg2, psycopg2.extras

router = APIRouter(tags=["知识管理"])


@router.post("/upload", response_model=UploadResponse)
async def upload_document(
    file: UploadFile = File(...),
):
    """上传设备文档，自动解析分块并存入 PostgreSQL 向量库"""
    # 文件大小校验
    if file.size and file.size > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件大小超过50MB")

    allowed = {".pdf", ".txt", ".log", ".docx"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"不支持的文件格式: {ext}")

    # 生成文档ID
    doc_id = uuid.uuid4()

    # 保存原始文件到本地
    save_path = Path(settings.MANUALS_PATH) / f"{doc_id}_{file.filename}"
    save_path.parent.mkdir(parents=True, exist_ok=True)

    content = await file.read()
    async with aiofiles.open(save_path, "wb") as f:
        await f.write(content)

    # 解析文档
    try:
        chunks = parse_document(str(save_path))
    except Exception as e:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"文档解析失败: {e}")

    if not chunks:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="文档中未提取到有效文本")

    # 创建文档记录（psycopg2 直连）
    import psycopg2.extras
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO documents (doc_id, filename, file_size, file_type, status, metadata)
                VALUES (%s, %s, %s, %s, 'processing', %s)
            """, (
                str(doc_id), file.filename, len(content),
                ext[1:], psycopg2.extras.Json({"original_path": str(save_path)})
            ))
            conn.commit()

    # 估算 token 数（用于成本记录）
    try:
        enc = tiktoken.get_encoding("cl100k_base")
        for chunk in chunks:
            chunk["tokens"] = len(enc.encode(chunk["text"]))
    except Exception:
        for chunk in chunks:
            chunk["tokens"] = None

    # 存入 PostgreSQL（文本 + 向量双写）
    try:
        res = await add_chunks_to_db(chunks, str(doc_id))
        embedded = bool(res.get("embedded"))
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE documents
                    SET status = %s,
                        metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                    WHERE doc_id = %s
                    """,
                    (
                        'active',
                        psycopg2.extras.Json({"embedding": "ok" if embedded else "skipped"}),
                        str(doc_id),
                    )
                )
                conn.commit()
    except ValueError as e:
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE documents
                    SET status = 'failed',
                        metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                    WHERE doc_id = %s
                    """,
                    (psycopg2.extras.Json({"error": str(e)}), str(doc_id))
                )
                conn.commit()
        raise HTTPException(status_code=400, detail=f"向量入库失败: {e}")
    except Exception as e:
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE documents
                    SET status = 'failed',
                        metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                    WHERE doc_id = %s
                    """,
                    (psycopg2.extras.Json({"error": str(e)}), str(doc_id))
                )
                conn.commit()
        raise HTTPException(status_code=500, detail=f"向量入库失败: {e}")

    return UploadResponse(
        doc_id=str(doc_id),
        filename=file.filename,
        chunk_count=len(chunks),
        status="success",
    )


@router.get("/list")
async def list_documents():
    """列出已上传的文档"""
    import psycopg2.extras
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor(name="list_docs") as cur:
            cur.execute("""
                SELECT doc_id, filename, file_size, file_type, upload_time, status
                FROM documents WHERE status <> 'deleted'
                ORDER BY upload_time DESC
            """)
            rows = cur.fetchall()

    return [
        {
            "doc_id": str(row[0]),
            "filename": row[1],
            "file_size": row[2],
            "file_type": row[3],
            "upload_time": row[4].isoformat() if row[4] else None,
            "status": row[5],
        }
        for row in rows
    ]


@router.delete("/{doc_id}")
async def delete_document(doc_id: str):
    """软删除文档（将 status 改为 deleted，向量数据通过外键级联删除）"""
    import psycopg2.extras
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET status = 'deleted' WHERE doc_id = %s AND status <> 'deleted'",
                (doc_id,)
            )
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="文档不存在或已是删除状态")

    return {"message": "文档已删除", "doc_id": doc_id}


@router.get("/stats")
async def get_stats():
    """获取系统统计信息"""
    import psycopg2
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM documents WHERE status = 'active'")
            doc_count = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM document_chunks")
            chunk_count = cur.fetchone()[0]
    return {
        "total_docs": doc_count or 0,
        "total_chunks": chunk_count or 0,
    }


@router.post("/search")
async def search_knowledge(query: str, top_k: int = 5):
    """在知识库中搜索，返回相关段落"""
    try:
        results = await retrieve(query, top_k=top_k)
        return {
            "results": results,
            "count": len(results),
            "query": query,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"搜索失败: {str(e)}")
