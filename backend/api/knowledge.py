"""
知识管理 API — PostgreSQL 持久化
支持文档上传、列表查询、删除、搜索
"""

import uuid
import tiktoken
import re
import json
from collections import Counter
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Form
import aiofiles

from backend.core.parser.document import parse_document
from backend.core.rag.pgvector_retriever import add_chunks_to_db, retrieve
from backend.core.llm.manager import get_llm_manager
from backend.models.schemas import UploadResponse
from backend.config import settings
import psycopg2, psycopg2.extras

router = APIRouter(tags=["知识管理"])
DEVICE_TERMS = [
    "手持式无线吸尘器", "无线吸尘器", "吸尘器",
    "电饭煲", "传送带", "输送带",
    "电机", "液压泵", "泵", "阀门", "传感器", "轴承", "PLC", "变频器",
    "液压缸", "输送带", "风机", "压缩机", "电池", "继电器", "接触器",
    "控制器", "电源", "减速机", "编码器", "过滤器"
]
CANONICAL_DEVICE_ALIASES = [
    ("吸尘器", ["手持式无线吸尘器", "无线吸尘器", "吸尘器"]),
    ("电饭煲", ["电饭煲", "电饭锅"]),
    ("传送带", ["传送带", "输送带"]),
]
FAULT_HINTS = [
    "故障", "异常", "报警", "失效", "损坏", "泄漏", "过热", "振动", "异响",
    "堵塞", "磨损", "卡滞", "偏差", "无法启动", "不启动", "无压力", "压力不足",
    "温度过高", "短路", "断路", "跳闸", "停机"
]
SOLUTION_HINTS = [
    "检查", "更换", "清理", "维修", "修复", "调整", "校准", "紧固",
    "润滑", "复位", "重启", "测试", "确认", "处理", "排查",
    "连接", "按压", "激活", "检测", "冲洗", "清空", "取出", "滴加", "清洁", "冷却", "待",
    "拆卸", "测量", "插拔", "更换", "送修", "购买", "装回"
]
COMMON_FAULT_TITLES = [
    "无法开机", "吸力减弱", "异常噪音", "充电故障",
    "无法启动", "不启动", "无法充电", "充不进电",
    "过热报警", "异响", "无压力", "压力不足"
]
NOISE_TERMS = {
    "常见故障排查表", "技术参数", "定期保养计划", "安全须知", "产品结构图示", "分步维修指南",
    "每日", "每周", "每月", "每半年", "每年", "额定电压", "空载转速", "最大真空度",
    "电池容量", "工作噪音", "注意事项", "维修查询热线", "更新日期", "可能原因", "解决方法",
    "故障现象", "本手册", "标准化模板", "官方完整手册", "维修保养手册", "常见故障",
    "故障诊断", "电路图", "流程图", "目录"
}


def _normalize_pipeline(pipeline: str | None) -> str:
    p = (pipeline or "").strip()
    if not p:
        return "流水线1"
    if len(p) > 64:
        raise HTTPException(status_code=400, detail="流水线名称过长（最多64字符）")
    return p


def _extract_terms_from_text(text: str, top_k: int = 5) -> list[str]:
    # 仅抽取中文术语，避免知识图谱出现英文节点
    tokens = re.findall(r"[\u4e00-\u9fff]{2,}", text or "")
    stop = {
        "系统", "设备", "故障", "可以", "以及", "进行", "用于", "这个", "那个",
        "相关", "通过", "对于", "其中", "需要", "包括", "检查", "操作", "手册"
    }
    cleaned = [t for t in tokens if t not in stop]
    if not cleaned:
        return []
    return [w for w, _ in Counter(cleaned).most_common(top_k)]


def _short_text(s: str, max_len: int = 22) -> str:
    s = re.sub(r"\s+", "", s or "")
    return s if len(s) <= max_len else s[:max_len] + "…"


def _norm_text(s: str) -> str:
    return re.sub(r"[\s，。,.、；;：:【】\[\]()（）\-—_]+", "", (s or "").strip().lower())


def _is_noise_phrase(s: str) -> bool:
    t = _norm_text(s)
    if not t:
        return True
    if t.isdigit():
        return True
    if "手册" in t or "目录" in t:
        return True
    if any(_norm_text(x) in t for x in NOISE_TERMS):
        return True
    return False


def _clean_fault_name(s: str) -> str:
    v = _short_text(s, 26)
    if _is_noise_phrase(v):
        return ""
    return v


def _clean_solution(s: str) -> str:
    v = _short_text(s, 36)
    if _is_noise_phrase(v):
        return ""
    if not any(k in v for k in SOLUTION_HINTS):
        return ""
    return v


def _canonicalize_device_name(name: str) -> str:
    raw = str(name or "").strip()
    if not raw:
        return ""
    compact = re.sub(r"\s+", "", raw)
    for canonical, aliases in CANONICAL_DEVICE_ALIASES:
        if any(alias in compact for alias in aliases):
            return canonical
    return _short_text(compact, 24)


def _is_generic_fault_phrase(s: str) -> bool:
    raw = str(s or "").strip()
    t = _norm_text(raw)
    if not t:
        return True
    generic_exact = {
        "故障", "设备故障", "设备异常", "系统故障", "系统异常",
        "电饭煲故障", "吸尘器故障", "传送带故障", "输送带故障",
        "电饭煲异常", "吸尘器异常", "传送带异常", "输送带异常",
    }
    if t in {_norm_text(x) for x in generic_exact}:
        return True
    if re.fullmatch(r"故障[0-9一二三四五六七八九十]+", raw):
        return True
    if re.fullmatch(r"[0-9一二三四五六七八九十]+", raw):
        return True
    canonical_devices = {c for c, _aliases in CANONICAL_DEVICE_ALIASES}
    for dev in canonical_devices:
        dn = _norm_text(dev)
        if t in {dn, dn + "故障", dn + "异常"}:
            return True
    return False


