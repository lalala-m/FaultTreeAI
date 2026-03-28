"""
故障树编辑 API — psycopg2 直连（绕过 asyncpg Windows bug）
"""

import uuid, json
from fastapi import APIRouter, HTTPException
from uuid import UUID

from backend.core.fta.builder import compute_mcs
from backend.core.fta.importance import compute_importance
from backend.core.validator.checker import validate_fault_tree
from backend.models.schemas import EditRequest, GenerateResponse
from backend.config import settings
import psycopg2

router = APIRouter(tags=["故障树编辑"])


def _pg():
    return psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    )


@router.put("/{tree_id}", response_model=GenerateResponse)
async def update_tree(tree_id: str, data: EditRequest):
    """保存编辑后的故障树（psycopg2 直连）"""
    try:
        uuid_obj = UUID(tree_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的故障树ID")

    # 先查询现有数据
    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tree_id FROM fault_trees WHERE tree_id = %s",
                (tree_id,)
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="故障树不存在")

    # 重新计算 MCS 和校验
    mcs = compute_mcs(data.fault_tree)
    validation_result = validate_fault_tree(data.fault_tree)
    validation_issues = validation_result.get("issues", [])
    importance = compute_importance(data.fault_tree)

    # 更新数据库
    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE fault_trees SET
                    nodes_json = %s,
                    gates_json = %s,
                    confidence = %s,
                    analysis_summary = %s,
                    is_valid = %s,
                    mcs_json = %s
                WHERE tree_id = %s
            """, (
                json.dumps([n.model_dump() for n in data.nodes], ensure_ascii=False),
                json.dumps([g.model_dump() for g in data.gates], ensure_ascii=False),
                data.fault_tree.confidence,
                data.fault_tree.analysis_summary,
                validation_result.get("is_valid", True),
                json.dumps(mcs, ensure_ascii=False),
                tree_id,
            ))
            conn.commit()

    return GenerateResponse(
        tree_id=tree_id,
        fault_tree=data.fault_tree,
        mcs=mcs,
        importance=importance,
        validation_issues=[str(iss) for iss in validation_issues],
    )
