"""
故障树生成 API — PostgreSQL 持久化
"""

import uuid
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID

from backend.core.database.connection import get_db
from backend.core.database.models import FaultTree as DBFaultTree
from backend.core.llm.structured_generator import generate_fault_tree
from backend.core.fta.builder import compute_mcs
from backend.core.fta.importance import compute_importance
from backend.models.schemas import GenerateRequest, GenerateResponse, FaultTree, FTANode, FTAGate

router = APIRouter(tags=["故障树生成"])


@router.post("/", response_model=GenerateResponse)
async def generate_ft(
    req: GenerateRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    基于 RAG 知识库生成故障树
    - RAG 检索：召回与顶事件最相关的知识片段
    - LLM 生成：MiniMax 模型推理生成 JSON 故障树
    - 逻辑校验：循环依赖、孤立节点、逻辑门三层校验
    - 持久化：存入 PostgreSQL
    """
    try:
        fault_tree, validation_issues = await generate_fault_tree(req)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # 计算 MCS
    mcs = compute_mcs(fault_tree)

    # 计算 Birnbaum 重要度
    importance = compute_importance(fault_tree)

    # 持久化到 PostgreSQL
    doc_uuid = None
    if req.doc_ids:
        try:
            doc_uuid = uuid.UUID(req.doc_ids[0])
        except Exception:
            pass

    db_tree = DBFaultTree(
        tree_id=uuid.uuid4(),
        doc_id=doc_uuid,
        top_event=fault_tree.top_event,
        user_prompt=req.user_prompt,
        nodes_json=[n.model_dump() for n in fault_tree.nodes],
        gates_json=[g.model_dump() for g in fault_tree.gates],
        confidence=fault_tree.confidence,
        analysis_summary=fault_tree.analysis_summary,
        is_valid=len(validation_issues) == 0,
        mcs_json=mcs,
    )
    db.add(db_tree)
    await db.commit()

    return GenerateResponse(
        fault_tree=fault_tree,
        mcs=mcs,
        importance=importance,
        validation_issues=[str(iss) for iss in validation_issues],
    )


@router.get("/", response_model=list)
async def list_trees(db: AsyncSession = Depends(get_db)):
    """列出所有已生成的故障树"""
    result = await db.execute(
        select(DBFaultTree).order_by(DBFaultTree.created_at.desc())
    )
    trees = result.scalars().all()
    return [
        {
            "tree_id": str(t.tree_id),
            "top_event": t.top_event,
            "confidence": t.confidence,
            "is_valid": t.is_valid,
            "mcs_json": t.mcs_json,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in trees
    ]


@router.get("/{tree_id}", response_model=GenerateResponse)
async def get_tree(tree_id: str, db: AsyncSession = Depends(get_db)):
    """获取单棵故障树详情"""
    try:
        uuid_obj = UUID(tree_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的故障树ID")
    
    result = await db.execute(
        select(DBFaultTree).where(DBFaultTree.tree_id == uuid_obj)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="故障树不存在")

    nodes = [FTANode(**n) for n in t.nodes_json] if t.nodes_json else []
    gates = [FTAGate(**g) for g in t.gates_json] if t.gates_json else []
    ft = FaultTree(
        top_event=t.top_event,
        nodes=nodes,
        gates=gates,
        confidence=t.confidence or 0.0,
        analysis_summary=t.analysis_summary or "",
    )
    mcs = t.mcs_json or []
    importance = []
    if mcs:
        importance = compute_importance(ft)

    return GenerateResponse(
        fault_tree=ft,
        mcs=mcs,
        importance=importance,
        validation_issues=[],
    )