def _is_valid_fault_phrase(s: str) -> bool:
    raw = str(s or "").strip()
    t = _norm_text(raw)
    if not t:
        return False
    if _is_generic_fault_phrase(raw):
        return False
    if len(raw) < 2 or len(raw) > 30:
        return False
    if any(x in raw for x in ["手册", "目录", "图示", "步骤", "注意事项", "热线", "更新日期"]):
        return False
    if any(x in raw for x in ["若", "如果", "则", "需要", "应当", "建议", "请", "确认"]):
        return False
    if any(k in raw for k in SOLUTION_HINTS):
        return False
    if "，" in raw or "," in raw or "。" in raw:
        return False
    if any(x in t for x in ["排查表", "技术参数", "保养计划", "维修指南", "查询热线", "更新日期"]):
        return False
    if any(x in t for x in ["每日", "每周", "每月", "每半年", "每年"]):
        return False
    allowed_short = set(COMMON_FAULT_TITLES)
    symptom_patterns = [
        r"无法|不能|不通电|无反应|不加热|不熟|煮糊|溢出|失灵|错误代码|吸力减弱|异常噪音|充电故障|无法开机|不启动|无法充电|充不进电"
    ]
    if any(x in s for x in FAULT_HINTS) or s in allowed_short:
        return True
    if any(re.search(p, raw) for p in symptom_patterns):
        return True
    return False


def _extract_graph_from_content(content: str, main_device: str | None = None) -> dict:
    sentences = [x.strip() for x in re.split(r"[。！？；;\n]+", content or "") if x.strip()]
    graph = {}
    for sent in sentences:
        has_fault = any(k in sent for k in FAULT_HINTS)
        has_solution = any(k in sent for k in SOLUTION_HINTS)
        devices = [d for d in DEVICE_TERMS if d in sent]
        if main_device and (has_fault or has_solution):
            devices = [main_device]
        if not devices:
            continue
        fault_name = _short_text(sent)
        for dev in devices:
            graph.setdefault(dev, {"faults": {}})
            if has_fault:
                graph[dev]["faults"].setdefault(fault_name, {"solutions": []})
            if has_solution:
                target_fault = fault_name if has_fault else (next(iter(graph[dev]["faults"]), None))
                if target_fault:
                    sol = _short_text(sent, 28)
                    if sol not in graph[dev]["faults"][target_fault]["solutions"]:
                        graph[dev]["faults"][target_fault]["solutions"].append(sol)
    return graph


