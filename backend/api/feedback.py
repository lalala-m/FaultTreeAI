"""
故障树反馈管理 API — psycopg2 直连（绕过 asyncpg Windows bug）
支持反馈记录、列表查询、审核
"""

import uuid, json
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import settings
import psycopg2

router = APIRouter(tags=["反馈管理"])


def _pg():
    return psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    )


# ─────────────────────────────────────────────
# Pydantic 模型
# ─────────────────────────────────────────────

class FeedbackCreate(BaseModel):
    tree_id: str
    original_nodes: List[dict]
    modified_nodes: List[dict]
    original_gates: List[dict]
    modified_gates: List[dict]
    feedback_type: str = "edit"
    feedback_reason: Optional[str] = None


class FeedbackResponse(BaseModel):
    feedback_id: str
    tree_id: str
    original_nodes: List[dict]
    modified_nodes: List[dict]
    original_gates: List[dict]
    modified_gates: List[dict]
    feedback_type: str
    feedback_reason: Optional[str]
    status: str
    created_at: str
    reviewed_at: Optional[str]
    reviewed_by: Optional[str]


class FeedbackReview(BaseModel):
    feedback_id: str
    action: str  # approve/reject


# ─────────────────────────────────────────────
# API 接口
# ─────────────────────────────────────────────

@router.post("/", response_model=FeedbackResponse)
async def create_feedback(feedback: FeedbackCreate):
    """创建新的反馈记录"""
    feedback_id = uuid.uuid4()

    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO fault_tree_feedback
                (feedback_id, tree_id, original_nodes, modified_nodes,
                 original_gates, modified_gates, feedback_type, feedback_reason, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'pending')
            """, (
                str(feedback_id), feedback.tree_id,
                json.dumps(feedback.original_nodes, ensure_ascii=False),
                json.dumps(feedback.modified_nodes, ensure_ascii=False),
                json.dumps(feedback.original_gates, ensure_ascii=False),
                json.dumps(feedback.modified_gates, ensure_ascii=False),
                feedback.feedback_type, feedback.feedback_reason,
            ))
            conn.commit()

    return FeedbackResponse(
        feedback_id=str(feedback_id),
        tree_id=feedback.tree_id,
        original_nodes=feedback.original_nodes,
        modified_nodes=feedback.modified_nodes,
        original_gates=feedback.original_gates,
        modified_gates=feedback.modified_gates,
        feedback_type=feedback.feedback_type,
        feedback_reason=feedback.feedback_reason,
        status="pending",
        created_at=datetime.utcnow().isoformat(),
        reviewed_at=None,
        reviewed_by=None,
    )


@router.get("/", response_model=List[FeedbackResponse])
async def list_feedbacks(
    tree_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 20,
):
    """获取反馈列表"""
    with _pg() as conn:
        with conn.cursor() as cur:
            if tree_id and status:
                cur.execute("""
                    SELECT feedback_id, tree_id, original_nodes, modified_nodes,
                           original_gates, modified_gates, feedback_type, feedback_reason,
                           status, created_at, reviewed_at, reviewed_by
                    FROM fault_tree_feedback
                    WHERE tree_id = %s AND status = %s
                    ORDER BY created_at DESC LIMIT %s
                """, (tree_id, status, limit))
            elif tree_id:
                cur.execute("""
                    SELECT feedback_id, tree_id, original_nodes, modified_nodes,
                           original_gates, modified_gates, feedback_type, feedback_reason,
                           status, created_at, reviewed_at, reviewed_by
                    FROM fault_tree_feedback
                    WHERE tree_id = %s ORDER BY created_at DESC LIMIT %s
                """, (tree_id, limit))
            elif status:
                cur.execute("""
                    SELECT feedback_id, tree_id, original_nodes, modified_nodes,
                           original_gates, modified_gates, feedback_type, feedback_reason,
                           status, created_at, reviewed_at, reviewed_by
                    FROM fault_tree_feedback
                    WHERE status = %s ORDER BY created_at DESC LIMIT %s
                """, (status, limit))
            else:
                cur.execute("""
                    SELECT feedback_id, tree_id, original_nodes, modified_nodes,
                           original_gates, modified_gates, feedback_type, feedback_reason,
                           status, created_at, reviewed_at, reviewed_by
                    FROM fault_tree_feedback
                    ORDER BY created_at DESC LIMIT %s
                """, (limit,))
            rows = cur.fetchall()

    return [
        FeedbackResponse(
            feedback_id=str(row[0]), tree_id=str(row[1]),
            original_nodes=json.loads(row[2]) if row[2] else [],
            modified_nodes=json.loads(row[3]) if row[3] else [],
            original_gates=json.loads(row[4]) if row[4] else [],
            modified_gates=json.loads(row[5]) if row[5] else [],
            feedback_type=row[6] or "", feedback_reason=row[7],
            status=row[8] or "", created_at=row[9].isoformat() if row[9] else "",
            reviewed_at=row[10].isoformat() if row[10] else None,
            reviewed_by=row[11],
        )
        for row in rows
    ]


@router.post("/review")
async def review_feedback(review: FeedbackReview, reviewed_by: str = "admin"):
    """审核反馈（批准/拒绝）"""
    new_status = "approved" if review.action == "approve" else "rejected" if review.action == "reject" else None
    if new_status is None:
        raise HTTPException(status_code=400, detail="无效的操作")

    now = datetime.utcnow()

    with _pg() as conn:
        with conn.cursor() as cur:
            # 更新反馈状态
            cur.execute("""
                UPDATE fault_tree_feedback SET
                    status = %s, reviewed_at = %s, reviewed_by = %s
                WHERE feedback_id = %s
            """, (new_status, now, reviewed_by, review.feedback_id))

            # 如果是批准，同时更新故障树
            if review.action == "approve":
                cur.execute(
                    "SELECT original_nodes, modified_nodes, original_gates, modified_gates, tree_id "
                    "FROM fault_tree_feedback WHERE feedback_id = %s",
                    (review.feedback_id,)
                )
                fb = cur.fetchone()
                if fb:
                    cur.execute("""
                        UPDATE fault_trees SET
                            nodes_json = %s, gates_json = %s
                        WHERE tree_id = %s
                    """, (fb[1], fb[3], str(fb[4])))
            conn.commit()

    return {"message": f"反馈已{review.action}", "feedback_id": review.feedback_id}


@router.get("/stats")
async def get_feedback_stats():
    """获取反馈统计"""
    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT status, COUNT(*) FROM fault_tree_feedback GROUP BY status
            """)
            rows = cur.fetchall()
    stats = {"pending": 0, "approved": 0, "rejected": 0}
    for row in rows:
        if row[0] in stats:
            stats[row[0]] = row[1]
    return stats
