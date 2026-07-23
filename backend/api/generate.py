"""
故障树生成 API — psycopg2 直连（绕过 asyncpg Windows bug）

支持两种生成方式：
1. structured_generator: 现有方式（保持向后兼容）
2. fault_tree_chain: 新的 LangChain LCEL Chain（推荐）
"""

import uuid, json, re, hashlib
from datetime import datetime
from difflib import SequenceMatcher
from fastapi import APIRouter, HTTPException
from uuid import UUID
from pydantic import BaseModel, Field

from backend.core.database.models import FaultTree as DBFaultTree
from backend.core.database.connection import pg_conn
from backend.core.fta.builder import compute_mcs
from backend.core.fta.importance import compute_importance
from backend.models.schemas import (
    GenerateRequest, GenerateResponse, FaultTree, FTANode, FTAGate,
    ClarifyRequest, ClarifyResponse, ClarifyQuestion,
    ClarifyLookupRequest, ClarifyLookupResponse,
    DiagnosisLookupRequest, DiagnosisLookupResponse,
    DiagnosisStep, StepsRequest, StepsResponse,
    StepsLookupRequest, StepsLookupResponse,
    SaveSessionRequest,
)
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


def _norm_text(s: str) -> str:
    text = str(s or "").strip().lower()
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[`~!@#$%^&*()_\-+=\[\]{};:'\",.<>/?\\|·，。！？、；：‘’“”（）【】《》…—]", "", text)
    return text


def _sim(a: str, b: str) -> float:
    aa = _norm_text(a)
    bb = _norm_text(b)
    if not aa or not bb:
        return 0.0
    if aa == bb:
        return 1.0
    return float(SequenceMatcher(None, aa, bb).ratio())


def _load_cause_feedback_weights() -> dict[str, float]:
    out: dict[str, list[float]] = {}
    try:
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                        ki.root_cause,
                        COALESCE(kw.expert_weight, kw.current_weight, 0.5) AS effective_weight
                    FROM knowledge_items ki
                    LEFT JOIN knowledge_item_weights kw ON kw.item_id = ki.item_id
                    WHERE ki.status = 'active'
                      AND COALESCE(ki.root_cause, '') <> ''
                    """
                )
                rows = cur.fetchall() or []
        for rc, w in rows:
            key = _norm_text(str(rc or ""))
            if not key:
                continue
            v = float(w if w is not None else 0.5)
            v = max(0.0, min(1.0, v))
            out.setdefault(key, []).append(v)
    except Exception:
        return {}

    # 同一根因可能对应多条知识项，取均值作为该根因反馈权重
    merged: dict[str, float] = {}
    for k, vals in out.items():
        if not vals:
            continue
        merged[k] = float(sum(vals) / len(vals))
    return merged


def _extract_causes(nodes_json: list, mcs_json: list, top_k: int = 6, cause_feedback_weights: dict[str, float] | None = None) -> list[dict]:
    nodes = nodes_json if isinstance(nodes_json, list) else []
    mcs = mcs_json if isinstance(mcs_json, list) else []
    node_map = {}
    basic_ids = []
    for n in nodes:
        try:
            nid = str(n.get("id") or "")
            ntype = str(n.get("type") or "")
            name = str(n.get("name") or n.get("label") or "")
        except Exception:
            continue
        if nid:
            node_map[nid] = name
        if nid and ntype == "basic":
            basic_ids.append(nid)

    counts: dict[str, int] = {}
    for cut in mcs:
        if not isinstance(cut, list):
            continue
        for nid in cut:
            sid = str(nid or "")
            if sid in node_map:
                counts[sid] = counts.get(sid, 0) + 1

    cause_feedback_weights = cause_feedback_weights or {}

    def fb_weight(name: str) -> float:
        key = _norm_text(name)
        v = float(cause_feedback_weights.get(key, 0.5))
        return max(0.0, min(1.0, v))

    if counts:
        items = sorted(counts.items(), key=lambda x: (-x[1], x[0]))[: top_k]
        enriched = []
        for nid, c in items:
            name = node_map.get(nid) or nid
            base = float(int(c))
            feedback = fb_weight(name)
            # 综合权重：故障树权重 × 反馈因子（默认 0.5 为中性）
            combined = base * (0.5 + feedback)
            enriched.append((nid, int(c), name, feedback, combined))
        total = sum(x[4] for x in enriched) or 1.0
        out = []
        for nid, c, name, feedback, combined in enriched:
            weight = float(combined / total)
            out.append(
                {
                    "name": name,
                    "count": int(c),
                    "weight": weight,
                    "feedback_weight": feedback,
                    "probability": round(weight * 100, 1),
                }
            )
        return out

    seen = set()
    out = []
    for nid in basic_ids:
        name = node_map.get(nid) or nid
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "count": 1})
        if len(out) >= top_k:
            break
    if out:
        tmp = []
        for x in out:
            name = str(x.get("name") or "")
            feedback = fb_weight(name)
            combined = 1.0 * (0.5 + feedback)
            tmp.append((x, feedback, combined))
        total = sum(z[2] for z in tmp) or 1.0
        for x, feedback, combined in tmp:
            x["weight"] = float(combined / total)
            x["feedback_weight"] = feedback
            x["probability"] = round(float(combined / total) * 100, 1)
    return out


def _ensure_ratings_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS fault_tree_ratings (
                tree_id UUID PRIMARY KEY,
                up_votes INTEGER NOT NULL DEFAULT 0,
                down_votes INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.commit()


def _load_ratings(tree_ids: list[str]) -> dict[str, dict]:
    ids = [str(x) for x in (tree_ids or []) if str(x)]
    if not ids:
        return {}
    with pg_conn() as conn:
        _ensure_ratings_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT tree_id::text, up_votes, down_votes
                FROM fault_tree_ratings
                WHERE tree_id::text = ANY(%s)
                """,
                (ids,),
            )
            rows = cur.fetchall()
    out = {}
    for r in rows:
        out[str(r[0])] = {"up": int(r[1] or 0), "down": int(r[2] or 0)}
    return out


def _rating_score(r: dict | None) -> float:
    if not r:
        return 0.0
    up = int(r.get("up") or 0)
    down = int(r.get("down") or 0)
    return float(up - down)


class LookupRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    window: int = 800
    sim_threshold: float = 0.9


class RateRequest(BaseModel):
    tree_id: str
    vote: str = Field(..., pattern="^(up|down)$")


async def _generate_with_chain(req: GenerateRequest) -> tuple[FaultTree, list, str]:
    """
    使用新的 LangChain LCEL Chain 生成故障树
    这是推荐的新方式，使用 ProviderFactory 和 LCEL Chain
    """
    from backend.core.langchain.chains.fault_tree_chain import generate_fault_tree_with_chain, get_fault_tree_chain
    from backend.core.llm.manager import ProviderFactory

    provider = (req.provider or settings.LLM_PROVIDER or "openai").lower()
    ProviderFactory.get_chat_model(provider)
    chain = get_fault_tree_chain(provider=provider, recreate=True)

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

    # 保存/更新诊断案例（top_event + 答案 → 故障树 + 原因权重）
    try:
        answers = req.clarify_answers or {}
        questions = req.clarify_questions or []
        answers_hash = _compute_answers_hash(answers)
        cause_weights = _extract_cause_weights(fault_tree)
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO diagnosis_cases
                    (top_event, questions, answers, answers_hash, tree_id, cause_weights, steps_json)
                    VALUES (%s, %s, %s, %s, %s, %s, '[]'::jsonb)
                    ON CONFLICT (top_event, answers_hash) DO UPDATE SET
                        questions = EXCLUDED.questions,
                        answers = EXCLUDED.answers,
                        tree_id = EXCLUDED.tree_id,
                        cause_weights = EXCLUDED.cause_weights,
                        steps_json = COALESCE(NULLIF(EXCLUDED.steps_json, '[]'::jsonb), diagnosis_cases.steps_json),
                        hit_count = diagnosis_cases.hit_count + 1,
                        updated_at = NOW()
                    """,
                    (
                        req.top_event,
                        json.dumps([q.model_dump() for q in questions], ensure_ascii=False),
                        json.dumps(answers, ensure_ascii=False),
                        answers_hash,
                        str(tree_id),
                        json.dumps(cause_weights, ensure_ascii=False),
                    ),
                )
                conn.commit()
    except Exception as e:
        print(f"[WARN] diagnosis case save failed: {e}")

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


@router.get("/clarify-history", response_model=list)
async def list_clarify_history():
    """列出所有缓存的 clarify 问题（按 top_event 聚合）"""
    with pg_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, top_event, questions, raw_intro, refined_query_hint, provider, created_at, updated_at
                FROM clarify_cache
                ORDER BY updated_at DESC
                """
            )
            rows = cur.fetchall()
    out = []
    for row in rows:
        questions = row[2] if isinstance(row[2], list) else []
        try:
            if isinstance(row[2], str):
                questions = json.loads(row[2])
        except Exception:
            questions = []
        out.append(
            {
                "id": row[0],
                "top_event": row[1],
                "questions": questions,
                "raw_intro": row[3],
                "refined_query_hint": row[4],
                "provider": row[5],
                "created_at": row[6].isoformat() if row[6] else None,
                "updated_at": row[7].isoformat() if row[7] else None,
            }
        )
    return out


@router.get("/cases", response_model=list)
async def list_diagnosis_cases():
    """列出所有诊断案例（top_event + clarify 答案 → 故障树）"""
    try:
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                        d.case_id,
                        d.top_event,
                        d.questions,
                        d.answers,
                        d.answers_hash,
                        d.tree_id,
                        d.cause_weights,
                        d.steps_json,
                        d.messages_json,
                        d.hit_count,
                        d.created_at,
                        d.updated_at,
                        f.confidence,
                        f.is_valid,
                        f.top_event AS tree_top_event
                    FROM diagnosis_cases d
                    LEFT JOIN fault_trees f ON f.tree_id = d.tree_id
                    ORDER BY d.updated_at DESC
                    """
                )
                rows = cur.fetchall()
        out = []
        for row in rows:
            questions = row[2] if isinstance(row[2], list) else []
            answers = row[3] if isinstance(row[3], dict) else {}
            cause_weights = row[6] if isinstance(row[6], dict) else {}
            steps = row[7] if isinstance(row[7], list) else []
            messages = row[8] if isinstance(row[8], list) else []
            try:
                if isinstance(row[2], str):
                    questions = json.loads(row[2])
            except Exception:
                questions = []
            try:
                if isinstance(row[3], str):
                    answers = json.loads(row[3])
            except Exception:
                answers = {}
            try:
                if isinstance(row[6], str):
                    cause_weights = json.loads(row[6])
            except Exception:
                cause_weights = {}
            try:
                if isinstance(row[7], str):
                    steps = json.loads(row[7])
            except Exception:
                steps = []
            try:
                if isinstance(row[8], str):
                    messages = json.loads(row[8])
            except Exception:
                messages = []
            causes = []
            if isinstance(cause_weights, dict):
                parsed_causes = []
                for key, val in cause_weights.items():
                    if isinstance(val, dict):
                        parsed_causes.append({
                            "name": val.get("name") or key,
                            "weight": float(val.get("weight", 0.5)) if val.get("weight") is not None else 0.5,
                        })
                    else:
                        parsed_causes.append({
                            "name": key,
                            "weight": float(val) if val is not None else 0.5,
                        })
                causes = sorted(parsed_causes, key=lambda x: -x["weight"])
            out.append(
                {
                    "case_id": str(row[0]),
                    "top_event": row[1],
                    "questions": questions,
                    "answers": answers,
                    "answers_hash": row[4],
                    "tree_id": str(row[5]) if row[5] else None,
                    "cause_weights": cause_weights,
                    "steps": steps or [],
                    "messages": messages or [],
                    "causes": causes[:10],
                    "hit_count": row[9],
                    "created_at": row[10].isoformat() if row[10] else None,
                    "updated_at": row[11].isoformat() if row[11] else None,
                    "confidence": float(row[12]) if row[12] is not None else None,
                    "is_valid": row[13],
                    "tree_top_event": row[14],
                }
            )
        return out
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"诊断案例查询失败: {str(e)}")


@router.post("/save_session")
async def save_session(req: SaveSessionRequest):
    """保存/更新某条诊断路径的完整聊天记录"""
    top_event = str(req.top_event or "").strip()
    answers = req.answers or {}
    messages = req.messages or []

    if not top_event:
        raise HTTPException(status_code=400, detail="top_event 不能为空")

    answers_hash = _compute_answers_hash(answers)

    try:
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO diagnosis_cases
                    (top_event, answers, answers_hash, messages_json, hit_count)
                    VALUES (%s, %s, %s, %s, 1)
                    ON CONFLICT (top_event, answers_hash) DO UPDATE SET
                        answers = EXCLUDED.answers,
                        messages_json = EXCLUDED.messages_json,
                        updated_at = NOW()
                    """,
                    (
                        top_event,
                        json.dumps(answers, ensure_ascii=False),
                        answers_hash,
                        json.dumps(messages, ensure_ascii=False),
                    ),
                )
                conn.commit()
        return {"success": True}
    except Exception as e:
        print(f"[WARN] save session failed: {e}")
        raise HTTPException(status_code=500, detail=f"保存会话失败: {str(e)}")


@router.get("/faqs", response_model=list)
async def list_faqs(limit: int = 12, window: int = 500, sim_threshold: float = 0.88):
    lim = max(1, min(int(limit or 12), 50))
    win = max(30, min(int(window or 500), 2000))
    th = float(sim_threshold or 0.88)
    th = max(0.7, min(th, 0.98))

    with pg_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT tree_id, top_event, user_prompt, nodes_json, gates_json, mcs_json, created_at
                FROM fault_trees
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (win,),
            )
            rows = cur.fetchall()

    items = []
    for row in rows:
        tree_id = str(row[0])
        top_event = str(row[1] or "")
        user_prompt = str(row[2] or "")
        nodes_json = json.loads(row[3]) if isinstance(row[3], str) else (row[3] or [])
        gates_json = json.loads(row[4]) if isinstance(row[4], str) else (row[4] or [])
        mcs_json = json.loads(row[5]) if isinstance(row[5], str) else (row[5] if isinstance(row[5], list) else [])
        created_at = row[6].isoformat() if row[6] else None
        items.append(
            {
                "tree_id": tree_id,
                "top_event": top_event,
                "user_prompt": user_prompt,
                "nodes_json": nodes_json,
                "gates_json": gates_json,
                "mcs_json": mcs_json,
                "created_at": created_at,
            }
        )

    rating_map = _load_ratings([it["tree_id"] for it in items])

    clusters: list[dict] = []
    for it in items:
        q = it["top_event"] or it["user_prompt"] or ""
        if not q.strip():
            continue
        placed = False
        for c in clusters:
            if _sim(q, c["question"]) >= th:
                c["count"] += 1
                c["tree_id"] = it["tree_id"]
                c["question"] = c["question"] or q
                if it["created_at"] and (not c["last_seen"] or it["created_at"] > c["last_seen"]):
                    c["last_seen"] = it["created_at"]
                c["_items"].append(it)
                placed = True
                break
        if not placed:
            clusters.append(
                {
                    "question": q,
                    "count": 1,
                    "tree_id": it["tree_id"],
                    "last_seen": it["created_at"],
                    "_items": [it],
                }
            )

    for c in clusters:
        best = None
        for it in c["_items"]:
            sc = _rating_score(rating_map.get(it["tree_id"]))
            key = (sc, it.get("created_at") or "", it.get("tree_id") or "")
            if not best or key > best["key"]:
                best = {"key": key, "it": it}
        if best:
            c["tree_id"] = best["it"]["tree_id"]

    clusters.sort(key=lambda x: (-x["count"], -_rating_score(rating_map.get(x["tree_id"])), x["last_seen"] or "", x["question"]))
    clusters = clusters[:lim]

    cause_feedback_weights = _load_cause_feedback_weights()

    out = []
    for c in clusters:
        rep = c["_items"][0]
        rep = next((it for it in c["_items"] if it["tree_id"] == c["tree_id"]), rep)
        causes = _extract_causes(
            rep.get("nodes_json") or [],
            rep.get("mcs_json") or [],
            top_k=6,
            cause_feedback_weights=cause_feedback_weights,
        )
        rating = rating_map.get(c["tree_id"]) or {"up": 0, "down": 0}
        out.append(
            {
                "question": c["question"],
                "top_event": rep.get("top_event") or c["question"],
                "count": c["count"],
                "tree_id": c["tree_id"],
                "last_seen": c["last_seen"],
                "possible_causes": causes,
                "rating": rating,
            }
        )

    return out


@router.post("/lookup", response_model=dict)
async def lookup_tree(req: LookupRequest):
    q = str(req.query or "").strip()
    win = max(50, min(int(req.window or 800), 3000))
    th = float(req.sim_threshold or 0.8)
    th = max(0.7, min(th, 0.98))

    with pg_conn() as conn:
        _ensure_ratings_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT tree_id::text, top_event, user_prompt, created_at
                FROM fault_trees
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (win,),
            )
            rows = cur.fetchall()

        ids = [str(r[0]) for r in rows if r and r[0]]
        rating_map = _load_ratings(ids)

    best = None
    for r in rows:
        tree_id = str(r[0])
        top_event = str(r[1] or "")
        user_prompt = str(r[2] or "")
        created_at = r[3].isoformat() if r[3] else None
        cand = top_event or user_prompt
        s = _sim(q, cand)
        if s < th:
            continue
        score = s + (_rating_score(rating_map.get(tree_id)) * 0.02)
        key = (score, s, _rating_score(rating_map.get(tree_id)), created_at or "", tree_id)
        if not best or key > best["key"]:
            best = {
                "key": key,
                "tree_id": tree_id,
                "similarity": s,
                "question": top_event or q,
                "created_at": created_at,
                "rating": rating_map.get(tree_id) or {"up": 0, "down": 0},
            }

    if not best:
        return {"found": False}
    return {"found": True, **{k: v for k, v in best.items() if k != "key"}}


@router.post("/rate", response_model=dict)
async def rate_tree(req: RateRequest):
    try:
        _ = UUID(str(req.tree_id))
    except Exception:
        raise HTTPException(status_code=400, detail="无效的故障树ID")
    vote = str(req.vote or "").strip()
    if vote not in {"up", "down"}:
        raise HTTPException(status_code=400, detail="vote 不合法")

    with pg_conn() as conn:
        _ensure_ratings_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO fault_tree_ratings(tree_id, up_votes, down_votes) VALUES (%s, 0, 0) ON CONFLICT (tree_id) DO NOTHING",
                (str(req.tree_id),),
            )
            if vote == "up":
                cur.execute(
                    "UPDATE fault_tree_ratings SET up_votes = up_votes + 1, updated_at = NOW() WHERE tree_id::text = %s RETURNING up_votes, down_votes",
                    (str(req.tree_id),),
                )
            else:
                cur.execute(
                    "UPDATE fault_tree_ratings SET down_votes = down_votes + 1, updated_at = NOW() WHERE tree_id::text = %s RETURNING up_votes, down_votes",
                    (str(req.tree_id),),
                )
            row = cur.fetchone()
            conn.commit()

    return {"tree_id": str(req.tree_id), "rating": {"up": int(row[0] or 0), "down": int(row[1] or 0)}}


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


# ─────────────────────────────────────────────────────────────────────────
# 二次澄清（Clarify）接口
# ─────────────────────────────────────────────────────────────────────────

CLARIFY_SYSTEM_PROMPT = """你是一名资深工业设备故障诊断专家，正在协助工程师排查设备故障。

你的任务：根据用户描述的故障现象，提出 2~4 个**最关键的澄清问题**，帮助锁定故障来源。
问题应围绕：
- 故障现象的**特征**（声音类型、振动方向、温度区间、颜色气味等）
- 故障的**时序特征**（首次出现时间、发生频率、持续时长、是否周期性）
- 故障的**触发条件**（什么工况/负荷/环境下出现，是否与启停相关）
- 故障的**伴随现象**（是否同时有报警、其他部件异常、参数偏差）
- 已做的**初步检查**（是否测量过电压/电流/温度/振动等数值）

要求：
1. 每个问题简短直接，不超过 40 字
2. hint 给出填写示例或常见取值，帮助用户快速回答
3. 不要问与故障无关的问题
4. 不要重复用户已经说过的信息
5. 严格输出 JSON，不要有任何额外文字、代码块标记

输出格式：
{
  "intro": "开场白（如：为了更精准地定位故障源，请补充以下信息：）",
  "questions": [
    {"id": "Q1", "text": "问题正文", "hint": "填写提示或示例", "required": false},
    {"id": "Q2", "text": "问题正文", "hint": "填写提示或示例", "required": true}
  ],
  "refined_query_hint": "若用户回答完上述问题后，可以将原问题改写为这样一句更完整的描述（仅给提示，前端不会直接使用）"
}
"""

CLARIFY_USER_PROMPT_TEMPLATE = """用户描述的故障现象：
{top_event}

{context_block}

请基于以上信息，生成 {max_q} 个最关键的澄清问题。仅输出 JSON："""


# ─────────────────────────────────────────────────────────────────────────
# 排查步骤（Steps）接口
# ─────────────────────────────────────────────────────────────────────────

STEPS_SYSTEM_PROMPT = """你是一名资深工业设备故障诊断专家。请根据用户描述的故障现象和补充回答，输出一套可执行、有顺序的排查步骤。

要求：
1. 每个步骤必须具体可操作，不要泛泛而谈
2. 按“先易后难、先外后内、先安全后复杂”的顺序排列
3. 每个步骤包含：标题、具体操作、预期结果/判断标准、下一步决策提示、注意事项
4. 步骤数量控制在 3~8 步
5. 严格输出 JSON，不要有任何额外文字、代码块标记

输出格式：
{
  "summary": "对当前故障的简要判断（1~2句话）",
  "steps": [
    {
      "step": 1,
      "title": "步骤标题",
      "action": "具体操作内容",
      "expected": "预期结果或判断标准",
      "decision": "若正常则进入下一步；若异常则...",
      "note": "安全或工具注意事项"
    }
  ]
}
"""

STEPS_USER_PROMPT_TEMPLATE = """故障现象：
{top_event}

用户补充回答：
{answers_block}

{context_block}

请基于以上信息，生成一套可执行的排查步骤。仅输出 JSON："""


def _build_answers_block(questions, answers) -> str:
    """把 clarify 问答组装成文本块"""
    lines = []
    if not answers:
        return "（未提供补充信息）"
    qa_map = {q.id: q for q in (questions or [])}
    for qid, ans in answers.items():
        q = qa_map.get(qid)
        qtext = q.text if q else qid
        lines.append(f"- {qtext}\n  回答：{ans}")
    return "\n".join(lines) if lines else "（未提供补充信息）"


def _extract_steps_json(raw: str) -> dict:
    """从 LLM 返回文本中提取 steps JSON"""
    if not raw:
        return {}
    text = raw.strip()
    # 去掉代码块标记
    if text.startswith("```"):
        text = re.sub(r"^```[\w]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    # 尝试找 JSON 范围
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    try:
        data = json.loads(text)
    except Exception:
        return {}
    if isinstance(data, dict) and isinstance(data.get("steps"), list):
        return data
    return {}


async def _build_clarify_context_block(doc_ids=None, top_k: int = 3) -> str:
    """可选：用 RAG 检索的片段作为背景，帮助生成更针对性的澄清问题"""
    if not top_k or top_k <= 0:
        return ""
    try:
        from backend.core.rag.pgvector_retriever import retrieve_hybrid
        chunks = await retrieve_hybrid(
            "", top_k=top_k, doc_ids=doc_ids, vector_weight=0.5
        )
    except Exception:
        return ""

    if not chunks:
        return ""
    lines = ["## 已有相关知识片段（仅作背景参考，不要在问题中重复其内容）"]
    for c in chunks[:top_k]:
        ref = c.get("ref_id") or c.get("source") or ""
        text = (c.get("text") or "").strip().replace("\n", " ")
        if text:
            lines.append(f"- [{ref}] {text[:200]}")
    return "\n".join(lines)


@router.post("/clarify", response_model=ClarifyResponse)
async def clarify_problem(req: ClarifyRequest):
    """根据用户描述的故障现象，由 LLM 动态生成 2~4 个澄清问题。

    流程：
    1. 可选用 RAG 检索相关片段作为背景
    2. 调用 LLM（带 fallback）生成结构化澄清问题
    3. 解析 JSON 返回 ClarifyResponse
    若 LLM 不可用或解析失败，返回 fallback 模板问题（保证前端可用）
    """
    top_event = str(req.top_event or "").strip()
    if not top_event:
        raise HTTPException(status_code=400, detail="top_event 不能为空")

    max_q = int(req.max_questions or 4)
    max_q = max(2, min(max_q, 5))

    # 1) 构造上下文（可选）
    context_block = ""
    try:
        if req.rag_top_k and req.rag_top_k > 0:
            context_block = await _build_clarify_context_block(
                doc_ids=req.doc_ids, top_k=min(int(req.rag_top_k), 5)
            )
    except Exception:
        context_block = ""

    # 2) 组装 prompt
    user_prompt = CLARIFY_USER_PROMPT_TEMPLATE.format(
        top_event=top_event,
        context_block=context_block or "（暂无相关知识背景）",
        max_q=max_q,
    )
    full_prompt = f"{CLARIFY_SYSTEM_PROMPT}\n\n{user_prompt}"

    # 3) 调用 LLM（带 fallback）
    provider_used = None
    data = None
    try:
        from backend.core.llm.manager import get_llm_manager
        manager = get_llm_manager()
        kwargs = {}
        if req.provider:
            kwargs["provider"] = req.provider.lower()
        resp, provider_used = await manager.generate_with_fallback(full_prompt, **kwargs)
        raw = resp.content or ""
        data = _extract_clarify_json(raw)
    except Exception as e:
        # 不抛错，走 fallback
        data = None

    # 4) fallback：返回通用模板问题
    if not data or not isinstance(data, dict) or not data.get("questions"):
        data = _fallback_clarify_questions(top_event, max_q)

    # 5) 规整输出
    raw_qs = data.get("questions") or []
    questions: list[ClarifyQuestion] = []
    for i, q in enumerate(raw_qs[:max_q]):
        if not isinstance(q, dict):
            continue
        qid = str(q.get("id") or f"Q{i + 1}").strip() or f"Q{i + 1}"
        text = str(q.get("text") or "").strip()
        if not text:
            continue
        hint = str(q.get("hint") or "").strip()
        required = bool(q.get("required", False))
        questions.append(ClarifyQuestion(id=qid, text=text, hint=hint, required=required))

    if not questions:
        data = _fallback_clarify_questions(top_event, max_q)
        for q in data.get("questions", []):
            questions.append(ClarifyQuestion(**q))

    response = ClarifyResponse(
        questions=questions,
        refined_query_hint=str(data.get("refined_query_hint") or "").strip(),
        provider=provider_used,
        raw_intro=str(data.get("intro") or "为了更精准地定位故障源，请补充以下信息：").strip(),
    )

    # 保存到缓存表，便于相同 top_event 复用
    try:
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO clarify_cache (top_event, questions, raw_intro, refined_query_hint, provider)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (top_event) DO UPDATE SET
                        questions = EXCLUDED.questions,
                        raw_intro = EXCLUDED.raw_intro,
                        refined_query_hint = EXCLUDED.refined_query_hint,
                        provider = EXCLUDED.provider,
                        updated_at = NOW()
                    """,
                    (
                        top_event,
                        json.dumps([q.model_dump() for q in questions], ensure_ascii=False),
                        response.raw_intro,
                        response.refined_query_hint,
                        provider_used,
                    ),
                )
                conn.commit()
    except Exception as e:
        # 缓存失败不影响主流程
        print(f"[WARN] clarify cache save failed: {e}")

    return response


@router.post("/clarify_lookup", response_model=ClarifyLookupResponse)
async def clarify_lookup(req: ClarifyLookupRequest):
    """根据 top_event 查询历史 clarify 问题缓存"""
    top_event = str(req.top_event or "").strip()
    if not top_event:
        raise HTTPException(status_code=400, detail="top_event 不能为空")

    try:
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT questions, raw_intro, refined_query_hint, provider
                    FROM clarify_cache
                    WHERE top_event = %s
                    LIMIT 1
                    """,
                    (top_event,),
                )
                row = cur.fetchone()
                if row:
                    raw_questions = row[0] or []
                    questions = []
                    for q in raw_questions:
                        if isinstance(q, dict):
                            questions.append(ClarifyQuestion(
                                id=str(q.get("id") or ""),
                                text=str(q.get("text") or ""),
                                hint=str(q.get("hint") or ""),
                                required=bool(q.get("required", False)),
                            ))
                    return ClarifyLookupResponse(
                        found=True,
                        questions=questions,
                        raw_intro=str(row[1] or ""),
                        refined_query_hint=str(row[2] or ""),
                        provider=str(row[3] or ""),
                    )
    except Exception as e:
        print(f"[WARN] clarify lookup failed: {e}")

    return ClarifyLookupResponse(found=False)


def _steps_from_raw(data: dict) -> list[DiagnosisStep]:
    """把原始 steps JSON 规整为 DiagnosisStep 列表"""
    out = []
    for i, s in enumerate(data.get("steps", []) or []):
        if not isinstance(s, dict):
            continue
        out.append(DiagnosisStep(
            step=int(s.get("step") or i + 1),
            title=str(s.get("title") or "").strip(),
            action=str(s.get("action") or "").strip(),
            expected=str(s.get("expected") or "").strip(),
            decision=str(s.get("decision") or "").strip(),
            note=str(s.get("note") or "").strip(),
        ))
    return out


def _save_steps_case(
    top_event: str,
    questions: list[ClarifyQuestion],
    answers: dict,
    steps: list[DiagnosisStep],
    summary: str = "",
) -> None:
    """把排查步骤保存/更新到 diagnosis_cases（tree_id 可能为空）"""
    try:
        answers_hash = _compute_answers_hash(answers)
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO diagnosis_cases
                    (top_event, questions, answers, answers_hash, steps_json, hit_count)
                    VALUES (%s, %s, %s, %s, %s, 1)
                    ON CONFLICT (top_event, answers_hash) DO UPDATE SET
                        questions = EXCLUDED.questions,
                        answers = EXCLUDED.answers,
                        steps_json = EXCLUDED.steps_json,
                        hit_count = diagnosis_cases.hit_count + 1,
                        updated_at = NOW()
                    """,
                    (
                        top_event,
                        json.dumps([q.model_dump() for q in questions], ensure_ascii=False),
                        json.dumps(answers, ensure_ascii=False),
                        answers_hash,
                        json.dumps([s.model_dump() for s in steps], ensure_ascii=False),
                    ),
                )
                conn.commit()
    except Exception as e:
        print(f"[WARN] save steps case failed: {e}")


@router.post("/steps", response_model=StepsResponse)
async def generate_steps(req: StepsRequest):
    """根据 top_event + clarify 答案生成排查步骤"""
    top_event = str(req.top_event or "").strip()
    if not top_event:
        raise HTTPException(status_code=400, detail="top_event 不能为空")

    answers = req.clarify_answers or {}
    questions = req.clarify_questions or []

    # 1) 可选 RAG 上下文
    context_block = ""
    try:
        if req.rag_top_k and req.rag_top_k > 0:
            context_block = await _build_clarify_context_block(
                doc_ids=req.doc_ids, top_k=min(int(req.rag_top_k), 5)
            )
    except Exception:
        context_block = ""

    # 2) 组装 prompt
    answers_block = _build_answers_block(questions, answers)
    user_prompt = STEPS_USER_PROMPT_TEMPLATE.format(
        top_event=top_event,
        answers_block=answers_block,
        context_block=context_block or "（暂无相关知识背景）",
    )
    full_prompt = f"{STEPS_SYSTEM_PROMPT}\n\n{user_prompt}"

    # 3) 调用 LLM
    provider_used = None
    data = None
    try:
        from backend.core.llm.manager import get_llm_manager
        manager = get_llm_manager()
        kwargs = {}
        if req.provider:
            kwargs["provider"] = req.provider.lower()
        resp, provider_used = await manager.generate_with_fallback(full_prompt, **kwargs)
        raw = resp.content or ""
        data = _extract_steps_json(raw)
    except Exception as e:
        print(f"[WARN] generate steps failed: {e}")
        data = None

    # 4) fallback：给一个通用步骤
    if not data or not isinstance(data, dict) or not data.get("steps"):
        data = {
            "summary": f"针对“{top_event}”的通用排查思路：",
            "steps": [
                {
                    "step": 1,
                    "title": "确认故障现象",
                    "action": "详细记录故障表现、发生时间、频次及环境条件。",
                    "expected": "形成清晰的故障描述。",
                    "decision": "若现象不明，继续观察；若已明确，进入下一步。",
                    "note": "避免仅凭印象判断。",
                },
                {
                    "step": 2,
                    "title": "检查相关报警与参数",
                    "action": "查看设备报警记录、运行参数、传感器读数是否异常。",
                    "expected": "定位是否存在异常指标。",
                    "decision": "若有异常，锁定对应部件；若正常，扩大检查范围。",
                    "note": "注意历史趋势而不仅是当前值。",
                },
                {
                    "step": 3,
                    "title": "执行分段隔离测试",
                    "action": "按系统/部件分段排查，逐步缩小故障范围。",
                    "expected": "确定最小故障单元。",
                    "decision": "找到可疑部件后，进行替换或修复验证。",
                    "note": "每次只改变一个变量，便于定位根因。",
                },
            ],
        }

    steps = _steps_from_raw(data)
    summary = str(data.get("summary") or "").strip()

    # 5) 保存到历史记录
    _save_steps_case(top_event, questions, answers, steps, summary)

    return StepsResponse(steps=steps, summary=summary, provider=provider_used)


@router.post("/steps_lookup", response_model=StepsLookupResponse)
async def steps_lookup(req: StepsLookupRequest):
    """根据 top_event + 用户答案组合匹配历史排查步骤"""
    top_event = str(req.top_event or "").strip()
    answers = req.answers or {}
    if not top_event:
        raise HTTPException(status_code=400, detail="top_event 不能为空")

    answers_hash = _compute_answers_hash(answers)

    try:
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT case_id, steps_json, hit_count
                    FROM diagnosis_cases
                    WHERE top_event = %s AND answers_hash = %s
                    LIMIT 1
                    """,
                    (top_event, answers_hash),
                )
                row = cur.fetchone()
                if row:
                    raw_steps = row[1] or []
                    if isinstance(raw_steps, str):
                        try:
                            raw_steps = json.loads(raw_steps or "[]")
                        except Exception:
                            raw_steps = []
                    if raw_steps:
                        cur.execute(
                            "UPDATE diagnosis_cases SET hit_count = hit_count + 1, updated_at = NOW() WHERE case_id = %s",
                            (str(row[0]),)
                        )
                        conn.commit()
                        steps = _steps_from_raw({"steps": raw_steps})
                        return StepsLookupResponse(
                            found=True,
                            steps=steps,
                            summary="",
                            hit_count=int(row[2] or 0) + 1,
                        )
    except Exception as e:
        print(f"[WARN] steps lookup failed: {e}")

    return StepsLookupResponse(found=False)


