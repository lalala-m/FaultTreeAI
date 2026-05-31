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


# #region debug-point dbg:ai-summary-empty-helpers
def _dbg_event(hypothesis_id: str, msg: str, data: dict | None = None, run_id: str = "pre-fix", trace_id: str = "") -> None:
    try:
        import time as _t
        import urllib.request as _u
        candidates = [".dbg/ai-summary-empty.env", "../.dbg/ai-summary-empty.env", "../../.dbg/ai-summary-empty.env"]
        url = "http://127.0.0.1:7777/event"
        session_id = "ai-summary-empty"
        try:
            c = ""
            for p in candidates:
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        c = f.read()
                    break
                except Exception:
                    continue
            for ln in c.splitlines():
                if ln.startswith("DEBUG_SERVER_URL="):
                    url = ln.split("=", 1)[1].strip() or url
                elif ln.startswith("DEBUG_SESSION_ID="):
                    session_id = ln.split("=", 1)[1].strip() or session_id
        except Exception:
            pass
        payload = {
            "sessionId": session_id,
            "runId": run_id,
            "hypothesisId": str(hypothesis_id or "")[:20],
            "location": "backend/core/knowledge/ai_graph_extractor.py",
            "msg": f"[DEBUG] {msg}"[:400],
            "data": data if isinstance(data, dict) else {},
            "ts": int(_t.time() * 1000),
        }
        if trace_id:
            payload["traceId"] = trace_id
        _u.urlopen(
            _u.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json"}),
            timeout=1.5,
        ).read()
    except Exception:
        return
# #endregion


def _infer_device_from_filename(name: str) -> str:
    n = re.sub(r"\.[^.]+$", "", str(name or "").strip())
    if any(k in n for k in ["新建", "microsoft", "word", "文档"]):
        return "设备"
    m = re.search(r"([\u4e00-\u9fff]{2,20})(维修保养手册|维修手册|保养手册)?", n)
    return (m.group(1) if m else (n or "设备")).strip() or "设备"


def _infer_machine_category(machine: str) -> str:
    v = re.sub(r"\s+", "", str(machine or "")).lower()
    if not v:
        return ""
    return _canonicalize_machine_category("", v) or "通用设备"


def _canonicalize_machine_category(category: str | None, machine: str | None = None) -> str:
    raw_orig = re.sub(r"\s+", "", str(category or "")).strip()
    raw = raw_orig.lower()
    machine_text = re.sub(r"\s+", "", str(machine or "")).lower()
    if raw_orig:
        keep_keys = ["机械", "机床", "机器人", "设备", "泵", "风机", "压缩机", "包装", "清洗", "起重", "试验", "输送", "搅拌"]
        if any(k in raw_orig for k in keep_keys):
            return raw_orig[:60]

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


def _split_causes(text: str) -> list[str]:
    raw = str(text or "").strip()
    if not raw:
        return []
    raw = raw.replace("\r\n", "\n")
    raw = re.sub(r"\s+", " ", raw).strip()
    raw = re.split(r"(?:\s[-*•]\s+.*?\s*→\s+)", raw, maxsplit=1)[0].strip()
    parts = re.split(r"(?:[①②③④⑤⑥⑦⑧⑨⑩]+|\b\d+\s*[\.、])", raw)
    cleaned = []
    for p in parts:
        v = re.sub(r"^[：:\-\s]+", "", str(p or "")).strip()
        if not v:
            continue
        for seg in re.split(r"[；;]\s*", v):
            seg_v = seg.strip()
            if seg_v:
                cleaned.append(seg_v)
    out: list[str] = []
    seen = set()
    for c in cleaned:
        k = c.strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(c.strip())
    return out[:10]


