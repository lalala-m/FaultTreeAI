from dataclasses import dataclass
import re
import psycopg2
import psycopg2.extras
from backend.config import settings


@dataclass
class AIExtractResult:
    extracted: int
    inserted: int
    skipped: int
    provider: str
    errors: list[str]


def _infer_device_from_filename(name: str) -> str:
    n = re.sub(r"\.[^.]+$", "", str(name or "").strip())
    m = re.search(r"([\u4e00-\u9fff]{2,20})(维修保养手册|维修手册|保养手册)?", n)
    return (m.group(1) if m else (n or "设备")).strip() or "设备"


def _extract_pairs(text: str) -> list[tuple[str, str]]:
    raw = str(text or "")
    if not raw.strip():
        return []
    lines = [ln.strip() for ln in raw.replace("\r\n", "\n").split("\n") if ln.strip()]
    raw = "\n".join(lines)
    known = ["无法开机", "吸力减弱", "异常噪音", "充电故障", "无法启动", "不启动", "无法充电", "充不进电"]
    action_keys = ["检查", "更换", "清理", "清洁", "调整", "润滑", "复位", "重启", "测试", "处理", "排查", "连接", "按压", "检测", "冲洗", "清空", "取出", "滴加", "冷却"]
    pairs: list[tuple[str, str]] = []
    for i, ln in enumerate(lines):
        if ln not in known and not any(k in ln for k in ["故障", "异常", "报警", "失效", "过热", "异响", "堵塞", "磨损", "卡滞", "短路", "断路", "跳闸", "停机"]):
            continue
        fault = ln[:80]
        for nxt in lines[i + 1: i + 25]:
            if nxt in known:
                break
            if any(k in nxt for k in action_keys):
                parts = [p.strip() for p in re.split(r"\d+[\.、]\s*", nxt) if p.strip()]
                for p in parts:
                    if any(k in p for k in action_keys):
                        pairs.append((fault, p[:160]))
            if len(pairs) >= 80:
                break
    uniq = []
    seen = set()
    for f, s in pairs:
        k = (f, s)
        if k in seen:
            continue
        seen.add(k)
        uniq.append((f, s))
    return uniq[:120]


def _ensure_items_table(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS knowledge_items (
                item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                pipeline VARCHAR(64) NOT NULL DEFAULT '流水线1',
                machine_category VARCHAR(64) NOT NULL DEFAULT '设备',
                machine VARCHAR(120) NOT NULL,
                problem_category VARCHAR(64) NOT NULL DEFAULT '故障排查',
                problem VARCHAR(200) NOT NULL,
                root_cause VARCHAR(300) NOT NULL,
                solution TEXT NOT NULL DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(16) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_items_unique
            ON knowledge_items (pipeline, machine, problem, root_cause)
            """
        )
        conn.commit()


async def extract_knowledge_items_with_ai(pipeline: str = "流水线1", doc_ids: list[str] | None = None) -> AIExtractResult:
    extracted = 0
    inserted = 0
    errors: list[str] = []
    with psycopg2.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        user=settings.DB_USER,
        password=settings.DB_PASSWORD,
        database=settings.DB_NAME,
    ) as conn:
        _ensure_items_table(conn)
        with conn.cursor() as cur:
            params = [pipeline]
            doc_filter = ""
            if doc_ids:
                doc_filter = " AND d.doc_id = ANY(%s::uuid[]) "
                params.append(doc_ids)
            cur.execute(
                f"""
                SELECT d.doc_id::text, d.filename, COALESCE(string_agg(c.text, E'\\n' ORDER BY c.chunk_index), '')
                FROM documents d
                LEFT JOIN document_chunks c ON c.doc_id = d.doc_id
                WHERE d.status='active' AND COALESCE(d.metadata->>'pipeline','流水线1') = %s
                {doc_filter}
                GROUP BY d.doc_id, d.filename
                """,
                tuple(params),
            )
            rows = cur.fetchall() or []
        for doc_id, filename, content in rows:
            device = _infer_device_from_filename(filename)
            pairs = _extract_pairs(content)
            extracted += len(pairs)
            if not pairs:
                continue
            try:
                with conn.cursor() as cur:
                    for fault, solution in pairs:
                        cur.execute(
                            """
                            INSERT INTO knowledge_items (pipeline, machine_category, machine, problem_category, problem, root_cause, solution, metadata, status)
                            VALUES (%s, '设备', %s, '故障排查', %s, %s, %s, %s, 'active')
                            ON CONFLICT (pipeline, machine, problem, root_cause) DO UPDATE
                            SET solution = EXCLUDED.solution,
                                metadata = EXCLUDED.metadata,
                                updated_at = NOW()
                            """,
                            (
                                pipeline,
                                device,
                                fault,
                                solution,
                                solution,
                                psycopg2.extras.Json({"doc_id": doc_id, "filename": filename, "source": "rule_fallback"}),
                            ),
                        )
                    conn.commit()
                    inserted += len(pairs)
            except Exception as e:
                errors.append(f"{filename}: {str(e)}")
                conn.rollback()
    skipped = max(0, extracted - inserted)
    return AIExtractResult(extracted=extracted, inserted=inserted, skipped=skipped, provider="rule-fallback", errors=errors)

