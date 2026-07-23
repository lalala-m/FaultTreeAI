from dataclasses import dataclass
from pathlib import Path
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


VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".m4v", ".webm"}


def _is_video_file(name: str) -> bool:
    return Path(str(name or "")).suffix.lower() in VIDEO_EXTENSIONS


def _infer_device_from_filename(name: str) -> str:
    n = re.sub(r"\.[^.]+$", "", str(name or "").strip())
    if _is_video_file(name):
        return "通用设备"
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


def _extract_maintenance_rule_items(content: str, filename: str) -> list[dict]:
    """针对维修/保养手册的规程类文本，抽取“条件/状态 + 操作/处理”条目。
    例如：
      - 若存在磨损腐蚀或划伤应更换相应凸轮轴
      - 齿轮磨损或齿伤 更换有缺陷的齿轮
      - 无刮痕无磨损
    返回 maintenance 类型条目，operation_item 为作业项，operation_steps 为处理动作。
    """
    text = str(content or "")
    if not text.strip():
        return []
    device = _infer_device_from_filename(filename)
    machine = _clean_phrase(device, 60) or "设备"
    machine_category = _infer_machine_category(machine)
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n") if ln.strip()]

    # 动作词（用于切分“条件 + 操作”）
    action_pattern = r"(更换|修理|修复|检修|维护|保养|检查|检测|测量|测试|校准|校中|找正|平衡|调整|调节|设定|紧固|拧紧|锁紧|旋紧|安装|装配|装入|装上|拆下|拆卸|拆解|分解|取下|卸下|取出|清洗|清洁|冲洗|吹扫|擦拭|润滑|注油|加油|补油|换油|涂油|涂胶|研磨|抛光|打磨|报废|废弃|停用|重启|复位|调试|校验|确认|重新安装|重装|重新装配|重新固定|重新连接|重新调整|重新设定|重新校准|重新检测|重新检查|重新测试|重新清洗|重新润滑|重新加油|重新换油|重新紧固|重新拧紧|重新安装|重新装配|重新装入|重新装上|重新拆下|重新拆卸|重新拆解|重新分解)"
    # 条件词（磨损/损伤等）
    condition_keywords = ["磨损", "腐蚀", "锈蚀", "划伤", "刮痕", "损伤", "损坏", "裂纹", "断裂", "变形", "松动", "卡滞", "堵塞", "泄漏", "漏油", "缺油", "老化", "烧蚀", "缺口", "剥落", "点蚀", "异物", "积碳", "拉伤", "咬死", "抱死", "间隙", "不对中", "不平衡", "渗油", "脏污", "污染", "破损", "开裂", "过热", "异响", "振动", "抖动", "无法", "不动", "不转", "打滑", "失效", "不工作", "失灵"]

    items = []
    seen = set()
    for ln in lines:
        if len(ln) < 6 or len(ln) > 300:
            continue
        # 过滤目录/前言/安全声明等无意义行
        if re.match(r"^(目录|前言|范围|术语|引用文件|附录|包装|运输|安全|工具|规格|型号|参数|尺寸|重量|材料|数量|备注|日期|版本|修订|审核|批准|编制|单位|地址|电话|传真|邮编|邮箱|网址|页码|第[一二三四五六七八九十0-9]+章|第\d+章|第\d+节|图\d+|表\d+)", ln):
            continue

        # 先在当前行中找动作词切分
        m = re.search(action_pattern, ln)
        if not m:
            continue

        condition_part = ln[:m.start()].strip()
        action_part = ln[m.start():].strip()

        # 清洗条件部分：去掉“若/如/如果/有”等前缀，去掉“应/则需”等尾部词
        condition_part = re.sub(r"^(若存在|若出现|如发现|若有|如有|如果|假如|要是|倘若|若是|若|如|有|存在|出现|发现|检查|检测|观察到|看到|确认)[\s，,、]*", "", condition_part)
        condition_part = re.sub(r"[\s，,、；;]*(?:则需|则应|方才|才能|才可|即可|才行|方可|方能|始能|才需|才应|才要|才|应|需|必须|要|则|就|便)[\s，,、；;]*$", "", condition_part)
        condition_part = re.sub(r"^\d+\s*[\.、]\s*", "", condition_part)

        # 清洗动作部分：去掉序号前缀
        action_part = re.sub(r"^\d+\s*[\.、]\s*", "", action_part)
        action_part = re.sub(r"^[\s，,、；;]+", "", action_part)
        action_part = re.sub(r"[\s，,、；;]+$", "", action_part)

        if not condition_part or not action_part:
            continue
        if len(condition_part) < 2 or len(action_part) < 2:
            continue

        # 条件中至少包含一个故障/状态关键词，或者是“无...”的负向检查项
        has_condition_keyword = any(k in condition_part for k in condition_keywords)
        is_negative_check = condition_part.startswith("无") and not condition_part.startswith("无法")
        if not has_condition_keyword and not is_negative_check:
            continue

        # 负向检查项转换为问题：无刮痕无磨损 -> 存在刮痕或磨损
        if is_negative_check:
            # 去掉句首的“无”，把后续的“无”改成“或”
            cond = condition_part[1:].replace("无", "或")
            cond = re.sub(r"^[或、]+", "", cond)
            cond = re.sub(r"[或、]+$", "", cond)
            condition_part = "存在" + cond if cond else condition_part

        # 如果条件部分缺少主语/部件，尝试从动作部分提取宾语并前置
        # 例如：condition="磨损腐蚀或划伤" action="更换相应凸轮轴" -> "凸轮轴磨损腐蚀或划伤"
        m_obj = re.match(r"^(?:更换|检查|修理|修复|安装|拆卸|拆下|清洗|清洁|润滑|紧固|检测|测量|测试|校准|调整|调节|确认|重新安装|重装)(?:相应|同型号|同规格|有缺陷的|缺陷|新的|合格|原厂|备用|旧的|损坏的|磨损的|腐蚀的|断裂的|变形的|松动的|卡滞的|老化的|烧蚀的|有裂纹的|有损伤的|有刮痕的)?([^，,、；;\s]{1,8})", action_part)
        if m_obj:
            part_name = m_obj.group(1).strip()
            if part_name and len(part_name) >= 2 and part_name not in condition_part and part_name[-2:] not in condition_part and part_name[-3:] not in condition_part:
                condition_part = part_name + condition_part

        operation_item = _clean_phrase(condition_part, 120)
        if not operation_item or len(operation_item) < 4:
            continue

        operation_steps = _clean_phrase(action_part, 600)
        if not operation_steps:
            continue

        operation_category = "维护"
        if any(k in operation_steps for k in ["更换", "拆下", "拆卸", "拆", "换"]):
            operation_category = "更换"
        elif any(k in operation_steps for k in ["检查", "检测", "测量", "测试"]):
            operation_category = "检查"
        elif any(k in operation_steps for k in ["清洗", "清洁", "冲洗", "吹扫", "擦拭", "润滑", "注油", "加油", "补油", "换油", "涂油"]):
            operation_category = "保养"
        elif any(k in operation_steps for k in ["安装", "装配", "装入", "装上"]):
            operation_category = "安装"
        elif any(k in operation_steps for k in ["校准", "校中", "找正", "平衡", "调整", "调节", "设定"]):
            operation_category = "校准"

        key = (machine.lower(), operation_item.lower())
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "knowledge_type": "maintenance",
                "machine_category": machine_category,
                "machine": machine,
                "operation_category": operation_category,
                "operation_item": operation_item,
                "operation_steps": operation_steps,
                "check_standard": "",
                "precautions": "",
            }
        )
        if len(items) >= 80:
            break
    return items


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


