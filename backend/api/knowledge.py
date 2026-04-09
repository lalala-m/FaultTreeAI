"""
知识管理 API — PostgreSQL 持久化
支持文档上传、列表查询、删除、搜索
"""

import uuid
import tiktoken
import json
import re
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Form
import aiofiles
from pydantic import BaseModel
from backend.core.llm.embeddings import get_unified_embeddings
from backend.core.knowledge.ai_graph_extractor import extract_knowledge_items_with_ai

from backend.core.parser.document import parse_document
from backend.core.rag.pgvector_retriever import add_chunks_to_db, retrieve
from backend.models.schemas import UploadResponse
from backend.config import settings
import psycopg2, psycopg2.extras

router = APIRouter(tags=["知识管理"])


class KnowledgeWeightFeedbackRequest(BaseModel):
    doc_id: str
    chunk_id: str | None = None
    feedback_type: str
    amount: float = 1.0


def _calc_weight(helpful: float, misleading: float) -> float:
    h = float(helpful or 0)
    m = float(misleading or 0)
    return round((h + 1.0) / (h + m + 2.0), 4)

def _normalize_pipeline(pipeline: str | None) -> str:
    p = (pipeline or "").strip()
    if not p:
        return "流水线1"
    if len(p) > 64:
        raise HTTPException(status_code=400, detail="流水线名称过长（最大64字符）")
    return p


def _infer_device_from_filename(name: str) -> str:
    n = str(name or "").strip()
    n = re.sub(r"\.[^.]+$", "", n)
    m = re.search(r"([\u4e00-\u9fff]{2,20})(维修保养手册|维修手册|保养手册)?", n)
    return (m.group(1) if m else (n or "设备")).strip() or "设备"


def _extract_fault_solution_pairs(text: str) -> list[tuple[str, str]]:
    raw = str(text or "")
    if not raw.strip():
        return []

    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.strip() for ln in raw.split("\n") if ln.strip()]
    raw = "\n".join(lines)

    fault_keys = "(故障现象|故障表现|异常现象|故障|异常|报警|失效)"
    reason_keys = "(可能原因|原因分析|原因)"
    sol_keys = "(解决方法|处理方法|排除方法|解决方案|处理措施|解决措施|处理对策|维修方法)"
    fault_re = re.compile(rf"{fault_keys}\s*[:：]\s*(?P<fault>[^\n]{{2,80}})", re.M)
    reason_re = re.compile(rf"{reason_keys}\s*[:：]\s*(?P<reason>[^\n]{{2,160}})", re.M)
    sol_re = re.compile(rf"{sol_keys}\s*[:：]\s*(?P<sol>[^\n]{{2,160}})", re.M)

    pairs: list[tuple[str, str]] = []
    matches = list(fault_re.finditer(raw))
    for i, m in enumerate(matches):
        fault = (m.group("fault") or "").strip()
        if not fault:
            continue
        end = matches[i + 1].start() if i + 1 < len(matches) else min(len(raw), m.end() + 800)
        window = raw[m.end():end]
        rm = reason_re.search(window)
        if rm:
            reason = (rm.group("reason") or "").strip()
            if reason:
                pairs.append((fault[:80], reason[:160]))
                continue
        sm = sol_re.search(window)
        if sm:
            sol = (sm.group("sol") or "").strip()
            if sol:
                pairs.append((fault[:80], sol[:160]))

    if pairs:
        return pairs

    split_re = re.compile(r"[|｜\t]{1,}| {2,}")
    for idx, ln in enumerate(lines):
        if ("故障" in ln or "异常" in ln) and ("现象" in ln or "表现" in ln) and (("处理" in ln) or ("解决" in ln) or ("排除" in ln) or ("原因" in ln)):
            for row in lines[idx + 1: idx + 45]:
                if ("故障" in row and ("现象" in row or "表现" in row)) and (("处理" in row) or ("解决" in row) or ("排除" in row)):
                    break
                parts = [p.strip() for p in split_re.split(row) if p.strip()]
                if len(parts) >= 2:
                    fault = parts[0][:80]
                    sol = parts[-1][:160]
                    if fault and sol and fault != sol:
                        pairs.append((fault, sol))
            if pairs:
                return pairs

    for ln in lines:
        if not (("故障" in ln) or ("异常" in ln) or ("报警" in ln) or ("失效" in ln)):
            continue
        if not (("处理" in ln) or ("解决" in ln) or ("排除" in ln) or ("更换" in ln) or ("检查" in ln)):
            continue
        parts = [p.strip() for p in split_re.split(ln) if p.strip()]
        if len(parts) >= 2:
            fault = parts[0][:80]
            sol = parts[1][:160]
            if fault and sol and fault != sol:
                pairs.append((fault, sol))

    if pairs:
        return pairs

    warn_headers = ("警告", "注意", "危险", "提示")
    bullet_re = re.compile(r"^[•●\-]\s*(?P<item>.{2,160})$")
    action_re = re.compile(r"(按照|避免|只能|请|应当|应该|必须|禁止|严禁|确保|建议)")

    idx = 0
    while idx < len(lines):
        ln = lines[idx]
        header = None
        for h in warn_headers:
            if ln == h or ln.startswith(h):
                header = h
                break
        if not header:
            idx += 1
            continue

        fault = None
        if ln != header:
            fault = ln.replace(header, "", 1).strip(" ：:")[:80]
        if not fault and idx + 1 < len(lines):
            fault = lines[idx + 1][:80]

        solutions: list[str] = []
        for nxt in lines[idx + 1: idx + 25]:
            if any(nxt == h or nxt.startswith(h) for h in warn_headers):
                break
            m = bullet_re.match(nxt)
            if m:
                item = (m.group("item") or "").strip()
                if item:
                    solutions.append(item[:160])
                    continue
            if action_re.search(nxt) and len(nxt) >= 4:
                solutions.append(nxt[:160])
        solutions = list(dict.fromkeys([s for s in solutions if s]))[:6]

        if fault and solutions:
            for sol in solutions:
                pairs.append((fault, sol))

        idx += 1

    return pairs