@router.post("/diagnosis_lookup", response_model=DiagnosisLookupResponse)
async def diagnosis_lookup(req: DiagnosisLookupRequest):
    """根据 top_event + 用户答案组合匹配历史诊断案例"""
    top_event = str(req.top_event or "").strip()
    answers = req.answers or {}
    if not top_event:
        raise HTTPException(status_code=400, detail="top_event 不能为空")

    answers_hash = _compute_answers_hash(answers)

    try:
        with pg_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT d.case_id, d.tree_id, d.cause_weights, d.hit_count,
                           f.nodes_json, f.gates_json, f.confidence, f.analysis_summary,
                           f.mcs_json
                    FROM diagnosis_cases d
                    JOIN fault_trees f ON f.tree_id = d.tree_id
                    WHERE d.top_event = %s AND d.answers_hash = %s
                    LIMIT 1
                    """,
                    (top_event, answers_hash),
                )
                row = cur.fetchone()
                if row:
                    cur.execute(
                        "UPDATE diagnosis_cases SET hit_count = hit_count + 1, updated_at = NOW() WHERE case_id = %s",
                        (str(row[0]),)
                    )
                    conn.commit()
                    raw_nodes = row[4] or []
                    raw_gates = row[5] or []
                    if isinstance(raw_nodes, str):
                        nodes = json.loads(raw_nodes or "[]")
                    else:
                        nodes = raw_nodes
                    if isinstance(raw_gates, str):
                        gates = json.loads(raw_gates or "[]")
                    else:
                        gates = raw_gates
                    fault_tree = FaultTree(
                        top_event=top_event,
                        nodes=[FTANode(**n) for n in nodes],
                        gates=[FTAGate(**g) for g in gates],
                        confidence=float(row[6] or 0),
                        analysis_summary=str(row[7] or ""),
                    )
                    return DiagnosisLookupResponse(
                        found=True,
                        tree_id=str(row[1]),
                        fault_tree=fault_tree,
                        similarity=1.0,
                        hit_count=int(row[3] or 0) + 1,
                    )
    except Exception as e:
        print(f"[WARN] diagnosis lookup failed: {e}")

    return DiagnosisLookupResponse(found=False)


def _compute_answers_hash(answers: dict) -> str:
    """对答案做稳定哈希，用于匹配相同答案组合"""
    normalized = {}
    for k, v in (answers or {}).items():
        key = str(k).strip()
        val = str(v).strip()
        if key and val:
            normalized[key] = val
    payload = json.dumps(normalized, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _extract_cause_weights(fault_tree: FaultTree) -> dict:
    """从故障树中提取基本事件/根原因及其权重"""
    weights = {}
    if not fault_tree or not fault_tree.nodes:
        return weights
    for node in fault_tree.nodes:
        if getattr(node, "type", "") == "basic":
            weights[str(node.id)] = {
                "name": str(node.name or ""),
                "weight": 0.5,
            }
    return weights


def _extract_clarify_json(text: str) -> dict:
    """从 LLM 输出中提取 JSON，兼容 markdown 代码块"""
    if not text:
        return {}
    s = text.strip()
    if s.startswith("```"):
        lines = s.split("\n")
        s = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
    s = s.strip()
    m = re.search(r"\{[\s\S]*\}", s)
    if not m:
        return {}
    try:
        return json.loads(m.group())
    except Exception:
        return {}


def _fallback_clarify_questions(top_event: str, max_q: int) -> dict:
    """LLM 不可用时的兜底模板问题"""
    base = [
        {"id": "Q1", "text": "该故障首次出现的时间？是突然发生还是逐渐加重？",
         "hint": "如：3天前突然出现 / 一周内逐渐加重", "required": True},
        {"id": "Q2", "text": "故障的发生频率和持续时间？",
         "hint": "如：每次启动后持续10秒 / 间歇性，约每5分钟一次", "required": False},
        {"id": "Q3", "text": "在什么工况或环境下会出现该现象？",
         "hint": "如：满负荷运行时 / 仅在低温启动时", "required": False},
        {"id": "Q4", "text": "是否伴随其他异常（报警/振动/温升/异响等）？",
         "hint": "如：同时有温度报警 / 无其他异常", "required": False},
        {"id": "Q5", "text": "已做过哪些初步检查或测量？",
         "hint": "如：测过电压正常 / 检查过润滑无异常", "required": False},
    ]
    return {
        "intro": "为了更精准地定位故障源，请补充以下信息（回答越具体越好）：",
        "questions": base[:max_q],
        "refined_query_hint": f"{top_event}（待用户补充细节）",
    }