def _is_maintenance_manual(filename: str) -> bool:
    """判断文件名是否属于维修/保养手册。"""
    f = str(filename or "").lower()
    keys = [
        "维修手册", "保养手册", "维护手册", "检修手册", "修理手册",
        "service manual", "maintenance manual", "repair manual",
    ]
    return any(k in f for k in keys)


def _is_standard_doc(filename: str, content: str) -> bool:
    f = str(filename or "")
    if _is_video_file(f):
        return False
    if _is_maintenance_manual(f):
        return False
    t = str(content or "")
    head = (f + "\n" + t[:20000]).lower()
    keys = [
        "验收", "检验", "检测", "标准", "规范", "允许偏差", "公差", "判定", "合格", "不合格",
        "gb/", "gbt", "iso", "iec", "试验", "测试", "检定", "等级", "限值", "阈值",
    ]
    return any(k in head for k in keys)


def _extract_maintenance_manual_items_by_structure(content: str, filename: str) -> list[dict]:
    """基于维修手册常见目录结构（如 1.1 拆卸火花塞）抽取维修作业项。"""
    text = str(content or "")
    if not text.strip():
        return []
    device = _infer_device_from_filename(filename)
    machine = _clean_phrase(device, 60) or "设备"
    machine_category = _infer_machine_category(machine)

    ops = [
        "拆卸", "安装", "检查", "测量", "调整", "校准", "清洗", "清洁", "润滑", "保养",
        "更换", "维修", "拆解", "装配", "装入", "测试", "张紧", "启动", "校验", "平衡",
        "找正", "校中", "紧固", "拧紧", "锁紧", "旋紧", "研磨", "抛光", "打磨", "报废",
        "废弃", "停用", "重启", "复位", "调试", "预热", "冷却", "排放", "加注",
    ]
    ops = list(dict.fromkeys(ops))
    ops_pattern = "|".join(re.escape(o) for o in ops)
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n")]

    # 1. 先找出所有可能的章节边界（包括大章节和小节），它们都能打断上一个条目的内容
    section_patterns = [
        r"^[\u4e00-\u9fa5]+[、\.]\s*.+$",           # 一、火花塞
        r"^\d+(?:\.\d+)+\s+.+$",                   # 1.1 拆卸火花塞
        r"^（[一二三四五六七八九十0-9]+）\s*.+$",    # （1）安装垫片
        r"^[一二三四五六七八九十]+[\.、]\s*.+$",    # 一. 火花塞
    ]
    section_boundaries = set()
    for i, ln in enumerate(lines):
        if not ln or len(ln) > 80:
            continue
        for p in section_patterns:
            if re.match(p, ln):
                section_boundaries.add(i)
                break

    # 2. 在这些边界里找出真正的“操作 部件”标题
    headings = []
    for i in section_boundaries:
        ln = lines[i]
        # 尝试去掉序号前缀，拿到标题正文
        rest = re.sub(r"^[\u4e00-\u9fa5]+[、\.]\s*", "", ln)
        rest = re.sub(r"^\d+(?:\.\d+)*\s+", "", rest)
        rest = re.sub(r"^（[一二三四五六七八九十0-9]+）\s*", "", rest)
        rest = rest.strip().strip("：:").strip()

        # 过滤清单类伪标题
        if any(k in rest for k in ["装配部件清单", "零件清单", "料件清单", "部件清单", "料件名称"]):
            continue
        if not rest or len(rest) < 2 or len(rest) > 40:
            continue

        # 匹配“操作 部件”
        op_m = re.match(rf"^({ops_pattern})(.+)$", rest)
        if op_m:
            op, part = op_m.groups()
            part = part.strip().strip("：:").strip()
            if part and 2 <= len(part) <= 40:
                headings.append((i, op, part, ln))
                continue
        # 反向：部件 操作
        op_m = re.match(rf"^(.+?)({ops_pattern})$", rest)
        if op_m:
            part, op = op_m.groups()
            part = part.strip().strip("：:").strip()
            if part and 2 <= len(part) <= 40:
                headings.append((i, op, part, ln))

    if not headings:
        return []

    items = []
    seen = set()
    for idx, (line_idx, op, part, heading) in enumerate(headings):
        # 下一个章节边界就是内容结束位置
        end_idx = len(lines)
        for boundary in sorted(section_boundaries):
            if boundary > line_idx:
                end_idx = boundary
                break
        content_lines = lines[line_idx + 1:end_idx]

        steps = []
        standards = []
        precautions = []
        for cl in content_lines:
            if not cl:
                continue
            # 检查标准：含数值、标准、范围、应/不得/必须等，且不含注意提示词
            if any(k in cl for k in ["标准", "范围", "限值", "应", "不得", "必须", "符合", "合格", "值", "≥", "≤", "mm", "N·m", "kPa", "r/min", "Nm", "间隙", "扭矩", "压力", "偏差", "公差"]) and not any(k in cl for k in ["注意", "提示", "警告"]):
                standards.append(cl)
            # 注意事项/安全提示
            elif any(k in cl for k in ["注意", "提示", "警告", "警示", "防止", "避免", "小心", "不要", "严禁", "确保"]) and not any(k in cl for k in ["标准", "范围", "≥", "≤", "mm", "N·m"]):
                precautions.append(cl)
            # 操作步骤：编号项或较长的正文
            elif re.match(r"^\d+\s*[\.、]\s*", cl) or len(cl) > 6:
                steps.append(cl)

        # 限制内容长度，避免单条过长
        operation_steps = _clean_phrase(" ".join(steps[:3]), 300)
        check_standard = _clean_phrase(" ".join(standards[:2]), 200)
        precaution_text = _clean_phrase(" ".join(precautions[:2]), 200)

        operation_item = _clean_phrase(f"{part}{op}", 120)
        if not operation_item or len(operation_item) < 4:
            continue

        key = (machine.lower(), operation_item.lower())
        if key in seen:
            continue
        seen.add(key)

        items.append(
            {
                "knowledge_type": "maintenance",
                "machine_category": machine_category,
                "machine": machine,
                "operation_category": op,
                "operation_item": operation_item,
                "operation_steps": operation_steps,
                "check_standard": check_standard,
                "precautions": precaution_text,
            }
        )
        if len(items) >= 60:
            break

    return items