def _build_graph_for_line(line: str) -> dict:
    line = (line or "").strip() or "流水线1"
    devices_map: dict[str, dict[str, set[str]]] = {}
    doc_count = 0

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        _ensure_structured_knowledge_tables(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT machine, machine_category, machine, problem_category, problem, root_cause, solution
                FROM knowledge_items
                WHERE status = 'active' AND pipeline = %s
                ORDER BY updated_at DESC
                LIMIT 800
                """,
                (line,),
            )
            rows = cur.fetchall() or []
            for machine, machine_category, machine_name, problem_category, problem, root_cause, solution in rows:
                device = (str(machine_name or "").strip() or str(machine or "").strip() or str(machine_category or "").strip() or "设备")[:60]
                fault = (str(problem or "").strip() or "设备运行异常").strip()
                rc = str(root_cause or "").strip()
                cause_text = rc if rc else "原因未明确（需补充）"
                if not device or not fault or not cause_text:
                    continue
                if device not in devices_map:
                    devices_map[device] = {}
                if fault not in devices_map[device]:
                    devices_map[device][fault] = set()
                devices_map[device][fault].add(cause_text)

            cur.execute(
                """
                SELECT doc_id, filename
                FROM documents
                WHERE status = 'active'
                  AND COALESCE(metadata->>'pipeline', '流水线1') = %s
                ORDER BY upload_time DESC
                """,
                (line,),
            )
            docs = cur.fetchall() or []
            doc_count = len(docs)
            for doc_id, filename in docs:
                device = _infer_device_from_filename(filename)
                if device not in devices_map:
                    devices_map[device] = {}

                cur.execute(
                    """
                    SELECT text
                    FROM document_chunks
                    WHERE doc_id = %s
                    ORDER BY chunk_index
                    LIMIT 220
                    """,
                    (str(doc_id),),
                )
                chunk_rows = cur.fetchall() or []
                for (chunk_text,) in chunk_rows:
                    pairs = _extract_fault_solution_pairs(chunk_text)
                    for fault, cause in pairs:
                        if fault not in devices_map[device]:
                            devices_map[device][fault] = set()
                        if cause:
                            devices_map[device][fault].add(cause)

    devices = []
    fault_count = 0
    for device_name, faults in devices_map.items():
        fault_items = []
        for fault_name, sols in faults.items():
            if not fault_name:
                continue
            solutions = [s for s in sols if s and len(s) >= 2]
            solutions = list(dict.fromkeys(solutions))[:8]
            if not solutions:
                continue
            fault_items.append({"name": fault_name[:80], "solutions": solutions})

        if fault_items:
            fault_items = fault_items[:15]
            fault_count += len(fault_items)
            devices.append({"name": device_name[:60], "faults": fault_items})

    return {
        "line": line,
        "devices": devices,
        "doc_count": doc_count,
        "device_count": len(devices),
        "fault_count": fault_count,
    }


def _ensure_graph_cache_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS knowledge_graph_cache (
                line VARCHAR(120) PRIMARY KEY,
                graph_json JSONB NOT NULL,
                doc_count INTEGER NOT NULL DEFAULT 0,
                device_count INTEGER NOT NULL DEFAULT 0,
                fault_count INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_knowledge_graph_cache_updated_at
            ON knowledge_graph_cache(updated_at DESC)
            """
        )
        conn.commit()