def _extract_json_dict(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[-1].strip().startswith("```"):
            text = "\n".join(lines[1:-1]).strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        raise ValueError("AI 输出中未找到 JSON")
    return json.loads(m.group())


def _sanitize_kg_payload(data: dict) -> dict:
    devices = data.get("devices", []) if isinstance(data, dict) else []
    cleaned_devices = []
    for dev in devices:
        name = _canonicalize_device_name(str((dev or {}).get("name", "")).strip())
        if not name or _is_noise_phrase(name):
            continue
        faults = []
        fault_seen = set()
        for f in (dev or {}).get("faults", []) or []:
            fname = _clean_fault_name(str((f or {}).get("name", "")).strip())
            if not fname:
                continue
            if not _is_valid_fault_phrase(fname):
                continue
            sols = []
            sol_seen = set()
            for s in (f or {}).get("solutions", []) or []:
                sv = _clean_solution(str(s).strip())
                nk = _norm_text(sv)
                if sv and nk not in sol_seen:
                    sols.append(sv)
                    sol_seen.add(nk)
            if not sols:
                continue
            fk = _norm_text(fname)
            if fk in fault_seen:
                continue
            fault_seen.add(fk)
            if any(_norm_text(x) in fk for x in NOISE_TERMS):
                continue
            faults.append({"name": fname, "solutions": sols[:6]})
        if faults:
            cleaned_devices.append({"name": name, "faults": faults[:10]})
    return {"devices": cleaned_devices[:30]}


def _has_useful_kg(kg: dict) -> bool:
    devices = (kg or {}).get("devices", []) if isinstance(kg, dict) else []
    for d in devices:
        for f in (d or {}).get("faults", []) or []:
            sols = (f or {}).get("solutions", []) or []
            if str((f or {}).get("name", "")).strip() and len(sols) > 0:
                return True
    return False


def _infer_main_device(content: str) -> str:
    text = content or ""
    m = re.search(r"([\u4e00-\u9fff]{2,20})(?:维修保养手册|维修手册|保养手册)", text)
    if m:
        return _canonicalize_device_name(m.group(1))
    for d in sorted(DEVICE_TERMS, key=len, reverse=True):
        if d in text:
            return _canonicalize_device_name(d)
    return "设备"


def _pick_reliable_main_device(base: dict, content: str, title_hint: str = "") -> str:
    inferred = _infer_main_device((title_hint or "") + "\n" + (content or "")[:2000])
    if inferred and inferred != "设备":
        return inferred
    text = (content or "")[:6000]
    vacuum_score = sum(1 for kw in ["吸力", "集尘", "滤网", "刷头", "吸管", "充电器", "电池电量", "风道"] if kw in text)
    rice_score = sum(1 for kw in ["电饭煲", "加热盘", "内锅", "煮饭", "磁钢", "限温器", "内胆", "上盖"] if kw in text)
    if vacuum_score >= 2 and vacuum_score > rice_score:
        return "吸尘器"
    if rice_score >= 2 and rice_score > vacuum_score:
        return "电饭煲"
    best_name = ""
    best_fault_count = 0
    for d in (base or {}).get("devices", []) or []:
        name = _canonicalize_device_name(str((d or {}).get("name", "")).strip())
        if not name or name == "设备":
            continue
        fault_count = len((d or {}).get("faults", []) or [])
        if fault_count > best_fault_count:
            best_name = name
            best_fault_count = fault_count
    return best_name


def _extract_numbered_fault_blocks(content: str, limit: int = 12) -> list[dict]:
    text = content or ""
    pattern = re.compile(r"故障\s*[0-9一二三四五六七八九十]+\s*[：:]\s*([^\n]{2,48})")
    matches = list(pattern.finditer(text))
    if not matches:
        return []
    pairs = []
    for i, m in enumerate(matches):
        fault_raw = m.group(1).strip()
        fault_raw = re.split(r"[（(]", fault_raw)[0].strip() or fault_raw
        fault_name = _clean_fault_name(fault_raw)
        if not fault_name or not _is_valid_fault_phrase(fault_name):
            continue
        st = m.end()
        ed = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[st:ed]
        step_match = re.search(r"(维修步骤|解决方法|处理步骤)\s*[：:]([\s\S]*)", block)
        seg = step_match.group(2) if step_match else block
        lines = []
        for ln in re.split(r"[\n\r]+", seg):
            for part in re.split(r"[；;。]", ln):
                p = re.sub(r"^[\s·\-•\d\.\、]+\s*", "", part.strip())
                if p:
                    lines.append(p)
        solutions = []
        seen = set()
        for ln in lines:
            sv = _clean_solution(ln)
            if not sv:
                continue
            nk = _norm_text(sv)
            if nk in seen:
                continue
            seen.add(nk)
            solutions.append(sv)
            if len(solutions) >= 6:
                break
        if solutions:
            pairs.append({"name": fault_name, "solutions": solutions})
        if len(pairs) >= limit:
            break
    return pairs


def _constrain_kg_to_main_device(kg: dict, content: str, title_hint: str = "") -> dict:
    base = _sanitize_kg_payload(kg or {})
    if not isinstance(base, dict):
        return {"devices": []}
    main_dev = _pick_reliable_main_device(base, content, title_hint)
    if not main_dev:
        return base
    all_faults = []
    seen_fault = set()
    for d in base.get("devices", []) or []:
        for f in (d or {}).get("faults", []) or []:
            fname = _clean_fault_name(str((f or {}).get("name", "")).strip())
            if not fname or not _is_valid_fault_phrase(fname):
                continue
            fk = _norm_text(fname)
            if fk in seen_fault:
                continue
            sols = []
            seen_sol = set()
            for s in (f or {}).get("solutions", []) or []:
                sv = _clean_solution(str(s).strip())
                nk = _norm_text(sv)
                if sv and nk not in seen_sol:
                    sols.append(sv)
                    seen_sol.add(nk)
            if not sols:
                continue
            all_faults.append({"name": fname, "solutions": sols[:6]})
            seen_fault.add(fk)
    if not all_faults:
        return {"devices": []}
    return {"devices": [{"name": main_dev, "faults": all_faults[:12]}]}


def _extract_fault_solution_pairs_from_content(content: str, limit: int = 10) -> list[dict]:
    lines = [re.sub(r"^[\s·\-•\d\.\、]+", "", x.strip()) for x in (content or "").splitlines()]
    lines = [x for x in lines if x]
    pairs = []
    i = 0
    while i < len(lines):
        line = lines[i]
        is_fault = (2 <= len(line) <= 16) and (
            any(k in line for k in FAULT_HINTS) or line in {"无法开机", "吸力减弱", "异常噪音", "充电故障"}
        )
        if not is_fault:
            i += 1
            continue
        fault = _short_text(line, 24)
        sols = []
        j = i + 1
        while j < len(lines):
            nxt = lines[j]
            next_is_fault = (2 <= len(nxt) <= 16) and (
                any(k in nxt for k in FAULT_HINTS) or nxt in {"无法开机", "吸力减弱", "异常噪音", "充电故障"}
            )
            if next_is_fault:
                break
            if any(k in nxt for k in SOLUTION_HINTS):
                sols.append(_short_text(nxt, 32))
            j += 1
        if sols:
            pairs.append({"name": fault, "solutions": list(dict.fromkeys(sols))[:6]})
        i = j
        if len(pairs) >= limit:
            break
    return pairs


def _extract_fault_solution_by_position(content: str, limit: int = 12) -> list[dict]:
    text = re.sub(r"\s+", " ", content or "")
    if not text:
        return []

    exact_hits = []
    for t in COMMON_FAULT_TITLES:
        for m in re.finditer(re.escape(t), text):
            exact_hits.append((m.start(), m.end(), t))

    hits = []
    if len(exact_hits) >= 2:
        hits = exact_hits
    else:
        hits.extend(exact_hits)
        for m in re.finditer(r"[\u4e00-\u9fff]{2,12}(?:故障|异常|报警|失效|过热|异响|堵塞|磨损|卡滞|短路|断路|跳闸|停机)", text):
            hits.append((m.start(), m.end(), m.group(0)))
    if not hits:
        return []

    hits.sort(key=lambda x: x[0])
    merged = []
    seen = set()
    for st, ed, name in hits:
        k = (st // 2, _norm_text(name))
        if k in seen:
            continue
        seen.add(k)
        merged.append((st, ed, _clean_fault_name(name)))
    merged = [(a, b, c) for (a, b, c) in merged if c and _is_valid_fault_phrase(c)]
    if not merged:
        return []

    pairs = []
    for i, (st, _ed, fault) in enumerate(merged):
        right = merged[i + 1][0] if i + 1 < len(merged) else len(text)
        seg = text[st:right]
        sols = []
        for m in re.finditer(rf"[^。；\n]{{0,18}}(?:{'|'.join(SOLUTION_HINTS)})[^。；\n]{{0,30}}", seg):
            sv = _clean_solution(m.group(0))
            if sv:
                nk = _norm_text(sv)
                if nk not in {_norm_text(x) for x in sols}:
                    sols.append(sv)
        if not sols:
            for m in re.finditer(r"\d+[\.、]\s*([^。；\n]{4,40})", seg):
                sv = _clean_solution(m.group(1))
                if sv:
                    nk = _norm_text(sv)
                    if nk not in {_norm_text(x) for x in sols}:
                        sols.append(sv)
        if sols:
            pairs.append({"name": fault, "solutions": sols[:6]})
        if len(pairs) >= limit:
            break
    return pairs

def _parse_table_kg(content: str, limit_faults: int = 12) -> dict:
    text = (content or "").replace("\t", " ").replace("｜", "|")
    pattern = re.compile(r"(?P<f>[^|\n]{2,30})\s*\|\s*(?P<r>[^|\n]{1,200})\s*\|\s*(?P<s>[^|\n]{2,240})")
    rows = []
    for m in pattern.finditer(text):
        f = m.group("f").strip()
        r = m.group("r").strip()
        s = m.group("s").strip()
        h = (f + r + s).replace(" ", "")
        if "故障现象" in h and "解决方法" in h:
            continue
        if not f or not s:
            continue
        rows.append((f, s))
        if len(rows) >= limit_faults * 2:
            break
    if not rows:
        # 回退到逐行方式
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        for ln in lines:
            segs = [s.strip() for s in re.split(r"\s*\|\s*", ln) if s.strip()]
            if len(segs) >= 3:
                f, s = segs[0], segs[-1]
                h = (segs[0] + "".join(segs[1:])).replace(" ", "")
                if "故障现象" in h and "解决方法" in h:
                    continue
                rows.append((f, s))
            if len(rows) >= limit_faults * 2:
                break
        if not rows:
            return {"devices": []}
    def clean_num_prefix(s: str) -> str:
        return re.sub(r"^\d+[\.、]\s*", "", s.strip())
    pairs = []
    seen_fault = set()
    for f, s in rows:
        f1 = clean_num_prefix(f)
        f1 = _clean_fault_name(f1)
        if not f1 or not _is_valid_fault_phrase(f1):
            continue
        fk = _norm_text(f1)
        if fk in seen_fault:
            continue
        sols = []
        for part in re.split(r"[；;。]|(?<=\))\s*", s):
            for seg in re.split(r"\d+[\.、]\s*", part):
                sv = _clean_solution(seg)
                if sv:
                    nk = _norm_text(sv)
                    if nk not in {_norm_text(x) for x in sols}:
                        sols.append(sv)
        if not sols:
            continue
        pairs.append({"name": f1, "solutions": sols[:6]})
        seen_fault.add(fk)
        if len(pairs) >= limit_faults:
            break
    if not pairs:
        return {"devices": []}
    dev = _infer_main_device(content)
    return {"devices": [{"name": dev, "faults": pairs}]}


def _extract_table_pairs_from_content(content: str, limit: int = 12) -> list[dict]:
    raw = content or ""
    start = 0
    m_start = re.search(r"(常见故障排查表|故障排查表)", raw)
    if m_start:
        start = m_start.start()
    end = len(raw)
    m_end = re.search(r"(分步维修指南|定期保养计划|技术参数|注意事项)", raw[start:])
    if m_end:
        end = start + m_end.start()
    focus = raw[start:end]

    lines = [re.sub(r"^[\s·\-•\d\.\、]+", "", x.strip()) for x in focus.splitlines()]
    lines = [x for x in lines if x]
    pairs = []
    i = 0
    while i < len(lines):
        line = lines[i]
        fault = _clean_fault_name(line)
        is_fault = bool(fault) and (2 <= len(fault) <= 16) and (
            any(k in fault for k in FAULT_HINTS) or fault in {"无法开机", "吸力减弱", "异常噪音", "充电故障"}
        )
        if is_fault and not _is_valid_fault_phrase(fault):
            is_fault = False
        if not is_fault:
            i += 1
            continue
        j = i + 1
        solutions = []
        while j < len(lines):
            nxt = lines[j]
            nxt_fault = _clean_fault_name(nxt)
            next_is_fault = bool(nxt_fault) and (2 <= len(nxt_fault) <= 16) and (
                any(k in nxt_fault for k in FAULT_HINTS) or nxt_fault in {"无法开机", "吸力减弱", "异常噪音", "充电故障"}
            )
            if next_is_fault:
                break
            sv = _clean_solution(nxt)
            if sv:
                key = _norm_text(sv)
                if key not in {_norm_text(x) for x in solutions}:
                    solutions.append(sv)
            j += 1
        if solutions:
            pairs.append({"name": fault, "solutions": solutions[:6]})
        i = j
        if len(pairs) >= limit:
            break
    return pairs


def _build_fallback_kg(content: str) -> dict:
    def _extract_known_faults_pairs(text: str) -> list[dict]:
        t = text or ""
        idxs = []
        for name in ["无法开机", "吸力减弱", "异常噪音", "充电故障"]:
            for m in re.finditer(re.escape(name), t):
                idxs.append((m.start(), name))
        if not idxs:
            return []
        idxs.sort()
        pairs = []
        for i, (st, name) in enumerate(idxs):
            ed = idxs[i + 1][0] if i + 1 < len(idxs) else len(t)
            seg = t[st:ed]
            sols = []
            for ln in re.split(r"[\n；;。]", seg):
                ln = re.sub(r"^[\s·\-•\d\.\、]+\s*", "", ln.strip())
                sv = _clean_solution(ln)
                if sv:
                    nk = _norm_text(sv)
                    if nk not in {_norm_text(x) for x in sols}:
                        sols.append(sv)
                if len(sols) >= 5:
                    break
            if sols:
                pairs.append({"name": name, "solutions": sols})
        return pairs

    text = content[:120000]
    main_dev = _infer_main_device(content)
    candidates = []

    pf = _extract_known_faults_pairs(text)
    if pf:
        candidates.append({"devices": [{"name": main_dev, "faults": pf}]})
    numbered_pairs = _extract_numbered_fault_blocks(text)
    if numbered_pairs:
        candidates.append({"devices": [{"name": main_dev, "faults": numbered_pairs}]})

    table_kg = _parse_table_kg(text)
    if _has_useful_kg(table_kg):
        candidates.append(_constrain_kg_to_main_device(table_kg, text))
    graph = _extract_graph_from_content(content[:120000], main_device=main_dev)
    devices = []
    for dev, val in graph.items():
        faults = []
        for fault, fval in val["faults"].items():
            if fval["solutions"]:
                faults.append({"name": fault, "solutions": fval["solutions"][:5]})
        if faults:
            devices.append({"name": dev, "faults": faults[:8]})

    pairs = _extract_fault_solution_by_position(text)
    if not pairs:
        pairs = _extract_numbered_fault_blocks(text)
    if not pairs:
        pairs = _extract_table_pairs_from_content(text)
    if not pairs:
        pairs = _extract_fault_solution_pairs_from_content(text)
    if pairs:
        found = next((d for d in devices if d["name"] == main_dev), None)
        if found:
            exists = {x["name"] for x in found["faults"]}
            for p in pairs:
                if p["name"] not in exists:
                    found["faults"].append(p)
        else:
            devices.insert(0, {"name": main_dev, "faults": pairs[:10]})
    if devices:
        candidates.append({"devices": devices[:20]})

    if not candidates:
        return {"devices": []}

    def score(kg: dict) -> tuple[int, int]:
        ds = kg.get("devices", []) if isinstance(kg, dict) else []
        fault_cnt = sum(len((d or {}).get("faults", []) or []) for d in ds)
        sol_cnt = sum(len((f or {}).get("solutions", []) or []) for d in ds for f in (d or {}).get("faults", []) or [])
        return fault_cnt, sol_cnt

    best = max(candidates, key=score)
    return _constrain_kg_to_main_device(best, text)


def _build_minimum_kg(content: str) -> dict:
    text = content or ""
    compact = re.sub(r"\s+", "", text)
    main_dev = _infer_main_device(compact or text)
    fault_patterns = [
        r"[\u4e00-\u9fff]{1,10}(?:无法开机|吸力减弱|异常噪音|充电故障|故障|异常|过热|异响|堵塞|磨损|卡滞|短路|断路|跳闸|停机|无压力)"
    ]
    faults = []
    seen = set()
    for p in fault_patterns:
        for m in re.findall(p, compact or text):
            name = _clean_fault_name(m)
            if not name or not _is_valid_fault_phrase(name):
                continue
            k = _norm_text(name)
            if k in seen:
                continue
            seen.add(k)
            faults.append(name)
            if len(faults) >= 8:
                break
        if len(faults) >= 8:
            break

    solution_lines = []
    for line in ((text.splitlines() if "\n" in text else re.split(r"[。；;\n]+", text))):
        line = re.sub(r"^[\s·\-•\d\.\、]+", "", line.strip())
        sv = _clean_solution(line)
        if sv:
            nk = _norm_text(sv)
            if nk not in {_norm_text(x) for x in solution_lines}:
                solution_lines.append(sv)
        if len(solution_lines) >= 20:
            break

    if not faults and solution_lines:
        faults = ["设备运行异常"]
    if not faults:
        return {"devices": []}

    pairs = []
    for i, f in enumerate(faults):
        sols = solution_lines[i * 2:(i + 1) * 2] or solution_lines[:2]
        if not sols:
            continue
        pairs.append({"name": f, "solutions": sols[:5]})
    if not pairs:
        return {"devices": []}
    return {"devices": [{"name": main_dev, "faults": pairs[:8]}]}


def _merge_pairs_into_kg(kg: dict, content: str) -> dict:
    base = _sanitize_kg_payload(kg or {})
    pairs = _extract_table_pairs_from_content(content)
    if not pairs:
        return base
    main_dev = _infer_main_device(content)
    devices = list(base.get("devices", []))
    target = next((d for d in devices if _norm_text(d.get("name", "")) == _norm_text(main_dev)), None)
    if not target:
        target = {"name": main_dev, "faults": []}
        devices.insert(0, target)
    exists = {_norm_text(x.get("name", "")) for x in target.get("faults", [])}
    for p in pairs:
        nk = _norm_text(p.get("name", ""))
        if nk and nk not in exists:
            target["faults"].append(p)
            exists.add(nk)
    base["devices"] = devices[:30]
    return _constrain_kg_to_main_device(base, content)


async def _build_doc_kg_with_ai(content: str) -> dict:
    text = (content or "")[:120000]
    if not text:
        return {"devices": []}
    prompt = f"""
你是工业设备维修知识图谱抽取器，负责从维修手册中提取“设备 → 故障问题 → 解决方案”。

任务重点
- 优先识别“常见故障排查表/故障现象/可能原因/解决方法”三列表格
- 容错粘贴/OCR 格式：列可能错位、换行、使用数字序号（1. 2. 3.）
- 输出只保留“有故障且有明确解决动作”的条目；忽略噪声性标题或周期性维护项

强制约束
1. 仅输出 JSON；不要输出任何解释文字
2. 全部中文
3. 设备名称：若标题类似“XX维修保养手册/维修手册/保养手册”，设备名用“XX”
4. 故障优先从表格“故障现象”列逐行抽取；常见模板示例：
   故障现象 | 可能原因 | 解决方法
   无法开机 | ...     | ...
   吸力减弱 | ...     | ...
   异常噪音 | ...     | ...
   充电故障 | ...     | ...
5. 解决方案必须是“动作句”，如：检查/更换/清理/调整/润滑/测试/校准/复位/重启/排查
6. 去重与清洗：
   - 丢弃“常见故障排查表/技术参数/定期保养计划/安全须知/产品结构图示/分步维修指南/每日/每周/每月/每半年/每年/维修查询热线/更新日期/可能原因/解决方法/故障现象”等标题或周期词
   - 丢弃无动作动词的方案
   - 严禁把“原因句/条件句/判断句”当作故障名，例如包含“若/如果/则/需/需要/确认/建议”的句子不能作为故障名
   - 严禁把“手册标题/章节标题/目录项”当作故障名
7. 故障字段要求：
   - 必须是“故障现象短语”，长度 2~16 字，不能含逗号句号
   - 优先使用：无法开机/吸力减弱/异常噪音/充电故障/无法启动/不启动/无法充电/充不进电/过热报警/异响/无压力/压力不足
   - 若出现“温度传感器故障/加热盘损坏”等也可保留
8. 解决方案字段要求：
   - 必须是可执行动作，不得只是“原因判断”
   - 如果同一行只有“原因”没有动作，则不输出该方案
9. 数量要求：
   - 每个设备输出 3~8 个故障（如果手册中确实只有更少，则按实际）
   - 每个故障输出 1~5 条解决方案
10. 若未识别到表格：
   - 在全文中查找明确的故障标题（例如：无法开机/吸力减弱/异常噪音/充电故障/无法启动/不启动/无法充电/充不进电/过热报警/异响/无压力/压力不足），
     并在相邻段落或该标题下方提取动作型解决方案
11. 如仍得不到有效条目，返回空数组 devices: []

输出结构（严格遵循）：
{{
  "devices": [
    {{
      "name": "设备名",
      "faults": [
        {{
          "name": "故障现象",
          "solutions": ["解决方案1", "解决方案2", "解决方案3"]
        }}
      ]
    }}
  ]
}}

维修手册内容：
{text}
"""
    manager = get_llm_manager()
    resp, _provider = await manager.generate_with_fallback(prompt)
    parsed = _extract_json_dict(resp.content if resp else "")
    return _sanitize_kg_payload(parsed)


@router.post("/upload", response_model=UploadResponse)
async def upload_document(
    file: UploadFile = File(...),
    pipeline: str = Form("流水线1"),
):
    """上传设备文档，自动解析分块并存入 PostgreSQL 向量库"""
    # 文件大小校验
    if file.size and file.size > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件大小超过50MB")

    allowed = {".pdf", ".txt", ".log", ".docx"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"不支持的文件格式: {ext}")
    pipeline = _normalize_pipeline(pipeline)

    # 生成文档ID
    doc_id = uuid.uuid4()

    # 保存原始文件到本地
    save_path = Path(settings.MANUALS_PATH) / f"{doc_id}_{file.filename}"
    save_path.parent.mkdir(parents=True, exist_ok=True)

    content = await file.read()
    async with aiofiles.open(save_path, "wb") as f:
        await f.write(content)

    # 解析文档
    try:
        chunks = parse_document(str(save_path))
    except Exception as e:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"文档解析失败: {e}")

    if not chunks:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="文档中未提取到有效文本")

    # 创建文档记录（psycopg2 直连）
    import psycopg2.extras
    try:
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME
        ) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO documents (doc_id, filename, file_size, file_type, status, metadata)
                    VALUES (%s, %s, %s, %s, 'processing', %s)
                """, (
                    str(doc_id), file.filename, len(content),
                    ext[1:], psycopg2.extras.Json({"original_path": str(save_path), "pipeline": pipeline})
                ))
                conn.commit()
    except Exception as e:
        save_path.unlink(missing_ok=True)
        raise HTTPException(status_code=503, detail=f"数据库不可用或写入失败: {e}")

    # 估算 token 数（用于成本记录）
    try:
        enc = tiktoken.get_encoding("cl100k_base")
        for chunk in chunks:
            chunk["tokens"] = len(enc.encode(chunk["text"]))
    except Exception:
        for chunk in chunks:
            chunk["tokens"] = None

    # 存入 PostgreSQL（文本 + 向量双写）
    try:
        merged_text = "\n".join((c.get("text", "") for c in chunks))
        try:
            kg_payload = await _build_doc_kg_with_ai(merged_text)
            kg_payload = _merge_pairs_into_kg(kg_payload, merged_text)
            if not _has_useful_kg(kg_payload):
                kg_payload = _build_fallback_kg(merged_text)
            if not _has_useful_kg(kg_payload):
                kg_payload = _build_minimum_kg(merged_text)
            kg_payload = _constrain_kg_to_main_device(kg_payload, merged_text, file.filename or "")
        except Exception:
            kg_payload = _build_fallback_kg(merged_text)
            if not _has_useful_kg(kg_payload):
                kg_payload = _build_minimum_kg(merged_text)
            kg_payload = _constrain_kg_to_main_device(kg_payload, merged_text, file.filename or "")

        res = await add_chunks_to_db(chunks, str(doc_id))
        embedded = bool(res.get("embedded"))
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE documents
                    SET status = %s,
                        metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                    WHERE doc_id = %s
                    """,
                    (
                        'active',
                        psycopg2.extras.Json({
                            "embedding": "ok" if embedded else "skipped",
                            "kg": kg_payload
                        }),
                        str(doc_id),
                    )
                )
                conn.commit()
    except ValueError as e:
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE documents
                    SET status = 'failed',
                        metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                    WHERE doc_id = %s
                    """,
                    (psycopg2.extras.Json({"error": str(e)}), str(doc_id))
                )
                conn.commit()
        raise HTTPException(status_code=400, detail=f"向量入库失败: {e}")
    except Exception as e:
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE documents
                    SET status = 'failed',
                        metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                    WHERE doc_id = %s
                    """,
                    (psycopg2.extras.Json({"error": str(e)}), str(doc_id))
                )
                conn.commit()
        raise HTTPException(status_code=500, detail=f"向量入库失败: {e}")

    return UploadResponse(
        doc_id=str(doc_id),
        filename=file.filename,
        chunk_count=len(chunks),
        status="success",
    )