async def _extract_maintenance_manual_items_with_llm(filename: str, content: str) -> tuple[list[dict], str]:
    """专门处理维修/保养手册：优先使用结构解析器，再用 LLM 补充/校验。"""
    text = str(content or "").strip()
    if not text:
        return [], ""
    device_hint = _infer_device_from_filename(filename)

    # 1. 结构解析器：基于手册常见目录结构（如 1.1 拆卸火花塞）快速抽取
    structured_items = _extract_maintenance_manual_items_by_structure(text, filename)
    print(f"[EXTRACT] 维修手册结构解析条目数: {len(structured_items)}", flush=True)
    if len(structured_items) >= 12:
        return structured_items, "structure-parser"

    # 2. LLM 兜底：结构解析太少时，尝试 LLM 总结再转 JSON
    manager = get_llm_manager()
    selected_text = _select_relevant_text(text, limit_chars=12000)

    summary_prompt = f"""你是工业设备维修手册结构化专家。请从下面手册中提炼所有维修作业项。

输出格式：每条一行，用"部件/部位 | 作业类别 | 操作步骤 | 检查标准 | 注意事项"表示，字段间用竖线分隔，无内容填"-"。

示例：
火花塞 | 拆卸 | 用火花塞专用套筒拆下火花塞 | - | 逆时针转动拆下
火花塞 | 检查 | 检查螺纹和中心电极，测量间隙 | 间隙 0.7～0.9 mm | 有损坏或变形应更换
气门间隙 | 调整 | 拆下凸轮轴，更换合适厚度调整垫片 | 进气门 0.13～0.20 mm，排气门 0.20～0.30 mm | 滑动挺柱、调整垫片与气门严禁混用

设备名称：{device_hint}

手册内容：
{selected_text}
"""
    try:
        summary_resp, provider = await manager.generate_with_fallback(summary_prompt, max_tokens=4096)
    except Exception as e:
        print(f"[EXTRACT] 维修手册 LLM 总结失败: {e}", flush=True)
        return structured_items, "structure-parser"

    summary_text = (summary_resp.content or "").strip()
    print(f"[EXTRACT] 维修手册 LLM 总结（前 500 字）: {summary_text[:500]}", flush=True)
    if not summary_text:
        return structured_items, "structure-parser"

    json_prompt = f"""把下面维修作业项清单转成标准 JSON：
{{
  "items": [
    {{"machine_category":"机械类别","machine":"设备或部件（若未明确用{device_hint}）","operation_category":"作业类别","operation_item":"部件+作业（如火花塞拆卸）","operation_steps":"操作步骤","check_standard":"检查标准/合格要求","precautions":"安全注意事项"}}
  ]
}}

清单：
{summary_text}
"""
    try:
        resp, provider = await manager.generate_with_fallback(json_prompt, max_tokens=4096)
    except Exception as e:
        print(f"[EXTRACT] 维修手册 LLM JSON 失败: {e}", flush=True)
        return structured_items, "structure-parser"

    raw_content = (resp.content or "").strip()
    try:
        parsed = _extract_json_obj(raw_content)
    except Exception as e:
        print(f"[EXTRACT] 维修手册 LLM JSON 解析失败: {e}; raw={raw_content[:500]}", flush=True)
        return structured_items, "structure-parser"

    items = parsed.get("items", [])
    if not isinstance(items, list):
        return structured_items, "structure-parser"

    out = []
    seen = set()
    for it in items[:80]:
        if not isinstance(it, dict):
            continue
        machine = _clean_phrase(it.get("machine") or device_hint, 60) or _clean_phrase(device_hint, 60) or "设备"
        machine_category = _canonicalize_machine_category(_clean_phrase(it.get("machine_category"), 30), machine) or _infer_machine_category(machine)
        operation_item = _clean_phrase(it.get("operation_item"), 120)
        if not operation_item or len(operation_item) < 4:
            continue
        operation_category = _clean_phrase(it.get("operation_category"), 60) or "维护"
        key = (_clean_phrase(machine, 80).lower(), operation_item.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "knowledge_type": "maintenance",
                "machine_category": machine_category,
                "machine": machine,
                "operation_category": operation_category,
                "operation_item": operation_item,
                "operation_steps": _clean_phrase(it.get("operation_steps"), 600),
                "check_standard": _clean_phrase(it.get("check_standard"), 400),
                "precautions": _clean_phrase(it.get("precautions"), 400),
            }
        )
        if len(out) >= 40:
            break

    # 合并结构解析结果与 LLM 结果
    merged = {f"{_clean_phrase(it['machine'],80).lower()}|{it['operation_item'].lower()}": it for it in structured_items}
    for it in out:
        key = f"{_clean_phrase(it['machine'],80).lower()}|{it['operation_item'].lower()}"
        if key not in merged:
            merged[key] = it
    final_items = list(merged.values())
    if not final_items:
        return structured_items, provider
    print(f"[EXTRACT] 维修手册最终条目数: {len(final_items)}", flush=True)
    return final_items, provider
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
        check_item = _clean_phrase(check_item, 120)
        if not check_item or len(check_item) < 4:
            continue
        requirement = _clean_phrase(ln, 400)
        key = (machine.lower(), check_item.lower())
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "knowledge_type": "maintenance",
                "machine_category": machine_category,
                "machine": machine,
                "operation_category": "验收",
                "operation_item": check_item,
                "operation_steps": "",
                "check_standard": f"合格标准：{requirement}",
                "precautions": "",
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

