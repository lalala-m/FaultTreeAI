"""
故障树生成 API — psycopg2 直连（绕过 asyncpg Windows bug）
"""

import uuid, json
from datetime import datetime
from fastapi import APIRouter, HTTPException
from uuid import UUID

from backend.core.database.models import FaultTree as DBFaultTree
from backend.core.llm.structured_generator import generate_fault_tree
from backend.core.fta.builder import compute_mcs
from backend.core.fta.importance import compute_importance
from backend.models.schemas import GenerateRequest, GenerateResponse, FaultTree, FTANode, FTAGate
from backend.config import settings
import psycopg2

router = APIRouter(tags=["故障树生成"])


def _pg():
    return psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    )


@router.post("/", response_model=GenerateResponse)
async def generate_ft(req: GenerateRequest):
    """基于 RAG 知识库生成故障树"""
    try:
        fault_tree, validation_issues, provider = await generate_fault_tree(req)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    mcs = compute_mcs(fault_tree)
    importance = compute_importance(fault_tree)

    # 持久化到 PostgreSQL
    doc_uuid = None
    if req.doc_ids:
        try:
            doc_uuid = uuid.UUID(req.doc_ids[0])
        except Exception:
            pass

    tree_id = uuid.uuid4()
    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fault_trees
                (tree_id, doc_id, top_event, user_prompt, nodes_json, gates_json,
                 confidence, analysis_summary, is_valid, mcs_json, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                str(tree_id), str(doc_uuid) if doc_uuid else None,
                fault_tree.top_event, req.user_prompt,
                json.dumps([n.model_dump() for n in fault_tree.nodes], ensure_ascii=False),
                json.dumps([g.model_dump() for g in fault_tree.gates], ensure_ascii=False),
                fault_tree.confidence, fault_tree.analysis_summary,
                len(validation_issues) == 0,
                json.dumps(mcs, ensure_ascii=False),
                datetime.utcnow()
            ))
            conn.commit()

    return GenerateResponse(
        fault_tree=fault_tree,
        mcs=mcs,
        importance=importance,
        validation_issues=[str(iss) for iss in validation_issues],
        provider=provider,
    )


@router.get("/", response_model=list)
async def list_trees():
    """列出所有已生成的故障树"""
    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT tree_id, top_event, confidence, is_valid, mcs_json, created_at
                FROM fault_trees ORDER BY created_at DESC
            """)
            rows = cur.fetchall()
    return [
        {
            "tree_id": str(row[0]),
            "top_event": row[1],
            "confidence": row[2],
            "is_valid": row[3],
            "mcs_json": json.loads(row[4]) if row[4] else [],
            "created_at": row[5].isoformat() if row[5] else None,
        }
        for row in rows
    ]


@router.get("/{tree_id}", response_model=GenerateResponse)
async def get_tree(tree_id: str):
    """获取单棵故障树详情"""
    try:
        uuid_obj = UUID(tree_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的故障树ID")

    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT tree_id, top_event, nodes_json, gates_json, confidence,
                       analysis_summary, mcs_json
                FROM fault_trees WHERE tree_id = %s
            """, (tree_id,))
            row = cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="故障树不存在")

    nodes = json.loads(row[2]) if row[2] else []
    gates = json.loads(row[3]) if row[3] else []
    ft = FaultTree(
        top_event=row[1],
        nodes=[FTANode(**n) for n in nodes],
        gates=[FTAGate(**g) for g in gates],
        confidence=row[4] or 0.0,
        analysis_summary=row[5] or "",
    )
    mcs = json.loads(row[6]) if row[6] else []
    importance = compute_importance(ft) if mcs else []

    return GenerateResponse(
        fault_tree=ft,
        mcs=mcs,
        importance=importance,
        validation_issues=[],
    )