@router.get("/list")
async def list_documents():
    """列出已上传的文档"""
    import psycopg2.extras
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor(name="list_docs") as cur:
            cur.execute("""
                SELECT doc_id, filename, file_size, file_type, upload_time, status, metadata
                FROM documents WHERE status <> 'deleted'
                ORDER BY upload_time DESC
            """)
            rows = cur.fetchall()

    return [
        {
            "doc_id": str(row[0]),
            "filename": row[1],
            "file_size": row[2],
            "file_type": row[3],
            "upload_time": row[4].isoformat() if row[4] else None,
            "status": row[5],
            "pipeline": (row[6] or {}).get("pipeline", "流水线1"),
        }
        for row in rows
    ]


@router.delete("/{doc_id}")
async def delete_document(doc_id: str):
    """软删除文档（将 status 改为 deleted，向量数据通过外键级联删除）"""
    import psycopg2.extras
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET status = 'deleted' WHERE doc_id = %s AND status <> 'deleted'",
                (doc_id,)
            )
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="文档不存在或已是删除状态")

    return {"message": "文档已删除", "doc_id": doc_id}


@router.put("/{doc_id}/pipeline")
async def update_document_pipeline(doc_id: str, pipeline: str):
    pipeline = _normalize_pipeline(pipeline)

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE documents
                SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE doc_id = %s AND status <> 'deleted'
                """,
                (psycopg2.extras.Json({"pipeline": pipeline}), doc_id),
            )
            conn.commit()
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="文档不存在或已删除")

    return {"doc_id": doc_id, "pipeline": pipeline, "message": "流水线分组已更新"}


@router.get("/pipelines")
async def list_pipelines():
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT COALESCE(metadata->>'pipeline', '流水线1') AS pipeline
                FROM documents
                WHERE status <> 'deleted'
                ORDER BY pipeline
                """
            )
            rows = cur.fetchall()
    vals = [str(r[0]).strip() for r in rows if r and str(r[0]).strip()]
    if "流水线1" not in vals:
        vals.insert(0, "流水线1")
    return {"pipelines": vals}