def _extract_structured_template_items(content: str) -> list[dict]:
    text = str(content or "")
    if not text.strip():
        return []
    norm_text = text.replace("\u00a0", " ").replace("\r\n", "\n")
    norm_text = norm_text.replace("->", "→").replace("—>", "→").replace("⇒", "→")
    lines = [ln.rstrip() for ln in norm_text.split("\n")]
    groups: list[list[str]] = []
    current: list[str] = []
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        if re.match(r"^[-*•]\s+", s):
            if current:
                groups.append(current)
            current = [s]
            continue
        if current:
            current.append(s)
    if current:
        groups.append(current)

    if not groups:
        reason_pat = re.compile(r"原因\s*[:：]")
        header_pat2 = re.compile(r"(?:^|[。\n\r])\s*([^\n\r]{0,260}?(?:→[^\n\r]{1,60}){4,}[^\n\r]{0,80})\s*$")
        candidates: list[tuple[int, str]] = []
        for m in list(reason_pat.finditer(norm_text))[:200]:
            rs = int(m.start())
            win_start = max(0, rs - 520)
            win = norm_text[win_start:rs]
            hm_list = list(header_pat2.finditer(win))
            if not hm_list:
                continue
            hm = hm_list[-1]
            hs = win_start + int(hm.start(1))
            header = (hm.group(1) or "").strip()
            if header:
                candidates.append((hs, header))
        candidates.sort(key=lambda x: x[0])
        uniq: list[tuple[int, str]] = []
        for hs, header in candidates:
            if not uniq or hs - uniq[-1][0] > 20:
                uniq.append((hs, header))
        for i, (st, header) in enumerate(uniq[:80]):
            ed = uniq[i + 1][0] if i + 1 < len(uniq) else len(norm_text)
            block = norm_text[st:ed].strip()
            if block:
                groups.append([header, block])

    def _strip_prefix(s: str) -> str:
        v = str(s or "").strip()
        v = re.sub(r"^[\s·•\-\*]+", "", v).strip()
        v = re.sub(r"^\d{1,2}\s*[\.、]\s*", "", v).strip()
        return v

    items: list[dict] = []
    for g in groups:
        header = g[0]
        if "→" not in header and "->" not in header:
            continue
        header_clean = header
        header_clean = _strip_prefix(header_clean)
        header_clean = header_clean.replace("->", "→").replace("—>", "→").replace("⇒", "→")
        header_clean = header_clean.replace("**", "").replace("【", "").replace("】", "")
        header_clean = re.sub(r"\s*→\s*", "→", header_clean).strip()

        chain_part = header_clean
        m_chain = re.search(r"^(.*?)(?:原因[:：].*)?$", header_clean)
        if m_chain:
            chain_part = (m_chain.group(1) or "").strip()
        segments = [seg.strip() for seg in chain_part.split("→") if seg.strip()]
        if len(segments) < 5:
            continue

        pipeline_seg = segments[0]
        machine_category = segments[1]
        machine = segments[2]
        problem_category = segments[3]
        problem = segments[4]

        cause_text = ""
        for ln in g:
            ln2 = ln.replace("**", "")
            m_c = re.search(r"原因[:：]\s*(.*)", ln2)
            if m_c:
                cause_text = (m_c.group(1) or "").strip()
                break
        if not cause_text and len(segments) >= 6:
            cause_text = segments[5]

        causes = _split_causes(cause_text) or ([_clean_phrase(cause_text, 240)] if cause_text else [])
        if not causes:
            causes = ["未明确"]

        for c in causes:
            it = {
                "pipeline": _clean_phrase(pipeline_seg, 64) if pipeline_seg else "",
                "machine_category": _clean_phrase(machine_category, 60) or "",
                "machine": _clean_phrase(machine, 60) or "",
                "problem_category": _clean_phrase(problem_category, 60) or "",
                "problem": _clean_phrase(problem, 80) or "",
                "root_cause": _clean_phrase(c, 160) or "未明确",
                "diagnosis": "",
                "solution": "",
            }
            if not it["problem"] or not _is_useful_problem(it["problem"]):
                continue
            if not it["problem_category"]:
                it["problem_category"] = _infer_problem_category(it["problem"]) or ""
            if not it["machine_category"]:
                it["machine_category"] = _infer_machine_category(it["machine"])
            if not it["machine"]:
                continue
            items.append(it)
            if len(items) >= 120:
                return items
    return items


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