def _ensure_structured_knowledge_tables(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS knowledge_items (
                item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                pipeline VARCHAR(64) NOT NULL DEFAULT '流水线1',
                machine_category VARCHAR(120) NOT NULL DEFAULT '',
                machine VARCHAR(160) NOT NULL DEFAULT '',
                problem_category VARCHAR(120) NOT NULL DEFAULT '',
                problem TEXT NOT NULL,
                root_cause TEXT NOT NULL DEFAULT '',
                solution TEXT NOT NULL DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(20) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_knowledge_items_pipeline
            ON knowledge_items(pipeline)
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS knowledge_item_embeddings (
                embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                item_id UUID NOT NULL REFERENCES knowledge_items(item_id) ON DELETE CASCADE UNIQUE,
                embedding VECTOR(1024),
                model_name VARCHAR(50) NOT NULL DEFAULT 'embo-01',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS knowledge_item_weights (
                item_id UUID PRIMARY KEY REFERENCES knowledge_items(item_id) ON DELETE CASCADE,
                helpful_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                misleading_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                feedback_count INTEGER NOT NULL DEFAULT 0,
                current_weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.commit()


@router.post("/upload", response_model=UploadResponse)
async def upload_document(
    file: UploadFile = File(...),
    pipeline: str = Form("流水线1"),
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
    pipeline = _normalize_pipeline(pipeline)

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
                    ext[1:], psycopg2.extras.Json({"original_path": str(save_path), "pipeline": pipeline})
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
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor(name="list_docs") as cur:
            cur.execute("""
                SELECT
                    d.doc_id,
                    d.filename,
                    d.file_size,
                    d.file_type,
                    d.upload_time,
                    d.status,
                    COALESCE(d.metadata->>'pipeline', '流水线1') AS pipeline,
                    COALESCE(w.helpful_weight, 0) AS helpful_weight,
                    COALESCE(w.misleading_weight, 0) AS misleading_weight,
                    COALESCE(w.feedback_count, 0) AS feedback_count,
                    COALESCE(w.current_weight, 0.5) AS current_weight
                FROM documents d
                LEFT JOIN knowledge_doc_weights w ON w.doc_id = d.doc_id
                WHERE d.status <> 'deleted'
                ORDER BY d.upload_time DESC
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
            "pipeline": row[6] or "流水线1",
            "helpful_weight": float(row[7] or 0),
            "misleading_weight": float(row[8] or 0),
            "feedback_count": int(row[9] or 0),
            "current_weight": float(row[10] if row[10] is not None else 0.5),
        }
        for row in rows
    ]


@router.post("/feedback-weight")
async def feedback_weight(payload: KnowledgeWeightFeedbackRequest):
    feedback_type = str(payload.feedback_type or "").strip().lower()
    if feedback_type not in {"helpful", "misleading"}:
        raise HTTPException(status_code=400, detail="feedback_type 仅支持 helpful 或 misleading")

    try:
        doc_uuid = uuid.UUID(str(payload.doc_id))
    except Exception:
        raise HTTPException(status_code=400, detail="doc_id 不是有效的 UUID")

    chunk_uuid = None
    if payload.chunk_id:
        try:
            chunk_uuid = uuid.UUID(str(payload.chunk_id))
        except Exception:
            raise HTTPException(status_code=400, detail="chunk_id 不是有效的 UUID")

    amount = float(payload.amount or 1.0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount 必须为正数")

    helpful_inc = amount if feedback_type == "helpful" else 0.0
    misleading_inc = amount if feedback_type == "misleading" else 0.0

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO knowledge_doc_weights (doc_id, helpful_weight, misleading_weight, feedback_count, current_weight)
                VALUES (%s, 0, 0, 0, 0.5)
                ON CONFLICT (doc_id) DO NOTHING
                """,
                (str(doc_uuid),),
            )
            cur.execute(
                "SELECT helpful_weight, misleading_weight FROM knowledge_doc_weights WHERE doc_id = %s FOR UPDATE",
                (str(doc_uuid),),
            )
            row = cur.fetchone() or (0.0, 0.0)
            helpful = float(row[0] or 0) + helpful_inc
            misleading = float(row[1] or 0) + misleading_inc
            weight = _calc_weight(helpful, misleading)
            cur.execute(
                """
                UPDATE knowledge_doc_weights
                SET helpful_weight = %s,
                    misleading_weight = %s,
                    feedback_count = feedback_count + 1,
                    current_weight = %s,
                    updated_at = NOW()
                WHERE doc_id = %s
                """,
                (helpful, misleading, weight, str(doc_uuid)),
            )

            chunk_weight = None
            if chunk_uuid:
                cur.execute(
                    """
                    INSERT INTO knowledge_chunk_weights (chunk_id, doc_id, helpful_weight, misleading_weight, feedback_count, current_weight)
                    VALUES (%s, %s, 0, 0, 0, 0.5)
                    ON CONFLICT (chunk_id) DO NOTHING
                    """,
                    (str(chunk_uuid), str(doc_uuid)),
                )
                cur.execute(
                    "SELECT helpful_weight, misleading_weight FROM knowledge_chunk_weights WHERE chunk_id = %s FOR UPDATE",
                    (str(chunk_uuid),),
                )
                crow = cur.fetchone() or (0.0, 0.0)
                chelpful = float(crow[0] or 0) + helpful_inc
                cmisleading = float(crow[1] or 0) + misleading_inc
                chunk_weight = _calc_weight(chelpful, cmisleading)
                cur.execute(
                    """
                    UPDATE knowledge_chunk_weights
                    SET helpful_weight = %s,
                        misleading_weight = %s,
                        feedback_count = feedback_count + 1,
                        current_weight = %s,
                        updated_at = NOW()
                    WHERE chunk_id = %s
                    """,
                    (chelpful, cmisleading, chunk_weight, str(chunk_uuid)),
                )

            conn.commit()

    return {
        "doc_id": str(doc_uuid),
        "chunk_id": str(chunk_uuid) if chunk_uuid else None,
        "feedback_type": feedback_type,
        "amount": amount,
        "doc_weight": weight,
        "chunk_weight": chunk_weight,
    }


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


@router.put("/{doc_id}/pipeline")
async def update_document_pipeline(doc_id: str, pipeline: str = "流水线1"):
    pipeline = _normalize_pipeline(pipeline)
    try:
        doc_uuid = uuid.UUID(str(doc_id))
    except Exception:
        raise HTTPException(status_code=400, detail="doc_id 不是有效的 UUID")

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE documents
                SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE doc_id = %s AND status <> 'deleted'
                """,
                (psycopg2.extras.Json({"pipeline": pipeline}), str(doc_uuid)),
            )
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="文档不存在或已删除")

    return {"doc_id": str(doc_uuid), "pipeline": pipeline}


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
            cur.execute(
                """
                SELECT
                    COALESCE(AVG(COALESCE(w.current_weight, 0.5)), 0.5) AS avg_weight,
                    COALESCE(SUM(COALESCE(w.feedback_count, 0)), 0) AS total_feedback
                FROM documents d
                LEFT JOIN knowledge_doc_weights w ON w.doc_id = d.doc_id
                WHERE d.status = 'active'
                """
            )
            row = cur.fetchone() or (0.5, 0)
    return {
        "total_docs": doc_count or 0,
        "total_chunks": chunk_count or 0,
        "avg_doc_weight": float(row[0] if row[0] is not None else 0.5),
        "total_feedback": int(row[1] or 0),
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


@router.get("/pipelines")
async def list_pipelines():
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT pipeline FROM (
                    SELECT COALESCE(metadata->>'pipeline', '流水线1') AS pipeline
                    FROM documents
                    WHERE status <> 'deleted'
                    UNION ALL
                    SELECT pipeline
                    FROM knowledge_items
                    WHERE status <> 'deleted'
                ) t
                WHERE pipeline IS NOT NULL AND pipeline <> ''
                ORDER BY pipeline
                """
            )
            rows = cur.fetchall() or []
    pipelines = [r[0] for r in rows if r and r[0]]
    return {"pipelines": pipelines}


class KnowledgeItemCreateRequest(BaseModel):
    pipeline: str = "流水线1"
    machine_category: str = ""
    machine: str = ""
    problem_category: str = ""
    problem: str
    root_cause: str = ""
    solution: str = ""
    metadata: dict = {}


class KnowledgeItemUpdateRequest(BaseModel):
    pipeline: str | None = None
    machine_category: str | None = None
    machine: str | None = None
    problem_category: str | None = None
    problem: str | None = None
    root_cause: str | None = None
    solution: str | None = None
    metadata: dict | None = None
    status: str | None = None


class KnowledgeItemSearchRequest(BaseModel):
    query: str = ""
    pipeline: str = "流水线1"
    machine_category: str | None = None
    machine: str | None = None
    problem_category: str | None = None
    top_k: int = 10


class KnowledgeItemWeightFeedbackRequest(BaseModel):
    item_id: str
    feedback_type: str
    amount: float = 1.0


def _to_vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"


def _build_item_embedding_text(row: dict) -> str:
    pipeline = str(row.get("pipeline") or "").strip()
    machine_category = str(row.get("machine_category") or "").strip()
    machine = str(row.get("machine") or "").strip()
    problem_category = str(row.get("problem_category") or "").strip()
    problem = str(row.get("problem") or "").strip()
    root_cause = str(row.get("root_cause") or "").strip()
    solution = str(row.get("solution") or "").strip()

    parts = [
        f"流水线：{pipeline}" if pipeline else "",
        f"机械类别：{machine_category}" if machine_category else "",
        f"机械：{machine}" if machine else "",
        f"问题类别：{problem_category}" if problem_category else "",
        f"问题：{problem}" if problem else "",
        f"导致原因：{root_cause}" if root_cause else "",
        f"解决方法：{solution}" if solution else "",
    ]
    return "\n".join([p for p in parts if p])


@router.post("/items")
async def create_knowledge_item(payload: KnowledgeItemCreateRequest):
    pipeline = _normalize_pipeline(payload.pipeline)
    problem = str(payload.problem or "").strip()
    if not problem:
        raise HTTPException(status_code=400, detail="problem 不能为空")

    row = {
        "pipeline": pipeline,
        "machine_category": str(payload.machine_category or "").strip(),
        "machine": str(payload.machine or "").strip(),
        "problem_category": str(payload.problem_category or "").strip(),
        "problem": problem,
        "root_cause": str(payload.root_cause or "").strip(),
        "solution": str(payload.solution or "").strip(),
        "metadata": payload.metadata or {},
    }

    embedding = None
    model_name = None
    embeddings = get_unified_embeddings()
    if embeddings.is_available():
        try:
            embedding = await embeddings.aembed_query(_build_item_embedding_text(row))
            model_name = embeddings.model_name or ""
        except Exception:
            embedding = None
            model_name = None

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO knowledge_items (
                    pipeline, machine_category, machine, problem_category,
                    problem, root_cause, solution, metadata, status
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, 'active')
                RETURNING item_id::text
                """,
                (
                    row["pipeline"],
                    row["machine_category"],
                    row["machine"],
                    row["problem_category"],
                    row["problem"],
                    row["root_cause"],
                    row["solution"],
                    json.dumps(row["metadata"], ensure_ascii=False),
                ),
            )
            item_id = (cur.fetchone() or [None])[0]
            if not item_id:
                raise HTTPException(status_code=500, detail="创建失败")

            cur.execute(
                """
                INSERT INTO knowledge_item_weights (item_id, helpful_weight, misleading_weight, feedback_count, current_weight)
                VALUES (%s::uuid, 0, 0, 0, 0.5)
                ON CONFLICT (item_id) DO NOTHING
                """,
                (item_id,),
            )

            cur.execute(
                """
                INSERT INTO knowledge_item_embeddings (item_id, embedding, model_name)
                VALUES (%s::uuid, %s::vector, %s)
                ON CONFLICT (item_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_name = EXCLUDED.model_name
                """,
                (
                    item_id,
                    _to_vector_literal(embedding) if embedding else None,
                    model_name or "embo-01",
                ),
            )

            conn.commit()

    return {"item_id": item_id}


@router.get("/items")
async def list_knowledge_items(
    pipeline: str = "流水线1",
    machine_category: str | None = None,
    machine: str | None = None,
    problem_category: str | None = None,
    status: str = "active",
    limit: int = 50,
    offset: int = 0,
):
    pipeline = _normalize_pipeline(pipeline)
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))

    filters = ["pipeline = %s"]
    params: list = [pipeline]
    if status:
        filters.append("status = %s")
        params.append(status)
    if machine_category:
        filters.append("machine_category = %s")
        params.append(machine_category)
    if machine:
        filters.append("machine = %s")
        params.append(machine)
    if problem_category:
        filters.append("problem_category = %s")
        params.append(problem_category)
    where_sql = " AND ".join(filters)

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                    ki.item_id::text,
                    ki.pipeline,
                    ki.machine_category,
                    ki.machine,
                    ki.problem_category,
                    ki.problem,
                    ki.root_cause,
                    ki.solution,
                    ki.metadata,
                    ki.status,
                    ki.created_at,
                    ki.updated_at,
                    COALESCE(kw.helpful_weight, 0),
                    COALESCE(kw.misleading_weight, 0),
                    COALESCE(kw.feedback_count, 0),
                    COALESCE(kw.current_weight, 0.5)
                FROM knowledge_items ki
                LEFT JOIN knowledge_item_weights kw ON kw.item_id = ki.item_id
                WHERE {where_sql}
                ORDER BY ki.updated_at DESC
                LIMIT %s OFFSET %s
                """,
                (*params, limit, offset),
            )
            rows = cur.fetchall() or []

    return [
        {
            "item_id": r[0],
            "pipeline": r[1],
            "machine_category": r[2],
            "machine": r[3],
            "problem_category": r[4],
            "problem": r[5],
            "root_cause": r[6],
            "solution": r[7],
            "metadata": r[8] if isinstance(r[8], dict) else {},
            "status": r[9],
            "created_at": r[10].isoformat() if r[10] else None,
            "updated_at": r[11].isoformat() if r[11] else None,
            "helpful_weight": float(r[12] or 0),
            "misleading_weight": float(r[13] or 0),
            "feedback_count": int(r[14] or 0),
            "current_weight": float(r[15] if r[15] is not None else 0.5),
        }
        for r in rows
    ]


@router.put("/items/{item_id}")
async def update_knowledge_item(item_id: str, payload: KnowledgeItemUpdateRequest):
    try:
        item_uuid = uuid.UUID(str(item_id))
    except Exception:
        raise HTTPException(status_code=400, detail="item_id 不是有效的 UUID")

    updates = []
    params: list = []

    if payload.pipeline is not None:
        updates.append("pipeline = %s")
        params.append(_normalize_pipeline(payload.pipeline))
    if payload.machine_category is not None:
        updates.append("machine_category = %s")
        params.append(str(payload.machine_category or "").strip())
    if payload.machine is not None:
        updates.append("machine = %s")
        params.append(str(payload.machine or "").strip())
    if payload.problem_category is not None:
        updates.append("problem_category = %s")
        params.append(str(payload.problem_category or "").strip())
    if payload.problem is not None:
        updates.append("problem = %s")
        params.append(str(payload.problem or "").strip())
    if payload.root_cause is not None:
        updates.append("root_cause = %s")
        params.append(str(payload.root_cause or "").strip())
    if payload.solution is not None:
        updates.append("solution = %s")
        params.append(str(payload.solution or "").strip())
    if payload.metadata is not None:
        updates.append("metadata = %s::jsonb")
        params.append(json.dumps(payload.metadata or {}, ensure_ascii=False))
    if payload.status is not None:
        status = str(payload.status or "").strip()
        if status not in {"active", "deleted"}:
            raise HTTPException(status_code=400, detail="status 仅支持 active 或 deleted")
        updates.append("status = %s")
        params.append(status)

    if not updates:
        return {"item_id": str(item_uuid), "updated": False}

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE knowledge_items SET {', '.join(updates)}, updated_at = NOW() WHERE item_id = %s",
                (*params, str(item_uuid)),
            )
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="记录不存在")

    embeddings = get_unified_embeddings()
    if embeddings.is_available():
        try:
            with psycopg2.connect(
                host=settings.DB_HOST, port=settings.DB_PORT,
                user=settings.DB_USER, password=settings.DB_PASSWORD,
                database=settings.DB_NAME
            ) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT pipeline, machine_category, machine, problem_category, problem, root_cause, solution
                        FROM knowledge_items
                        WHERE item_id = %s
                        """,
                        (str(item_uuid),),
                    )
                    row = cur.fetchone()
                if row:
                    text = _build_item_embedding_text(
                        {
                            "pipeline": row[0],
                            "machine_category": row[1],
                            "machine": row[2],
                            "problem_category": row[3],
                            "problem": row[4],
                            "root_cause": row[5],
                            "solution": row[6],
                        }
                    )
                    vec = await embeddings.aembed_query(text)
                    model_name = embeddings.model_name or "embo-01"
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            INSERT INTO knowledge_item_embeddings (item_id, embedding, model_name)
                            VALUES (%s, %s::vector, %s)
                            ON CONFLICT (item_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_name = EXCLUDED.model_name
                            """,
                            (str(item_uuid), _to_vector_literal(vec), model_name),
                        )
                        conn.commit()
        except Exception:
            pass

    return {"item_id": str(item_uuid), "updated": True}


@router.delete("/items/{item_id}")
async def delete_knowledge_item(item_id: str):
    try:
        item_uuid = uuid.UUID(str(item_id))
    except Exception:
        raise HTTPException(status_code=400, detail="item_id 不是有效的 UUID")

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE knowledge_items SET status = 'deleted', updated_at = NOW() WHERE item_id = %s AND status <> 'deleted'",
                (str(item_uuid),),
            )
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="记录不存在或已删除")
    return {"item_id": str(item_uuid), "deleted": True}