@router.get("/stats")
async def get_stats():
    """获取系统统计信息"""
    import psycopg2
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM documents WHERE status = 'active'")
            doc_count = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM document_chunks")
            chunk_count = cur.fetchone()[0]
    return {
        "total_docs": doc_count or 0,
        "total_chunks": chunk_count or 0,
    }


@router.post("/search")
async def search_knowledge(query: str, top_k: int = 5):
    """在知识库中搜索，返回相关段落"""
    try:
        results = await retrieve(query, top_k=top_k)
        return {
            "results": results,
            "count": len(results),
            "query": query,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"搜索失败: {str(e)}")


@router.get("/graph")
async def knowledge_graph(pipeline: str = "流水线1"):
    pipeline = _normalize_pipeline(pipeline)

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    d.doc_id,
                    d.filename,
                    COALESCE(d.metadata->>'pipeline', '流水线1') AS pipeline,
                    d.metadata,
                    COALESCE(string_agg(c.text, ' ' ORDER BY c.chunk_index), '') AS content
                FROM documents d
                LEFT JOIN document_chunks c ON c.doc_id = d.doc_id
                WHERE d.status = 'active'
                  AND COALESCE(d.metadata->>'pipeline', '流水线1') = %s
                GROUP BY d.doc_id, d.filename, d.metadata
                ORDER BY d.upload_time DESC
                """,
                (pipeline,),
            )
            rows = cur.fetchall()

    merged = {}
    for row in rows:
        metadata = row[3] or {}
        content = row[4] or ""
        part_from_db = (metadata.get("kg", {}) if isinstance(metadata, dict) else {}) or {}
        part_from_db = _sanitize_kg_payload(part_from_db)
        # 图谱查询时优先基于“当前文档内容”重构，避免旧 metadata.kg 噪声长期残留
        part_from_fallback = _build_fallback_kg(content[:120000])
        part_from_min = _build_minimum_kg(content[:120000])
        if _has_useful_kg(part_from_fallback):
            source = part_from_fallback
        elif _has_useful_kg(part_from_db):
            source = part_from_db
        else:
            source = part_from_min
        source = _constrain_kg_to_main_device(source, content[:120000], row[1] or "")
        if not source.get("devices"):
            guessed = _infer_main_device((row[1] or "") + "\n" + content[:1000])
            source = {
                "devices": [
                    {
                        "name": guessed,
                        "faults": [
                            {
                                "name": "设备运行异常",
                                "solutions": ["请补充包含“故障现象-解决方法”的手册段落后重建图谱"]
                            }
                        ]
                    }
                ]
            }
        part = {}
        for d in source.get("devices", []):
            dev_name = str((d or {}).get("name", "")).strip()
            if not dev_name:
                continue
            part.setdefault(dev_name, {"faults": {}})
            for f in (d or {}).get("faults", []) or []:
                fn = str((f or {}).get("name", "")).strip()
                if not fn:
                    continue
                part[dev_name]["faults"].setdefault(fn, {"solutions": []})
                for s in (f or {}).get("solutions", []) or []:
                    sv = str(s).strip()
                    if sv and sv not in part[dev_name]["faults"][fn]["solutions"]:
                        part[dev_name]["faults"][fn]["solutions"].append(sv)
        for dev, val in part.items():
            merged.setdefault(dev, {"faults": {}})
            for fault, fval in val["faults"].items():
                merged[dev]["faults"].setdefault(fault, {"solutions": []})
                for sol in fval["solutions"]:
                    if sol not in merged[dev]["faults"][fault]["solutions"]:
                        merged[dev]["faults"][fault]["solutions"].append(sol)

    devices = []
    for dev, val in merged.items():
        faults = []
        for fault, fval in val["faults"].items():
            if not _is_valid_fault_phrase(fault):
                continue
            clean_solutions = []
            seen_sol = set()
            for s in fval["solutions"]:
                sv = _clean_solution(str(s))
                nk = _norm_text(sv)
                if sv and nk not in seen_sol:
                    clean_solutions.append(sv)
                    seen_sol.add(nk)
            if not clean_solutions:
                continue
            faults.append({
                "name": fault,
                "solutions": clean_solutions[:5],
            })
        if not faults:
            continue
        devices.append({
            "name": dev,
            "faults": faults[:8],
        })

    if not devices and rows:
        guessed = _infer_main_device((rows[0][1] or "") + "\n" + (rows[0][4] or "")[:1000])
        devices = [{
            "name": guessed,
            "faults": [{
                "name": "设备运行异常",
                "solutions": ["检查电源与关键部件连接状态后重建图谱"]
            }]
        }]

    return {
        "pipeline": pipeline,
        "doc_count": len(rows),
        "devices": devices[:20],
        "device_count": len(devices[:20]),
        "fault_count": sum(len((d or {}).get("faults", []) or []) for d in devices[:20]),
        "version": "kg_v4_content_first",
    }


@router.post("/graph/rebuild")
async def rebuild_knowledge_graph(pipeline: str = "流水线1"):
    pipeline = _normalize_pipeline(pipeline)
    rebuilt = 0
    failed = 0

    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    d.doc_id,
                    COALESCE(string_agg(c.text, E'\n' ORDER BY c.chunk_index), '') AS content
                FROM documents d
                LEFT JOIN document_chunks c ON c.doc_id = d.doc_id
                WHERE d.status = 'active'
                  AND COALESCE(d.metadata->>'pipeline', '流水线1') = %s
                GROUP BY d.doc_id
                """,
                (pipeline,),
            )
            rows = cur.fetchall()

    for row in rows:
        doc_id = str(row[0])
        content = row[1] or ""
        try:
            try:
                kg_payload = await _build_doc_kg_with_ai(content[:120000])
                kg_payload = _merge_pairs_into_kg(kg_payload, content[:120000])
                if not _has_useful_kg(kg_payload):
                    kg_payload = _build_fallback_kg(content[:120000])
                if not _has_useful_kg(kg_payload):
                    kg_payload = _build_minimum_kg(content[:120000])
                kg_payload = _constrain_kg_to_main_device(kg_payload, content[:120000])
            except Exception:
                kg_payload = _build_fallback_kg(content[:120000])
                if not _has_useful_kg(kg_payload):
                    kg_payload = _build_minimum_kg(content[:120000])
                kg_payload = _constrain_kg_to_main_device(kg_payload, content[:120000])

            useful = _has_useful_kg(kg_payload)
            with psycopg2.connect(
                host=settings.DB_HOST, port=settings.DB_PORT,
                user=settings.DB_USER, password=settings.DB_PASSWORD,
                database=settings.DB_NAME
            ) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE documents
                        SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                        WHERE doc_id = %s
                        """,
                        (psycopg2.extras.Json({"kg": kg_payload}), doc_id),
                    )
                    conn.commit()
            if useful:
                rebuilt += 1
            else:
                failed += 1
        except Exception:
            failed += 1

    return {"pipeline": pipeline, "rebuilt": rebuilt, "failed": failed}

@router.post("/reparse")
async def reparse_document(doc_id: str):
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT filename, metadata FROM documents WHERE doc_id=%s AND status <> 'deleted'",
                (doc_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="文档不存在或已删除")
            meta = row[1] or {}
            path = (meta.get("original_path") if isinstance(meta, dict) else None) or ""
    if not path or not Path(path).exists():
        raise HTTPException(status_code=400, detail="无法定位原文件路径")
    chunks = parse_document(path)
    enc = tiktoken.get_encoding("cl100k_base")
    try:
        for c in chunks:
            c["tokens"] = len(enc.encode(c.get("text", "")))
    except Exception:
        for c in chunks:
            c["tokens"] = None
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM document_chunks WHERE doc_id=%s", (doc_id,))
            conn.commit()
    await add_chunks_to_db(chunks, doc_id)
    merged_text = "\n".join(c.get("text", "") for c in chunks)
    try:
        kg_payload = await _build_doc_kg_with_ai(merged_text)
        kg_payload = _merge_pairs_into_kg(kg_payload, merged_text)
        if not _has_useful_kg(kg_payload):
            kg_payload = _build_fallback_kg(merged_text)
        if not _has_useful_kg(kg_payload):
            kg_payload = _build_minimum_kg(merged_text)
        kg_payload = _constrain_kg_to_main_device(kg_payload, merged_text, row[0] or "")
    except Exception:
        kg_payload = _build_fallback_kg(merged_text)
        if not _has_useful_kg(kg_payload):
            kg_payload = _build_minimum_kg(merged_text)
        kg_payload = _constrain_kg_to_main_device(kg_payload, merged_text, row[0] or "")
    with psycopg2.connect(
        host=settings.DB_HOST, port=settings.DB_PORT,
        user=settings.DB_USER, password=settings.DB_PASSWORD,
        database=settings.DB_NAME
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET metadata = COALESCE(metadata,'{}'::jsonb) || %s::jsonb WHERE doc_id=%s",
                (psycopg2.extras.Json({"kg": kg_payload}), doc_id),
            )
            conn.commit()
    return {"doc_id": doc_id, "chunks": len(chunks), "kg_faults": sum(len(f.get("solutions", [])) >= 1 for d in kg_payload.get("devices", []) for f in d.get("faults", []))}