请只从给定文档内容中抽取“验收检查项/判定点 + 合格标准(阈值/限值/允许偏差) + 检测方法(如有) + 不合格处置(如有)”，并整理成维修作业类知识库条目（knowledge_type='maintenance'）。

严格输出一个JSON对象，不要输出任何解释文字或代码块：
{{
  "items": [
    {{
      "machine": "机械（设备/部件/型号）",
      "machine_category": "机械类别（如 电机/变频器/PLC/传感器/通用设备）",
      "operation_category": "作业类别（如 验收/检测/检验/判定）",
      "operation_item": "验收/检测检查项（短句）",
      "operation_steps": "检测方法/步骤（短句，可空）",
      "check_standard": "合格标准/阈值/限值/允许偏差（短句）",
      "precautions": "不合格处置/整改建议/安全注意事项（短句，可空）"
    }}
  ]
}}

抽取规则（必须遵守）：
1) 只抽取“标准/验收/检测/判定/合格/不合格/限值/阈值/允许偏差”等内容，不要抽目录/前言/背景
2) machine 优先用文档明确对象；不明确时用文件名推断：{device_hint}
3) operation_item 与 check_standard 必须有内容；operation_steps/precautions 可为空
4) 每条的 operation_item<=60字，check_standard<=200字，operation_steps/precautions<=200字
5) items数量控制在 30 条以内，去重（相同 machine+operation_item 只保留一条）

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
        operation_item = _clean_phrase(it.get("operation_item") or it.get("check_item"), 120)
        check_standard = _clean_phrase(it.get("check_standard") or it.get("requirement"), 400)
        operation_steps = _clean_phrase(it.get("operation_steps") or it.get("method"), 400)
        precautions = _clean_phrase(it.get("precautions") or it.get("disposition"), 400)
        operation_category = _clean_phrase(it.get("operation_category") or "验收", 60) or "验收"
        if not operation_item or not check_standard:
            continue
        if len(operation_item) < 4:
            continue
        key = (machine.lower(), operation_item.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "knowledge_type": "maintenance",
                "machine_category": machine_category,
                "machine": machine,
                "operation_category": operation_category,
                "operation_item": operation_item,
                "operation_steps": operation_steps,
                "check_standard": check_standard,
                "precautions": precautions,
                "standard": {
                    "check_item": operation_item[:120],
                    "requirement": check_standard[:400],
                    "method": operation_steps[:400],
                    "disposition": precautions[:400],
                },
            }
        )
        if len(out) >= 30:
            break
    return out, provider