@router.post("/items/search")
async def search_knowledge_items(payload: KnowledgeItemSearchRequest):
    pipeline = _normalize_pipeline(payload.pipeline)
    top_k = max(1, min(int(payload.top_k or 10), 50))
    query = str(payload.query or "").strip()

    filters = ["ki.status = 'active'", "ki.pipeline = %s"]
    params: list = [pipeline]
    if payload.machine_category:
        filters.append("ki.machine_category = %s")
        params.append(payload.machine_category)
    if payload.machine:
        filters.append("ki.machine = %s")
        params.append(payload.machine)
    if payload.problem_category:
        filters.append("ki.problem_category = %s")
        params.append(payload.problem_category)

    embeddings = get_unified_embeddings()
    query_vec = None
    if query and embeddings.is_available():
        try:
            query_vec = await embeddings.aembed_query(query)
        except Exception:
            query_vec = None

    where_sql = " AND ".join(filters)
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            if query_vec:
                cur.execute(
                    f"""
                    SELECT
                        ki.item_id::text,
                        ki.pipeline,
                        ki.machine_category,
                        ki.machine,
                        ki.problem_category,
                        ki.problem,
                        ki.root_cause,
                        ki.solution,
                        COALESCE(kw.current_weight, 0.5) AS item_weight,
                        1 - (ke.embedding <=> %s::vector) AS cosine_sim
                    FROM knowledge_items ki
                    JOIN knowledge_item_embeddings ke ON ke.item_id = ki.item_id
                    LEFT JOIN knowledge_item_weights kw ON kw.item_id = ki.item_id
                    WHERE {where_sql}
                      AND ke.embedding IS NOT NULL
                    ORDER BY (ke.embedding <=> %s::vector) ASC
                    LIMIT %s
                    """,
                    (_to_vector_literal(query_vec), *params, _to_vector_literal(query_vec), top_k),
                )
                rows = cur.fetchall() or []
                results = [
                    {
                        "item_id": r[0],
                        "pipeline": r[1],
                        "machine_category": r[2],
                        "machine": r[3],
                        "problem_category": r[4],
                        "problem": r[5],
                        "root_cause": r[6],
                        "solution": r[7],
                        "item_weight": float(r[8] if r[8] is not None else 0.5),
                        "score": float(r[9] if r[9] is not None else 0.0),
                    }
                    for r in rows
                ]
                results.sort(key=lambda x: (x.get("score", 0) * (0.65 + 0.35 * float(x.get("item_weight", 0.5)))), reverse=True)
                return {"results": results[:top_k], "count": min(len(results), top_k), "query": query, "pipeline": pipeline}

            like = f"%{query}%" if query else "%"
            cur.execute(
                f"""
                SELECT
                    ki.item_id::text,
                    ki.pipeline,
                    ki.machine_category,
                    ki.machine,
                    ki.problem_category,
                    ki.problem,
                    ki.root_cause,
                    ki.solution,
                    COALESCE(kw.current_weight, 0.5) AS item_weight
                FROM knowledge_items ki
                LEFT JOIN knowledge_item_weights kw ON kw.item_id = ki.item_id
                WHERE {where_sql}
                  AND (ki.problem ILIKE %s OR ki.root_cause ILIKE %s OR ki.solution ILIKE %s)
                ORDER BY ki.updated_at DESC
                LIMIT %s
                """,
                (*params, like, like, like, top_k),
            )
            rows = cur.fetchall() or []

    return {
        "results": [
            {
                "item_id": r[0],
                "pipeline": r[1],
                "machine_category": r[2],
                "machine": r[3],
                "problem_category": r[4],
                "problem": r[5],
                "root_cause": r[6],
                "solution": r[7],
                "item_weight": float(r[8] if r[8] is not None else 0.5),
                "score": 0.0,
            }
            for r in rows
        ],
        "count": len(rows),
        "query": query,
        "pipeline": pipeline,
    }