def _is_standard_doc(filename: str, content: str) -> bool:
    f = str(filename or "")
    t = str(content or "")
    head = (f + "\n" + t[:20000]).lower()
    keys = [
        "验收", "检验", "检测", "标准", "规范", "允许偏差", "公差", "判定", "合格", "不合格",
        "gb/", "gbt", "iso", "iec", "试验", "测试", "检定", "等级", "限值", "阈值",
    ]
    return any(k in head for k in keys)


def _extract_standard_rule_items(filename: str, content: str) -> list[dict]:
    text = str(content or "")
    if not text.strip():
        return []
    device = _infer_device_from_filename(filename)
    machine = _clean_phrase(device, 60) or "设备"
    machine_category = _infer_machine_category(machine)
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]
    keep = []
    for ln in lines:
        if len(ln) < 6:
            continue
        if any(k in ln for k in ["目录", "前言", "范围", "术语", "引用文件", "附录", "包装", "运输", "安全"]):
            continue
        if any(k in ln for k in ["应", "不得", "不应", "允许", "符合", "满足", "≥", "≤", ">", "<", "±"]):
            keep.append(ln)
        if len(keep) >= 80:
            break
    items: list[dict] = []
    seen = set()
    for ln in keep:
        short = re.split(r"[：:]", ln, 1)
        check_item = short[0].strip() if short else ln.strip()
        check_item = _clean_phrase(check_item, 60)
        if not check_item or len(check_item) < 4:
            continue
        requirement = _clean_phrase(ln, 200)
        key = (machine.lower(), check_item.lower(), requirement.lower()[:80])
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "machine_category": machine_category,
                "machine": machine,
                "problem_category": "验收",
                "problem": check_item,
                "root_cause": f"合格标准：{requirement}",
                "diagnosis": "",
                "solution": "",
                "standard": {
                    "check_item": check_item,
                    "requirement": requirement,
                    "method": "",
                    "disposition": "",
                },
            }
        )
        if len(items) >= 30:
            break
    return items


async def _extract_standard_items_with_llm(filename: str, content: str) -> tuple[list[dict], str]:
    text = _select_relevant_text(content)
    if not text:
        return [], ""
    device_hint = _infer_device_from_filename(filename)
    prompt = f"""你是工业设备“标准/验收/检测规范”信息抽取专家。

请只从给定文档内容中抽取“验收检查项/判定点 + 合格标准(阈值/限值/允许偏差) + 检测方法(如有) + 不合格处置(如有)”，并整理成结构化知识库条目。

严格输出一个JSON对象，不要输出任何解释文字或代码块：
{{
  "items": [
    {{
      "machine": "机械（设备/部件/型号）",
      "machine_category": "机械类别（如 电机/变频器/PLC/传感器/通用设备）",
      "check_item": "验收/检测检查项（短句）",
      "requirement": "合格标准/阈值/限值/允许偏差（短句）",
      "method": "检测方法/步骤（短句，可空）",
      "disposition": "不合格处置/整改建议（短句，可空）"
    }}
  ]
}}

抽取规则（必须遵守）：
1) 只抽取“标准/验收/检测/判定/合格/不合格/限值/阈值/允许偏差”等内容，不要抽目录/前言/背景
2) machine 优先用文档明确对象；不明确时用文件名推断：{device_hint}
3) check_item 与 requirement 必须有内容；method/disposition 可为空
4) 每条的 check_item<=30字，requirement<=80字，method/disposition<=80字
5) items数量控制在 30 条以内，去重（相同 machine+check_item+requirement 只保留一条）

文档内容：
{text}
"""
    manager = get_llm_manager()
    resp, provider = await manager.generate_with_fallback(prompt)
    parsed = _extract_json_obj(resp.content if resp else "")
    raw_items = parsed.get("items", [])
    if not isinstance(raw_items, list):
        return [], provider
    out: list[dict] = []
    seen = set()
    for it in raw_items[:80]:
        if not isinstance(it, dict):
            continue
        machine = _clean_phrase(it.get("machine") or device_hint, 60) or _clean_phrase(device_hint, 60) or "设备"
        machine_category = _canonicalize_machine_category(_clean_phrase(it.get("machine_category"), 30), machine) or _infer_machine_category(machine)
        check_item = _clean_phrase(it.get("check_item"), 60)
        requirement = _clean_phrase(it.get("requirement"), 140)
        method = _clean_phrase(it.get("method"), 160)
        disposition = _clean_phrase(it.get("disposition"), 160)
        if not check_item or not requirement:
            continue
        if len(check_item) < 4:
            continue
        key = (machine.lower(), check_item.lower(), requirement.lower())
        if key in seen:
            continue
        seen.add(key)
        root_cause = f"合格标准：{requirement}"
        solution_parts = []
        if method:
            solution_parts.append(f"检测方法：{method}")
        if disposition:
            solution_parts.append(f"不合格处置：{disposition}")
        out.append(
            {
                "machine_category": machine_category,
                "machine": machine,
                "problem_category": "验收",
                "problem": check_item[:80],
                "root_cause": root_cause[:200] if root_cause else "未明确",
                "diagnosis": "",
                "solution": "；".join(solution_parts)[:300],
                "standard": {
                    "check_item": check_item[:80],
                    "requirement": requirement[:200],
                    "method": method[:200] if method else "",
                    "disposition": disposition[:200] if disposition else "",
                },
            }
        )
        if len(out) >= 30:
            break
    return out, provider


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
5) 每个条目必须包含 problem；root_cause 若无法从原文明确抽取，请输出空字符串（系统会自动填为“未明确”）
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
        root_cause = _clean_phrase(it.get("root_cause"), 60) or "未明确"
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