def _extract_json_obj(text: str) -> dict:
    raw = (text or "").strip()
    if not raw:
        raise ValueError("LLM输出为空")
    # 去掉 markdown 代码块标记
    if raw.startswith("```"):
        parts = raw.split("\n")
        raw = "\n".join(parts[1:-1]) if parts[-1].strip() == "```" else "\n".join(parts[1:])
        raw = raw.strip()
    # 去掉常见的思考标签（如豆包/DeepSeek 的 <thinking>）
    raw = re.sub(r"<thinking>.*?</thinking>", "", raw, flags=re.DOTALL).strip()
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    # 如果有多行文本，尝试找到第一个 { 开头、最后一个 } 结尾的 JSON 对象
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        raise ValueError("LLM输出中未找到JSON对象")
    raw = m.group(0).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"LLM输出JSON解析失败: {e}")


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


async def _extract_video_items_with_llm(filename: str, content: str) -> tuple[list[dict], str]:
    """专门处理维修/保养教学视频 ASR 转写文本：整理成维修作业类条目。"""
    text = _select_relevant_text(content)
    if not text:
        return [], ""
    device_hint = _infer_device_from_filename(filename)
    prompt = f"""你是维修作业视频内容整理专家。下面是一段维修/保养/实操教学视频的语音转写文本，口语化较重，可能包含开场白、语气词和重复内容。

你的任务是先理解视频内容，把口语文本整理成若干条规范的“维修作业项”知识库条目（knowledge_type='maintenance'）。

严格输出一个JSON对象，不要输出任何解释文字或代码块：
{{
  "items": [
    {{
      "machine_category": "机械类别（如 电机/变频器/PLC/传感器/液压/气动/通用设备）",
      "machine": "机械（设备/型号，若视频中未明确则写“通用设备”）",
      "operation_category": "作业类别（如 维护/保养/检修/校准/更换/安装/拆卸/检查）",
      "operation_item": "作业项名称（短句，<=60字，不要序号/特殊符号）",
      "operation_steps": "操作步骤（动作短句，<=300字，可用分号或换行分隔）",
      "check_standard": "检查/验收标准（短句，<=200字，可空）",
      "precautions": "安全注意事项（短句，<=200字，可空）"
    }}
  ]
}}

整理规则（必须遵守）：
1) 忽略开场白、寒暄、点赞关注、语气词和重复表述
2) 从视频中识别具体的“维修/保养/检查/更换/安装/拆卸/校准/调试/清洁/润滑”等作业内容作为 operation_item
3) 把视频中提到的“操作步骤、先后顺序、关键动作”整理到 operation_steps
4) 把“合格标准、验收要求、判断依据”整理到 check_standard
5) 把“安全提示、注意事项、必须/禁止事项”整理到 precautions
6) 如果视频只是故障现象讲解，没有明确维修作业内容，则 items 留空
7) machine 不要从文件名推断；若视频语音中未明确设备名，统一写“通用设备”
8) items 数量控制在 30 条以内，去重（相同 machine+operation_item 只保留一条）

视频语音转写内容：
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
        machine = _clean_phrase(it.get("machine") or device_hint, 60) or _clean_phrase(device_hint, 60) or "通用设备"
        machine_category = _canonicalize_machine_category(_clean_phrase(it.get("machine_category"), 30), machine) or _infer_machine_category(machine)
        operation_item = _clean_phrase(it.get("operation_item"), 120)
        if not operation_item or len(operation_item) < 4:
            continue
        operation_category = _clean_phrase(it.get("operation_category") or "维护", 60) or "维护"
        operation_steps = _clean_phrase(it.get("operation_steps"), 600)
        check_standard = _clean_phrase(it.get("check_standard"), 400)
        precautions = _clean_phrase(it.get("precautions"), 400)
        key = (_clean_phrase(machine, 80).lower(), operation_item.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "knowledge_type": "maintenance",
                "machine_category": machine_category,
                "machine": machine,
                "operation_category": operation_category,
                "operation_item": operation_item,
                "operation_steps": operation_steps,
                "check_standard": check_standard,
                "precautions": precautions,
            }
        )
        if len(out) >= 30:
            break
    return out, provider


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
1) 同时抽取两类内容：
   a) 明确属于“故障/异常/报警/失效/无法/跳闸/过热/异响/堵塞/磨损/卡滞/损伤/划伤/腐蚀/断裂/变形/松动/老化/泄漏”等现象的条目；
   b) 维修/保养/装配规程中的“条件检查 + 处理动作”条目，例如：
      - “若存在磨损腐蚀或划伤应更换相应凸轮轴” → problem=“凸轮轴磨损、腐蚀或划伤”，solution=“更换相应凸轮轴”
      - “齿轮磨损或齿伤 更换有缺陷的齿轮” → problem=“齿轮磨损或齿伤”，solution=“更换有缺陷的齿轮”
      - “无刮痕无磨损” → problem=“存在刮痕或磨损”，solution=“检查并修复或更换”
2) 机械(machine)优先用手册明确的设备名/型号；若不明确，使用文件名推断：{device_hint}
3) 过滤无用信息：纯安全提示、目录、参数表、工具清单、泛化描述（如“检查电源”但没有对应故障现象）不要输出；但“注意 A 孔周围不得有密封胶”这类有明确判定条件的可输出为“存在密封胶”→“清理密封胶”
4) machine_category/problem_category若手册没有，基于 machine/problem 内容合理推断；不要留空
5) 每个条目必须包含 problem；root_cause 若无法从原文明确抽取，请输出空字符串（系统会自动填为“未明确”）
6) 遇到“条件检查 + 处理动作”的句子，应把条件部分作为 problem，处理动作部分作为 solution，不要把整句都填进 problem
7) items数量控制在 30 条以内，去重（相同 machine+problem+root_cause 只保留一条）

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
                -- 维修作业类专用字段（方案 2）
                knowledge_type VARCHAR(32) NOT NULL DEFAULT 'fault',
                operation_category VARCHAR(120) NOT NULL DEFAULT '',
                operation_item TEXT NOT NULL DEFAULT '',
                operation_steps TEXT NOT NULL DEFAULT '',
                check_standard TEXT NOT NULL DEFAULT '',
                precautions TEXT NOT NULL DEFAULT '',
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(20) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        # 旧表迁移：每条 ALTER 独立执行，避免 asyncpg 不支持多命令 prepared statement
        cur.execute("ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS knowledge_type VARCHAR(32) NOT NULL DEFAULT 'fault'")
        cur.execute("ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS operation_category VARCHAR(120) NOT NULL DEFAULT ''")
        cur.execute("ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS operation_item TEXT NOT NULL DEFAULT ''")
        cur.execute("ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS operation_steps TEXT NOT NULL DEFAULT ''")
        cur.execute("ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS check_standard TEXT NOT NULL DEFAULT ''")
        cur.execute("ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS precautions TEXT NOT NULL DEFAULT ''")
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
            WHERE COALESCE(knowledge_type, 'fault') = 'fault'
            """
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_items_maintenance_unique
            ON knowledge_items (pipeline, machine, operation_item)
            WHERE COALESCE(knowledge_type, 'fault') = 'maintenance'
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
    print(f"[EXTRACT] extract_knowledge_items_with_ai 开始 pipeline={pipeline} doc_ids={doc_ids} replace={replace}", flush=True)
    with psycopg2.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        user=settings.DB_USER,
        password=settings.DB_PASSWORD,
        database=settings.DB_NAME,
    ) as conn:
        _ensure_items_table(conn)
        print(f"[EXTRACT] 数据库表已确保存在", flush=True)
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
        print(f"[EXTRACT] 查询到 {len(rows)} 个文档", flush=True)
        for doc_id, filename, original_path, content in rows:
            device = _infer_device_from_filename(filename)
            items: list[dict] = []
            provider = "rule-fallback"
            trace_id = str(doc_id)
            print(f"[EXTRACT] 处理文档 doc_id={doc_id} filename={filename} 内容长度={len(content or '')}", flush=True)
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
                        print(f"[EXTRACT] replace 模式删除旧条目 doc_id={doc_id} before_count={before_cnt}", flush=True)
                except Exception as e:
                    errors.append(f"{filename}: replace_delete_failed: {str(e)[:200]}")
                    conn.rollback()
            try:
                template_items = _extract_structured_template_items(content_for_extract)
                if template_items:
                    items = template_items
                    provider = "structured-template"
                    print(f"[EXTRACT] 命中结构化模板 doc_id={doc_id} items={len(items)}", flush=True)
                elif _is_maintenance_manual(filename):
                    print(f"[EXTRACT] 识别为维修手册 doc_id={doc_id}", flush=True)
                    items, provider = await _extract_maintenance_manual_items_with_llm(filename, content_for_extract)
                    print(f"[EXTRACT] 维修手册 LLM 抽取完成 doc_id={doc_id} items={len(items)} provider={provider}", flush=True)
                    if not items:
                        items = _extract_maintenance_rule_items(content_for_extract, filename)
                        provider = "maintenance-rule" if items else provider
                        print(f"[EXTRACT] 维修手册规则回退抽取 doc_id={doc_id} items={len(items)} provider={provider}", flush=True)
                elif _is_video_file(filename):
                    items, provider = await _extract_video_items_with_llm(filename, content_for_extract)
                    print(f"[EXTRACT] 视频抽取完成 doc_id={doc_id} items={len(items)} provider={provider}", flush=True)
                elif _is_standard_doc(filename, content):
                    items, provider = await _extract_standard_items_with_llm(filename, content_for_extract)
                    if not items:
                        items = _extract_standard_rule_items(filename, content_for_extract)
                        provider = "standard-rule" if items else provider
                    print(f"[EXTRACT] 标准文档抽取完成 doc_id={doc_id} items={len(items)} provider={provider}", flush=True)
                else:
                    items, provider = await _extract_items_with_llm(filename, content_for_extract)
                    print(f"[EXTRACT] 通用抽取完成 doc_id={doc_id} items={len(items)} provider={provider}", flush=True)
            except Exception as e:
                errors.append(f"{filename}: ai_extract_failed: {str(e)[:200]}")
                items = []
                print(f"[EXTRACT] 抽取异常 doc_id={doc_id} err={str(e)[:200]}", flush=True)
            if items:
                used_provider = provider or used_provider
                extracted += len(items)
            else:
                if _is_video_file(filename):
                    continue
                # 优先用维修手册规程抽取器
                maintenance_items = _extract_maintenance_rule_items(content, filename)
                if maintenance_items:
                    items = maintenance_items
                    provider = "maintenance-rule"
                    used_provider = provider
                    extracted += len(items)
                    print(f"[EXTRACT] 通用回退到 maintenance-rule doc_id={doc_id} items={len(items)}", flush=True)
                else:
                    pairs = _extract_pairs(content)
                    if not pairs:
                        print(f"[EXTRACT] 未抽取到任何条目 doc_id={doc_id}", flush=True)
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
                    provider = "rule-fallback"
                    used_provider = provider
                    extracted += len(items)
                    print(f"[EXTRACT] 通用回退到 rule-fallback doc_id={doc_id} items={len(items)}", flush=True)
            try:
                with conn.cursor() as cur:
                    inserted_delta = 0
                    skipped_invalid = 0
                    for it in items:
                        # ... 原有插入逻辑不变
                        pipeline_value = pipeline
                        machine = str(it.get("machine") or device).strip() or device
                        machine_category = _canonicalize_machine_category(it.get("machine_category"), machine) or _infer_machine_category(machine)
                        knowledge_type = str(it.get("knowledge_type") or "fault").strip().lower()

                        if knowledge_type == "maintenance":
                            operation_category = str(it.get("operation_category") or "").strip() or "维护"
                            operation_item = str(it.get("operation_item") or "").strip()
                            operation_steps = str(it.get("operation_steps") or "").strip()
                            check_standard = str(it.get("check_standard") or "").strip()
                            precautions = str(it.get("precautions") or "").strip()
                            if not operation_item:
                                skipped_invalid += 1
                                continue
                            cur.execute(
                                """
                                INSERT INTO knowledge_items (
                                    pipeline, machine_category, machine,
                                    problem_category, problem, root_cause, solution,
                                    knowledge_type, operation_category, operation_item,
                                    operation_steps, check_standard, precautions,
                                    metadata, status
                                )
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'active')
                                ON CONFLICT (pipeline, machine, operation_item) WHERE COALESCE(knowledge_type, 'fault') = 'maintenance' DO UPDATE
                                SET operation_category = EXCLUDED.operation_category,
                                    operation_steps = EXCLUDED.operation_steps,
                                    check_standard = EXCLUDED.check_standard,
                                    precautions = EXCLUDED.precautions,
                                    metadata = EXCLUDED.metadata,
                                    updated_at = NOW()
                                """,
                                (
                                    pipeline_value,
                                    machine_category,
                                    machine,
                                    "",  # problem_category
                                    "",  # problem
                                    "",  # root_cause
                                    "",  # solution
                                    knowledge_type,
                                    operation_category,
                                    operation_item,
                                    operation_steps,
                                    check_standard,
                                    precautions,
                                    psycopg2.extras.Json(
                                        {
                                            "doc_id": doc_id,
                                            "filename": filename,
                                            "source": "ai_extract" if provider != "rule-fallback" else "rule_fallback",
                                            "provider": provider,
                                            "template_pipeline": str(it.get("pipeline") or "").strip(),
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
                                WHERE pipeline = %s AND machine = %s AND operation_item = %s
                                ON CONFLICT (item_id) DO NOTHING
                                """,
                                (pipeline_value, machine, operation_item),
                            )
                        else:
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
                                INSERT INTO knowledge_items (
                                    pipeline, machine_category, machine, problem_category,
                                    problem, root_cause, solution, knowledge_type, metadata, status
                                )
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'active')
                                ON CONFLICT (pipeline, machine, problem, root_cause) WHERE COALESCE(knowledge_type, 'fault') = 'fault' DO UPDATE
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
                                    knowledge_type,
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
                    print(f"[EXTRACT] 数据库插入完成 doc_id={doc_id} inserted_delta={inserted_delta} skipped_invalid={skipped_invalid}", flush=True)
            except Exception as e:
                errors.append(f"{filename}: {str(e)}")
                conn.rollback()
                print(f"[EXTRACT] 数据库插入失败 doc_id={doc_id} err={str(e)[:250]}", flush=True)
    skipped = max(0, extracted - inserted)
    print(f"[EXTRACT] extract_knowledge_items_with_ai 结束 extracted={extracted} inserted={inserted} skipped={skipped} provider={used_provider}", flush=True)
    return AIExtractResult(extracted=extracted, inserted=inserted, skipped=skipped, provider=used_provider, errors=errors)

