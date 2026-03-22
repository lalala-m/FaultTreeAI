"""
故障树编辑 API — 保存编辑后的故障树
"""

import uuid
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID

from backend.core.database.connection import get_db
from backend.core.database.models import FaultTree as DBFaultTree
from backend.core.fta.builder import compute_mcs
from backend.core.fta.importance import compute_importance
from backend.core.validator.checker import validate_fault_tree
from backend.models.schemas import EditRequest, GenerateResponse

router = APIRouter(tags=["故障树编辑"])


@router.put("/{tree_id}", response_model=GenerateResponse)
async def update_tree(
    tree_id: str,
    data: EditRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    保存编辑后的故障树（前端传入 nodes + gates，存入数据库）
    """
    try:
        uuid_obj = UUID(tree_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的故障树ID")

    result = await db.execute(
        select(DBFaultTree).where(DBFaultTree.tree_id == uuid_obj)
    )
    tree = result.scalar_one_or_none()
    if not tree:
        raise HTTPException(status_code=404, detail="故障树不存在")

    # 更新故障树数据
    tree.nodes_json = [n.model_dump() for n in data.nodes]
    tree.gates_json = [g.model_dump() for g in data.gates]
    tree.confidence = data.fault_tree.confidence
    tree.analysis_summary = data.fault_tree.analysis_summary

    # 重新计算 MCS
    mcs = compute_mcs(data.fault_tree)
    tree.mcs_json = mcs

    # 重新校验
    validation_result = validate_fault_tree(data.fault_tree)
    tree.is_valid = validation_result.get("is_valid", True)
    validation_issues = validation_result.get("issues", [])

    # 计算重要度
    importance = compute_importance(data.fault_tree)

    await db.commit()

    return GenerateResponse(
        fault_tree=data.fault_tree,
        mcs=mcs,
        importance=importance,
        validation_issues=[str(iss) for iss in validation_issues],
    )
