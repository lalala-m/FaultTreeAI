"""
故障树生成 API — psycopg2 直连（绕过 asyncpg Windows bug）

支持两种生成方式：
1. structured_generator: 现有方式（保持向后兼容）
2. fault_tree_chain: 新的 LangChain LCEL Chain（推荐）
"""

import uuid, json
from datetime import datetime
from fastapi import APIRouter, HTTPException
from uuid import UUID

from backend.core.database.models import FaultTree as DBFaultTree
from backend.core.database.connection import pg_conn
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


def _normalize_generation_error(detail: str) -> tuple[int, str]:
    """规范化生成错误信息"""
    text = str(detail or "").strip()
    status_code = 500

    unavailable_markers = [
        "Provider [",
        "服务不可达",
        "服务当前不可用",
        "缺少 MINIMAX_API_KEY",
        "MiniMax 请求失败",
    ]
    if any(marker in text for marker in unavailable_markers):
        status_code = 503

    parts: list[str] = []
    if "MiniMax 请求失败" in text:
        if "EndOfStream" in text:
            parts.append("MiniMax 连接已建立但被远端中断，请检查当前网络、代理、证书环境或 MiniMax 服务连通性")
        else:
            parts.append("MiniMax 请求失败，请检查当前网络、代理或 API 服务状态")
    elif "MiniMax 服务当前不可用" in text:
        parts.append("MiniMax 当前不可用，请检查配置和网络连通性")

    if "Ollama 服务不可达" in text:
        parts.append("Ollama 未启动或未安装，请先启动本地 Ollama 服务并确认 http://localhost:11434 可访问")

    if status_code == 503 and parts:
        summary = "当前没有可用的故障树生成模型服务。"
        return status_code, f"{summary}{'；'.join(parts)}。原始错误：{text}"

    return status_code, text


async def _generate_with_chain(req: GenerateRequest) -> tuple[FaultTree, list, str]:
    """
    使用新的 LangChain LCEL Chain 生成故障树
    这是推荐的新方式，使用 ProviderFactory 和 LCEL Chain
    """
    from backend.core.langchain.chains.fault_tree_chain import generate_fault_tree_with_chain, get_fault_tree_chain
    from backend.core.llm.manager import ProviderFactory

    # 获取 ChatModel
    chat_model = ProviderFactory.get_chat_model()
    chain = get_fault_tree_chain()

    # 执行生成
    fault_tree, validation_issues = await generate_fault_tree_with_chain(
        chain=chain,
        top_event=req.top_event,
        user_prompt=req.user_prompt,
        top_k=req.rag_top_k or 5,
        doc_ids=req.doc_ids,
        max_retries=settings.MAX_RETRY,
        vector_weight=req.manual_weight or 0.5,
    )

    # 获取 provider 名称
    provider = getattr(chat_model, '_llm_type', str(settings.LLM_PROVIDER))
    return fault_tree, validation_issues, provider


async def _generate_with_structured(req: GenerateRequest) -> tuple[FaultTree, list, str]:
    """
    使用现有的 structured_generator 生成故障树（向后兼容）
    """
    from backend.core.llm.structured_generator import generate_fault_tree as _generate
    return await _generate(req)


