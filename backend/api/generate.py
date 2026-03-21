"""
故障树生成 API — PostgreSQL 持久化
"""

import uuid
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from core.database.connection import get_db
from core.database.models import FaultTree as DBFaultTree
from core.llm.structured_generator import generate_fault_tree
from core.fta.builder import compute_mcs
from core.fta.importance import compute_importance
from models.schemas import GenerateRequest, GenerateResponse

router = APIRouter(prefix="/api/generate", tags=["故障树生成"])


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
