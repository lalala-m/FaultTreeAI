from dataclasses import dataclass
import re
import json
import psycopg2
import psycopg2.extras
from backend.config import settings
from backend.core.llm.manager import get_llm_manager


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


def _infer_machine_category(machine: str) -> str:
    v = re.sub(r"\s+", "", str(machine or "")).lower()
    if not v:
        return ""
    return _canonicalize_machine_category("", v) or "通用设备"


def _canonicalize_machine_category(category: str | None, machine: str | None = None) -> str:
    raw = re.sub(r"\s+", "", str(category or "")).lower()
    machine_text = re.sub(r"\s+", "", str(machine or "")).lower()
    text = raw or machine_text
    if not text:
        return ""

    motor_keys = [
        "伺服电机", "同步电机", "异步电机", "步进电机", "直流电机", "交流电机",
        "减速电机", "力矩电机", "主轴电机", "马达", "motor", "servo", "同步机", "异步机"
    ]
    if any(k in text for k in motor_keys) or ("电机" in text):
        return "电机"

    mapping = [
        ("变频器", ["变频", "inverter"]),
        ("PLC", ["plc"]),
        ("传送带", ["传送带", "输送带"]),
        ("传感器", ["传感器", "sensor"]),
        ("轴承", ["轴承", "bearing"]),
        ("液压", ["液压", "hydraulic"]),
        ("气动", ["气动", "pneumatic"]),
    ]
    for cat, keys in mapping:
        if any(k in text for k in keys):
            return cat
    return "通用设备"


def _infer_problem_category(problem: str) -> str:
    v = re.sub(r"\s+", "", str(problem or "")).lower()
    if not v:
        return ""
    if any(k in v for k in ["短路", "断路", "漏电", "跳闸", "过流", "过压", "欠压", "电源", "接线"]):
        return "电气"
    if any(k in v for k in ["振动", "异响", "磨损", "断裂", "卡滞", "堵塞", "松动", "轴承"]):
        return "机械"
    if any(k in v for k in ["报警", "通讯", "通信", "程序", "参数", "plc", "伺服", "驱动器", "编码器"]):
        return "控制"
    if any(k in v for k in ["液压", "油", "泄漏", "压力", "泵", "阀"]):
        return "液压"
    if any(k in v for k in ["气动", "气压", "气缸", "电磁阀"]):
        return "气动"
    if any(k in v for k in ["传感器", "信号", "误报警"]):
        return "传感器"
    return ""


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


def _select_relevant_text(content: str, limit_chars: int = 12000) -> str:
    text = str(content or "")
    if not text.strip():
        return ""
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n")]
    keep: list[str] = []
    keywords = ["故障", "现象", "原因", "判断", "检测", "排查", "处理", "维修", "报警", "异常", "解决"]
    for ln in lines:
        if not ln:
            continue
        if any(k in ln for k in keywords):
            keep.append(ln)
    if not keep:
        keep = [ln for ln in lines if ln][:600]
    joined = "\n".join(keep)
    return joined[:limit_chars]


def _extract_json_obj(text: str) -> dict:
    raw = (text or "").strip()
    if raw.startswith("```"):
        parts = raw.split("\n")
        raw = "\n".join(parts[1:-1]) if parts[-1].strip() == "```" else "\n".join(parts[1:])
        raw = raw.strip()
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        raise ValueError("LLM输出中未找到JSON对象")
    return json.loads(m.group(0))


def _clean_phrase(s: str, max_len: int) -> str:
    v = re.sub(r"[\r\n\t]+", " ", str(s or "")).strip()
    v = re.sub(r"\s+", " ", v).strip()
    v = re.sub(r"[^\u4e00-\u9fff0-9a-zA-Z ]+", "", v).strip()
    v = re.sub(r"\s+", " ", v).strip()
    if len(v) > max_len:
        v = v[:max_len].strip()
    return v