@router.post("/", response_model=GenerateResponse)
async def generate_ft(req: GenerateRequest):
    """基于 RAG 知识库生成故障树
    
    支持两种生成方式：
    - 优先使用新的 LCEL Chain（推荐）
    - 失败时回退到 structured_generator（向后兼容）
    """
    try:
        # 优先使用新的 LCEL Chain
        try:
            fault_tree, validation_issues, provider = await _generate_with_chain(req)
        except Exception as chain_error:
            # 回退到 structured_generator
            fault_tree, validation_issues, provider = await _generate_with_structured(req)
    except Exception as e:
        status_code, detail = _normalize_generation_error(str(e))
        raise HTTPException(status_code=status_code, detail=detail)

    # 优化层级结构（增加多层分类）
    from backend.core.fta.builder import restructure_fault_tree
    fault_tree = restructure_fault_tree(fault_tree)

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
    with pg_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO fault_trees
                (tree_id, doc_id, top_event, user_prompt, nodes_json, gates_json,
                 confidence, analysis_summary, is_valid, mcs_json, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (top_event, doc_id) WHERE doc_id IS NOT NULL
                DO UPDATE SET
                    user_prompt = EXCLUDED.user_prompt,
                    nodes_json = EXCLUDED.nodes_json,
                    gates_json = EXCLUDED.gates_json,
                    confidence = EXCLUDED.confidence,
                    analysis_summary = EXCLUDED.analysis_summary,
                    is_valid = EXCLUDED.is_valid,
                    mcs_json = EXCLUDED.mcs_json,
                    created_at = EXCLUDED.created_at
                RETURNING tree_id
                """,
                (
                    str(tree_id),
                    str(doc_uuid) if doc_uuid else None,
                    fault_tree.top_event,
                    req.user_prompt,
                    json.dumps([n.model_dump() for n in fault_tree.nodes], ensure_ascii=False),
                    json.dumps([g.model_dump() for g in fault_tree.gates], ensure_ascii=False),
                    fault_tree.confidence,
                    fault_tree.analysis_summary,
                    len(validation_issues) == 0,
                    json.dumps(mcs, ensure_ascii=False),
                    datetime.utcnow(),
                ),
            )
            returned = cur.fetchone()
            if returned and returned[0]:
                tree_id = UUID(str(returned[0]))
            conn.commit()

    # 记录一次简易会话到 sessions（便于历史查看）
    try:
        messages = json.dumps([
            {"role": "user", "text": req.top_event},
            {"role": "assistant", "text": fault_tree.analysis_summary or "已生成故障树"}
        ], ensure_ascii=False)
        with _pg() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO sessions (tree_id, messages) VALUES (%s, %s)",
                    (str(tree_id), messages)
                )
                conn.commit()
    except Exception:
        # 非关键路径，忽略会话写入失败
        pass

    return GenerateResponse(
        tree_id=str(tree_id),
        fault_tree=fault_tree,
        mcs=mcs,
        importance=importance,
        validation_issues=[str(iss) for iss in validation_issues],
        provider=provider,
    )


@router.get("/", response_model=list)
async def list_trees():
    """列出所有已生成的故障树"""
    with pg_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT tree_id, top_event, confidence, is_valid, created_at
                FROM fault_trees ORDER BY created_at DESC
            """)
            rows = cur.fetchall()
    return [
        {
            "tree_id": str(row[0]),
            "top_event": row[1],
            "confidence": float(row[2]) if row[2] is not None else None,
            "is_valid": row[3],
            "created_at": row[4].isoformat() if row[4] else None,
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

    with pg_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT tree_id, top_event, nodes_json, gates_json, confidence,
                       analysis_summary, mcs_json
                FROM fault_trees WHERE tree_id = %s
            """, (tree_id,))
            row = cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="故障树不存在")

    nodes = json.loads(row[2]) if isinstance(row[2], str) else (row[2] or [])
    gates = json.loads(row[3]) if isinstance(row[3], str) else (row[3] or [])
    ft = FaultTree(
        top_event=row[1],
        nodes=[FTANode(**n) for n in nodes],
        gates=[FTAGate(**g) for g in gates],
        confidence=float(row[4]) if row[4] is not None else 0.0,
        analysis_summary=row[5] or "",
    )
    mcs = (
        json.loads(row[6])
        if isinstance(row[6], str)
        else (row[6] if isinstance(row[6], list) else [])
    )
    importance = compute_importance(ft) if mcs else []

    return GenerateResponse(
        tree_id=str(row[0]),
        fault_tree=ft,
        mcs=mcs,
        importance=importance,
        validation_issues=[],
    )


@router.get("/{tree_id}/session", response_model=dict)
async def get_tree_session(tree_id: str):
    """获取与该故障树关联的最近一次会话消息"""
    try:
        _ = UUID(tree_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的故障树ID")

    with _pg() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT messages
                FROM sessions
                WHERE tree_id = %s
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (tree_id,),
            )
            row = cur.fetchone()
    msgs = []
    if row and row[0]:
        try:
            msgs = json.loads(row[0]) if isinstance(row[0], str) else row[0]
        except Exception:
            msgs = []
    return {"tree_id": tree_id, "messages": msgs}