async def extract_knowledge_items_with_ai(pipeline: str = "流水线1", doc_ids: list[str] | None = None, replace: bool = False) -> AIExtractResult:
    extracted = 0
    inserted = 0
    errors: list[str] = []
    used_provider = "rule-fallback"
    trace_id = ""
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
                SELECT
                    d.doc_id::text,
                    d.filename,
                    COALESCE(d.metadata->>'original_path','') AS original_path,
                    COALESCE(string_agg(c.text, E'\\n' ORDER BY c.chunk_index), '') AS content
                FROM documents d
                LEFT JOIN document_chunks c ON c.doc_id = d.doc_id
                WHERE d.status='active' AND COALESCE(d.metadata->>'pipeline','流水线1') = %s
                {doc_filter}
                GROUP BY d.doc_id, d.filename, d.metadata
                """,
                tuple(params),
            )
            rows = cur.fetchall() or []
        for doc_id, filename, original_path, content in rows:
            device = _infer_device_from_filename(filename)
            items: list[dict] = []
            provider = "rule-fallback"
            trace_id = str(doc_id)
            _dbg_event("B", "start doc extract", {"doc_id": str(doc_id), "filename": filename, "pipeline_param": pipeline, "replace": bool(replace)}, trace_id=trace_id)
            content_for_extract = content or ""
            raw_docx_text = ""
            if str(filename or "").lower().endswith(".docx") and str(original_path or "").strip():
                try:
                    from pathlib import Path as _P
                    op = str(original_path).strip()
                    if _P(op).exists():
                        from docx import Document as _DocxDocument
                        d = _DocxDocument(op)
                        ps = []
                        for p in d.paragraphs:
                            t = str(p.text or "").strip()
                            if not t:
                                continue
                            if ("→" in t or "->" in t or "⇒" in t or "—>" in t) and not re.match(r"^[-*•]\s+", t):
                                t = "- " + t
                            ps.append(t)
                        raw_docx_text = "\n".join(ps).strip()
                        if raw_docx_text:
                            content_for_extract = raw_docx_text
                except Exception:
                    pass
            if replace:
                try:
                    with conn.cursor() as cur:
                        cur.execute("SELECT COUNT(1) FROM knowledge_items WHERE COALESCE(metadata->>'doc_id','') = %s", (str(doc_id),))
                        before_cnt = int((cur.fetchone() or [0])[0] or 0)
                        cur.execute(
                            """
                            DELETE FROM knowledge_items
                            WHERE COALESCE(metadata->>'doc_id','') = %s
                            """,
                            (str(doc_id),),
                        )
                        conn.commit()
                        _dbg_event("D", "replace delete done", {"doc_id": str(doc_id), "before_count": before_cnt, "deleted": int(cur.rowcount or 0)}, trace_id=trace_id)
                except Exception as e:
                    errors.append(f"{filename}: replace_delete_failed: {str(e)[:200]}")
                    conn.rollback()
                    _dbg_event("D", "replace delete failed", {"doc_id": str(doc_id), "err": str(e)[:200]}, trace_id=trace_id)
            try:
                template_items = _extract_structured_template_items(content_for_extract)
                if template_items:
                    items = template_items
                    provider = "structured-template"
                    _dbg_event("B", "template matched", {"doc_id": str(doc_id), "items": len(items)}, trace_id=trace_id)
                else:
                    if _is_standard_doc(filename, content):
                        _dbg_event("B", "standard doc detected", {"doc_id": str(doc_id)}, trace_id=trace_id)
                        items, provider = await _extract_standard_items_with_llm(filename, content_for_extract)
                        if not items:
                            items = _extract_standard_rule_items(filename, content_for_extract)
                            provider = "standard-rule" if items else provider
                        _dbg_event("B", "standard extract done", {"doc_id": str(doc_id), "provider": provider, "items": len(items)}, trace_id=trace_id)
                    else:
                        _dbg_event("B", "general extract path", {"doc_id": str(doc_id)}, trace_id=trace_id)
                        items, provider = await _extract_items_with_llm(filename, content_for_extract)
                        _dbg_event("B", "general extract done", {"doc_id": str(doc_id), "provider": provider, "items": len(items)}, trace_id=trace_id)
            except Exception as e:
                errors.append(f"{filename}: ai_extract_failed: {str(e)[:200]}")
                items = []
                _dbg_event("D", "ai_extract_failed", {"doc_id": str(doc_id), "err": str(e)[:200]}, trace_id=trace_id)
            if items:
                used_provider = provider or used_provider
                extracted += len(items)
            else:
                pairs = _extract_pairs(content)
                extracted += len(pairs)
                if not pairs:
                    _dbg_event("B", "no items and no pairs", {"doc_id": str(doc_id)}, trace_id=trace_id)
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
                    _dbg_event("B", "begin insert items", {"doc_id": str(doc_id), "count": len(items), "provider": provider}, trace_id=trace_id)
                    inserted_delta = 0
                    skipped_invalid = 0
                    for it in items:
                        pipeline_value = pipeline
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
                            skipped_invalid += 1
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
                                pipeline_value,
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
                                        "source": "structured_template" if provider == "structured-template" else ("ai_extract" if provider != "rule-fallback" else "rule_fallback"),
                                        "provider": provider,
                                        "template_pipeline": str(it.get("pipeline") or "").strip(),
                                        "diagnosis": diagnosis,
                                        "standard": it.get("standard") if isinstance(it.get("standard"), dict) else {},
                                    }
                                ),
                            ),
                        )
                        inserted_delta += 1
                        cur.execute(
                            """
                            INSERT INTO knowledge_item_weights (item_id, helpful_weight, misleading_weight, feedback_count, current_weight)
                            SELECT item_id, 0, 0, 0, 0.5
                            FROM knowledge_items
                            WHERE pipeline = %s AND machine = %s AND problem = %s AND root_cause = %s
                            ON CONFLICT (item_id) DO NOTHING
                            """,
                            (pipeline_value, machine, problem, root_cause),
                        )
                    conn.commit()
                    inserted += inserted_delta
                    _dbg_event(
                        "B",
                        "insert commit ok",
                        {"doc_id": str(doc_id), "inserted_delta": inserted_delta, "skipped_invalid": skipped_invalid, "items_total": len(items)},
                        trace_id=trace_id,
                    )
            except Exception as e:
                errors.append(f"{filename}: {str(e)}")
                conn.rollback()
                _dbg_event("D", "insert failed", {"doc_id": str(doc_id), "err": str(e)[:250]}, trace_id=trace_id)
    skipped = max(0, extracted - inserted)
    return AIExtractResult(extracted=extracted, inserted=inserted, skipped=skipped, provider=used_provider, errors=errors)