def _is_useful_problem(problem: str) -> bool:
    v = str(problem or "").strip()
    if len(v) < 4:
        return False
    noise = ["注意", "说明", "提示", "步骤", "工具", "安全", "包装", "运输", "保养", "维护周期", "参数", "目录"]
    if any(n in v for n in noise):
        return False
    if re.fullmatch(r"[-–—_ ]+", v):
        return False
    return True


async def _extract_items_with_llm(filename: str, content: str) -> tuple[list[dict], str]:
    text = _select_relevant_text(content)
    if not text:
        return [], ""
    device_hint = _infer_device_from_filename(filename)
    prompt = f"""你是工业设备维修手册信息抽取专家。

请只从给定手册内容中抽取“机械信息 + 故障现象 + 判断方法 + 导致原因 + 处理建议”，并整理成结构化知识库条目。

严格输出一个JSON对象，不要输出任何解释文字或代码块：
{{
  "items": [
    {{
      "machine_category": "机械类别（如 伺服/变频器/PLC/电机/传感器/气动/液压/通用设备）",
      "machine": "机械（设备/型号）",
      "problem_category": "问题类别（如 电气/机械/控制/液压/气动/传感器）",
      "problem": "故障现象（短句，<=30字，不要序号/特殊符号）",
      "diagnosis": "判断方法（动作短句，<=80字，可用分号分隔）",
      "root_cause": "导致原因（短句，<=40字）",
      "solution": "处理建议（动作短句，<=80字，可用分号分隔）"
    }}
  ]
}}

抽取规则（必须遵守）：
1) 只抽取明确属于“故障/异常/报警/失效/无法/跳闸/过热/异响/堵塞/磨损/卡滞”等现象的条目
2) 机械(machine)优先用手册明确的设备名/型号；若不明确，使用文件名推断：{device_hint}
3) 过滤无用信息：安全提示、目录、参数表、工具清单、泛化描述（如“检查电源”但没有对应故障现象）不要输出
4) machine_category/problem_category若手册没有，基于 machine/problem 内容合理推断；不要留空
5) 每个条目必须同时包含 problem 与 root_cause；diagnosis/solution 可为空字符串
6) items数量控制在 30 条以内，去重（相同 machine+problem+root_cause 只保留一条）

维修手册内容：
{text}
"""
    manager = get_llm_manager()
    resp, provider = await manager.generate_with_fallback(prompt)
    parsed = _extract_json_obj(resp.content if resp else "")
    items = parsed.get("items", [])
    if not isinstance(items, list):
        return [], provider
    out = []
    seen = set()
    for it in items[:60]:
        if not isinstance(it, dict):
            continue
        machine = _clean_phrase(it.get("machine") or device_hint, 60) or _clean_phrase(device_hint, 60) or "设备"
        machine_category = _canonicalize_machine_category(_clean_phrase(it.get("machine_category"), 30), machine) or _infer_machine_category(machine)
        problem = _clean_phrase(it.get("problem"), 40)
        if not _is_useful_problem(problem):
            continue
        root_cause = _clean_phrase(it.get("root_cause"), 60)
        if len(root_cause) < 2:
            continue
        problem_category = _clean_phrase(it.get("problem_category") or _infer_problem_category(problem), 30) or _infer_problem_category(problem)
        diagnosis = _clean_phrase(it.get("diagnosis"), 120)
        solution = _clean_phrase(it.get("solution"), 140)
        key = (_clean_phrase(machine, 80).lower(), problem.lower(), root_cause.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "machine_category": machine_category,
                "machine": machine,
                "problem_category": problem_category,
                "problem": problem,
                "root_cause": root_cause,
                "diagnosis": diagnosis,
                "solution": solution,
            }
        )
        if len(out) >= 30:
            break
    return out, provider