@router.post("/items/feedback-weight")
async def feedback_knowledge_item_weight(payload: KnowledgeItemWeightFeedbackRequest):
    feedback_type = str(payload.feedback_type or "").strip().lower()
    if feedback_type not in {"helpful", "misleading"}:
        raise HTTPException(status_code=400, detail="feedback_type 仅支持 helpful 或 misleading")

    try:
        item_uuid = uuid.UUID(str(payload.item_id))
    except Exception:
        raise HTTPException(status_code=400, detail="item_id 不是有效的 UUID")

    amount = float(payload.amount or 1.0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount 必须为正数")

    helpful_inc = amount if feedback_type == "helpful" else 0.0
    misleading_inc = amount if feedback_type == "misleading" else 0.0

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO knowledge_item_weights (item_id, helpful_weight, misleading_weight, feedback_count, current_weight)
                VALUES (%s, 0, 0, 0, 0.5)
                ON CONFLICT (item_id) DO NOTHING
                """,
                (str(item_uuid),),
            )
            cur.execute(
                "SELECT helpful_weight, misleading_weight FROM knowledge_item_weights WHERE item_id = %s FOR UPDATE",
                (str(item_uuid),),
            )
            row = cur.fetchone() or (0.0, 0.0)
            helpful = float(row[0] or 0) + helpful_inc
            misleading = float(row[1] or 0) + misleading_inc
            weight = _calc_weight(helpful, misleading)
            cur.execute(
                """
                UPDATE knowledge_item_weights
                SET helpful_weight = %s,
                    misleading_weight = %s,
                    feedback_count = feedback_count + 1,
                    current_weight = %s,
                    updated_at = NOW()
                WHERE item_id = %s
                """,
                (helpful, misleading, weight, str(item_uuid)),
            )
            conn.commit()

    return {
        "item_id": str(item_uuid),
        "feedback_type": feedback_type,
        "amount": amount,
        "item_weight": weight,
    }


@router.get("/graph")
async def get_knowledge_graph(line: str = "流水线1", pipeline: str | None = None):
    line = _normalize_pipeline(pipeline or line)
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        _ensure_structured_knowledge_tables(conn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT graph_json, doc_count, device_count, fault_count
                    FROM knowledge_graph_cache
                    WHERE line = %s
                    """,
                    (line,),
                )
                row = cur.fetchone()
                if row and row[0]:
                    data = row[0]
                    if isinstance(data, str):
                        try:
                            data = json.loads(data)
                        except Exception:
                            data = None
                    if isinstance(data, dict):
                        data["doc_count"] = int(row[1] or data.get("doc_count") or 0)
                        data["device_count"] = int(row[2] or data.get("device_count") or 0)
                        data["fault_count"] = int(row[3] or data.get("fault_count") or 0)
                        data["line"] = data.get("line") or line
                        data["devices"] = data.get("devices") or []
                        return data
        except Exception:
            return _build_graph_for_line(line)
    return _build_graph_for_line(line)


