"""
知识管理 API — PostgreSQL 持久化
支持文档上传、列表查询、删除、搜索
"""

import uuid
import tiktoken
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
import aiofiles

from backend.core.parser.document import parse_document
from backend.core.rag.pgvector_retriever import add_chunks_to_db, retrieve_hybrid
from backend.models.schemas import UploadResponse
from backend.config import settings
import psycopg2, psycopg2.extras

router = APIRouter(tags=["知识管理"])


def _pg():
    return psycopg2.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        user=settings.DB_USER,
        password=settings.DB_PASSWORD,
        database=settings.DB_NAME,
    )


def _ensure_weight_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS knowledge_doc_weights (
            doc_id UUID PRIMARY KEY REFERENCES documents(doc_id) ON DELETE CASCADE,
            helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
            misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
            feedback_count INTEGER NOT NULL DEFAULT 0,
            current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS knowledge_chunk_weights (
            chunk_id UUID PRIMARY KEY REFERENCES document_chunks(chunk_id) ON DELETE CASCADE,
            doc_id UUID NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
            helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
            misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
            feedback_count INTEGER NOT NULL DEFAULT 0,
            current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_weights_doc_id ON knowledge_chunk_weights(doc_id)")


def _calc_weight(helpful: float, misleading: float) -> float:
    try:
        h = float(helpful or 0.0)
        m = float(misleading or 0.0)
    except Exception:
        h, m = 0.0, 0.0
    return round((h + 1.0) / (h + m + 2.0), 4)


def _upsert_doc_weight(cur, doc_id: str, helpful_delta: float, misleading_delta: float):
    cur.execute("""
        INSERT INTO knowledge_doc_weights (
            doc_id, helpful_weight, misleading_weight, feedback_count, current_weight, updated_at
        )
        VALUES (
            %s, %s, %s, %s, %s, NOW()
        )
        ON CONFLICT (doc_id) DO UPDATE SET
            helpful_weight = knowledge_doc_weights.helpful_weight + EXCLUDED.helpful_weight,
            misleading_weight = knowledge_doc_weights.misleading_weight + EXCLUDED.misleading_weight,
            feedback_count = knowledge_doc_weights.feedback_count + EXCLUDED.feedback_count,
            current_weight = %s,
            updated_at = NOW()
    """, (
        doc_id,
        float(helpful_delta),
        float(misleading_delta),
        int((helpful_delta > 0) or (misleading_delta > 0)),
        _calc_weight(helpful_delta, misleading_delta),
        0.5,
    ))
    cur.execute("""
        SELECT helpful_weight, misleading_weight
        FROM knowledge_doc_weights
        WHERE doc_id = %s
    """, (doc_id,))
    row = cur.fetchone()
    if row:
        cur.execute("""
            UPDATE knowledge_doc_weights
            SET current_weight = %s, updated_at = NOW()
            WHERE doc_id = %s
        """, (_calc_weight(row[0], row[1]), doc_id))


def _upsert_chunk_weight(cur, chunk_id: str, doc_id: str, helpful_delta: float, misleading_delta: float):
    cur.execute("""
        INSERT INTO knowledge_chunk_weights (
            chunk_id, doc_id, helpful_weight, misleading_weight, feedback_count, current_weight, updated_at
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, NOW()
        )
        ON CONFLICT (chunk_id) DO UPDATE SET
            helpful_weight = knowledge_chunk_weights.helpful_weight + EXCLUDED.helpful_weight,
            misleading_weight = knowledge_chunk_weights.misleading_weight + EXCLUDED.misleading_weight,
            feedback_count = knowledge_chunk_weights.feedback_count + EXCLUDED.feedback_count,
            current_weight = %s,
            updated_at = NOW()
    """, (
        chunk_id,
        doc_id,
        float(helpful_delta),
        float(misleading_delta),
        int((helpful_delta > 0) or (misleading_delta > 0)),
        _calc_weight(helpful_delta, misleading_delta),
        0.5,
    ))
    cur.execute("""
        SELECT helpful_weight, misleading_weight
        FROM knowledge_chunk_weights
        WHERE chunk_id = %s
    """, (chunk_id,))
    row = cur.fetchone()
    if row:
        cur.execute("""
            UPDATE knowledge_chunk_weights
            SET current_weight = %s, updated_at = NOW()
            WHERE chunk_id = %s
        """, (_calc_weight(row[0], row[1]), chunk_id))


class KnowledgeWeightFeedbackRequest(BaseModel):
    doc_id: str
    chunk_id: str | None = None
    feedback_type: str
    amount: float = 1.0


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
    try:
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
    except Exception as e:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=503, detail=f"数据库不可用或写入失败: {e}")

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
    with _pg() as conn:
        with conn.cursor() as cur:
            _ensure_weight_tables(cur)
            conn.commit()
        with conn.cursor(name="list_docs") as cur:
            cur.execute("""
                SELECT
                    d.doc_id,
                    d.filename,
                    d.file_size,
                    d.file_type,
                    d.upload_time,
                    d.status,
                    COALESCE(kdw.current_weight, 0.5) AS current_weight,
                    COALESCE(kdw.helpful_weight, 0) AS helpful_weight,
                    COALESCE(kdw.misleading_weight, 0) AS misleading_weight,
                    COALESCE(kdw.feedback_count, 0) AS feedback_count,
                    COUNT(dc.chunk_id) AS chunk_count
                FROM documents d
                LEFT JOIN knowledge_doc_weights kdw ON kdw.doc_id = d.doc_id
                LEFT JOIN document_chunks dc ON dc.doc_id = d.doc_id
                WHERE d.status <> 'deleted'
                GROUP BY d.doc_id, d.filename, d.file_size, d.file_type, d.upload_time, d.status,
                         kdw.current_weight, kdw.helpful_weight, kdw.misleading_weight, kdw.feedback_count
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
            "current_weight": float(row[6]) if row[6] is not None else 0.5,
            "helpful_weight": float(row[7]) if row[7] is not None else 0.0,
            "misleading_weight": float(row[8]) if row[8] is not None else 0.0,
            "feedback_count": int(row[9] or 0),
            "chunk_count": int(row[10] or 0),
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
    with _pg() as conn:
        with conn.cursor() as cur:
            _ensure_weight_tables(cur)
            cur.execute("SELECT COUNT(*) FROM documents WHERE status = 'active'")
            doc_count = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM document_chunks")
            chunk_count = cur.fetchone()[0]
            cur.execute("""
                SELECT
                    COALESCE(AVG(current_weight), 0.5),
                    COALESCE(SUM(helpful_weight), 0),
                    COALESCE(SUM(misleading_weight), 0),
                    COALESCE(SUM(feedback_count), 0)
                FROM knowledge_doc_weights
            """)
            weight_row = cur.fetchone() or (0.5, 0.0, 0.0, 0)
    return {
        "total_docs": doc_count or 0,
        "total_chunks": chunk_count or 0,
        "avg_doc_weight": float(weight_row[0]) if weight_row[0] is not None else 0.5,
        "helpful_weight_total": float(weight_row[1]) if weight_row[1] is not None else 0.0,
        "misleading_weight_total": float(weight_row[2]) if weight_row[2] is not None else 0.0,
        "feedback_count": int(weight_row[3] or 0),
    }


@router.post("/search")
async def search_knowledge(query: str, top_k: int = 5, vector_weight: float = 0.5):
    """在知识库中搜索，返回相关段落"""
    try:
        results = await retrieve_hybrid(query, top_k=top_k, vector_weight=vector_weight)
        return {
            "results": results,
            "count": len(results),
            "query": query,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"搜索失败: {str(e)}")


@router.post("/feedback-weight")
async def feedback_weight(payload: KnowledgeWeightFeedbackRequest):
    feedback_type = str(payload.feedback_type or "").strip().lower()
    if feedback_type not in {"helpful", "misleading"}:
        raise HTTPException(status_code=400, detail="feedback_type 仅支持 helpful 或 misleading")
    amount = float(payload.amount or 1.0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount 必须大于 0")

    helpful_delta = amount if feedback_type == "helpful" else 0.0
    misleading_delta = amount if feedback_type == "misleading" else 0.0

    with _pg() as conn:
        with conn.cursor() as cur:
            _ensure_weight_tables(cur)
            cur.execute("SELECT 1 FROM documents WHERE doc_id = %s AND status <> 'deleted'", (payload.doc_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="文档不存在")
            _upsert_doc_weight(cur, payload.doc_id, helpful_delta, misleading_delta)
            chunk_weight = None
            if payload.chunk_id:
                cur.execute("""
                    SELECT doc_id::text
                    FROM document_chunks
                    WHERE chunk_id = %s AND doc_id = %s::uuid
                """, (payload.chunk_id, payload.doc_id))
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(status_code=404, detail="文档分块不存在或不属于该文档")
                _upsert_chunk_weight(cur, payload.chunk_id, payload.doc_id, helpful_delta, misleading_delta)
                cur.execute("""
                    SELECT current_weight, helpful_weight, misleading_weight, feedback_count
                    FROM knowledge_chunk_weights
                    WHERE chunk_id = %s
                """, (payload.chunk_id,))
                crow = cur.fetchone()
                if crow:
                    chunk_weight = {
                        "chunk_id": payload.chunk_id,
                        "current_weight": float(crow[0]),
                        "helpful_weight": float(crow[1]),
                        "misleading_weight": float(crow[2]),
                        "feedback_count": int(crow[3] or 0),
                    }
            cur.execute("""
                SELECT current_weight, helpful_weight, misleading_weight, feedback_count
                FROM knowledge_doc_weights
                WHERE doc_id = %s
            """, (payload.doc_id,))
            drow = cur.fetchone()
            conn.commit()

    return {
        "doc_id": payload.doc_id,
        "feedback_type": feedback_type,
        "doc_weight": {
            "current_weight": float(drow[0]),
            "helpful_weight": float(drow[1]),
            "misleading_weight": float(drow[2]),
            "feedback_count": int(drow[3] or 0),
        },
        "chunk_weight": chunk_weight,
    }