def _ensure_items_table(conn):
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
            WITH ranked AS (
                SELECT
                    ctid,
                    row_number() OVER (
                        PARTITION BY pipeline, machine, problem, root_cause
                        ORDER BY updated_at DESC, created_at DESC
                    ) AS rn
                FROM knowledge_items
            )
            DELETE FROM knowledge_items k
            USING ranked r
            WHERE k.ctid = r.ctid
              AND r.rn > 1
            """
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_items_unique
            ON knowledge_items (pipeline, machine, problem, root_cause)
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
                expert_weight DOUBLE PRECISION,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute("ALTER TABLE knowledge_item_weights ADD COLUMN IF NOT EXISTS expert_weight DOUBLE PRECISION")
        conn.commit()


async def extract_knowledge_items_with_ai(pipeline: str = "流水线1", doc_ids: list[str] | None = None) -> AIExtractResult:
    extracted = 0
    inserted = 0
    errors: list[str] = []
    used_provider = "rule-fallback"
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
            items: list[dict] = []
            provider = "rule-fallback"
            try:
                items, provider = await _extract_items_with_llm(filename, content)
            except Exception as e:
                errors.append(f"{filename}: ai_extract_failed: {str(e)[:200]}")
                items = []
            if items:
                used_provider = provider or used_provider
                extracted += len(items)
            else:
                pairs = _extract_pairs(content)
                extracted += len(pairs)
                if not pairs:
                    continue
                items = []
                for fault, sol in pairs:
                    items.append(
                        {
                            "machine_category": _infer_machine_category(device),
                            "machine": device,
                            "problem_category": _infer_problem_category(fault),
                            "problem": _clean_phrase(fault, 40),
                            "root_cause": "未明确",
                            "diagnosis": "",
                            "solution": _clean_phrase(sol, 140),
                        }
                    )
            try:
                with conn.cursor() as cur:
                    for it in items:
                        machine = str(it.get("machine") or device).strip() or device
                        machine_category = _canonicalize_machine_category(it.get("machine_category"), machine) or _infer_machine_category(machine)
                        problem_category = str(it.get("problem_category") or _infer_problem_category(it.get("problem"))).strip()
                        problem = str(it.get("problem") or "").strip()
                        root_cause = str(it.get("root_cause") or "").strip() or "未明确"
                        diagnosis = str(it.get("diagnosis") or "").strip()
                        solution = str(it.get("solution") or "").strip()
                        if diagnosis and solution:
                            solution_value = f"判断方法：{diagnosis}；处理建议：{solution}"
                        elif diagnosis:
                            solution_value = f"判断方法：{diagnosis}"
                        else:
                            solution_value = solution
                        if not problem:
                            continue
                        cur.execute(
                            """
                            INSERT INTO knowledge_items (pipeline, machine_category, machine, problem_category, problem, root_cause, solution, metadata, status)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'active')
                            ON CONFLICT (pipeline, machine, problem, root_cause) DO UPDATE
                            SET solution = EXCLUDED.solution,
                                metadata = EXCLUDED.metadata,
                                updated_at = NOW()
                            """,
                            (
                                pipeline,
                                machine_category,
                                machine,
                                problem_category,
                                problem,
                                root_cause,
                                solution_value,
                                psycopg2.extras.Json(
                                    {
                                        "doc_id": doc_id,
                                        "filename": filename,
                                        "source": "ai_extract" if provider != "rule-fallback" else "rule_fallback",
                                        "provider": provider,
                                        "diagnosis": diagnosis,
                                    }
                                ),
                            ),
                        )
                        cur.execute(
                            """
                            INSERT INTO knowledge_item_weights (item_id, helpful_weight, misleading_weight, feedback_count, current_weight)
                            SELECT item_id, 0, 0, 0, 0.5
                            FROM knowledge_items
                            WHERE pipeline = %s AND machine = %s AND problem = %s AND root_cause = %s
                            ON CONFLICT (item_id) DO NOTHING
                            """,
                            (pipeline, machine, problem, root_cause),
                        )
                    conn.commit()
                    inserted += len(items)
            except Exception as e:
                errors.append(f"{filename}: {str(e)}")
                conn.rollback()
    skipped = max(0, extracted - inserted)
    return AIExtractResult(extracted=extracted, inserted=inserted, skipped=skipped, provider=used_provider, errors=errors)