class RebuildKnowledgeGraphRequest(BaseModel):
    line: str = "流水线1"
    doc_ids: list[str] | None = None


@router.post("/graph/rebuild")
async def rebuild_knowledge_graph(
    payload: RebuildKnowledgeGraphRequest | None = None,
    pipeline: str | None = None,
    mode: str = "auto",
):
    line = _normalize_pipeline(pipeline or (payload.line if payload else None))

    mode = (mode or "auto").strip().lower()
    if mode not in {"auto", "ai", "rule"}:
        raise HTTPException(status_code=400, detail="mode 仅支持 auto / ai / rule")

    ai_stats = None
    ai_errors: list[str] = []
    ai_provider = ""

    if mode in {"auto", "ai"}:
        try:
            ai_res = await extract_knowledge_items_with_ai(
                pipeline=line,
                doc_ids=(payload.doc_ids if payload else None),
            )
            ai_stats = {
                "extracted": ai_res.extracted,
                "inserted": ai_res.inserted,
                "skipped": ai_res.skipped,
            }
            ai_provider = ai_res.provider or ""
            ai_errors = ai_res.errors or []
        except Exception as e:
            if mode == "ai":
                raise HTTPException(status_code=503, detail=f"AI 抽取失败: {str(e)}")
            ai_errors = [str(e)]
    graph = _build_graph_for_line(line)
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME,
    ) as conn:
        _ensure_graph_cache_table(conn)
        _ensure_structured_knowledge_tables(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO knowledge_graph_cache (line, graph_json, doc_count, device_count, fault_count, updated_at)
                VALUES (%s, %s::jsonb, %s, %s, %s, NOW())
                ON CONFLICT (line)
                DO UPDATE SET
                    graph_json = EXCLUDED.graph_json,
                    doc_count = EXCLUDED.doc_count,
                    device_count = EXCLUDED.device_count,
                    fault_count = EXCLUDED.fault_count,
                    updated_at = NOW()
                """,
                (
                    line,
                    json.dumps(graph, ensure_ascii=False),
                    int(graph.get("doc_count") or 0),
                    int(graph.get("device_count") or 0),
                    int(graph.get("fault_count") or 0),
                ),
            )
            conn.commit()

    return {
        "line": line,
        "rebuilt": int(graph.get("device_count") or 0),
        "failed": 0,
        "doc_count": int(graph.get("doc_count") or 0),
        "device_count": int(graph.get("device_count") or 0),
        "fault_count": int(graph.get("fault_count") or 0),
        "mode": mode,
        "ai_provider": ai_provider,
        "ai_stats": ai_stats,
        "ai_errors": ai_errors[:5],
    }
