"""
知识管理 API — PostgreSQL 持久化
支持文档上传、列表查询、删除
"""

import uuid
import tiktoken
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
import aiofiles

from backend.core.database.connection import get_db
from backend.core.database.models import Document, DocumentChunk
from backend.core.parser.document import parse_document
from backend.core.rag.pgvector_retriever import add_chunks_to_db
from backend.models.schemas import UploadResponse
from backend.config import settings

router = APIRouter(prefix="/api/knowledge", tags=["知识管理"])


@router.post("/upload", response_model=UploadResponse)
async def upload_document(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
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

    # 创建文档记录
    doc_record = Document(
        doc_id=doc_id,
        filename=file.filename,
        file_size=len(content),
        file_type=ext[1:],
        metadata_={
            "original_path": str(save_path),
        },
    )
    db.add(doc_record)
    await db.commit()

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
        await add_chunks_to_db(chunks, str(doc_id), db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"向量入库失败: {e}")

    return UploadResponse(
        doc_id=str(doc_id),
        filename=file.filename,
        chunk_count=len(chunks),
        status="success",
    )


@router.get("/list")
async def list_documents(db: AsyncSession = Depends(get_db)):
    """列出已上传的文档"""
    result = await db.execute(
        select(Document).where(Document.status == "active").order_by(Document.upload_time.desc())
    )
    docs = result.scalars().all()

    return [
        {
            "doc_id": str(doc.doc_id),
            "filename": doc.filename,
            "file_size": doc.file_size,
            "file_type": doc.file_type,
            "upload_time": doc.upload_time.isoformat() if doc.upload_time else None,
            "status": doc.status,
        }
        for doc in docs
    ]


@router.delete("/{doc_id}")
async def delete_document(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
):
    """软删除文档（将 status 改为 deleted，向量数据通过外键级联删除）"""
    from sqlalchemy import update

    result = await db.execute(
        update(Document)
        .where(Document.doc_id == uuid.UUID(doc_id))
        .values(status="deleted")
    )
    await db.commit()

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="文档不存在")

    return {"message": "文档已删除", "doc_id": doc_id}


@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    """获取系统统计信息"""
    doc_count = await db.scalar(select(func.count()).select_from(Document).where(Document.status == "active"))
    chunk_count = await db.scalar(select(func.count()).select_from(DocumentChunk))
    return {
        "total_docs": doc_count or 0,
        "total_chunks": chunk_count or 0,
    }
