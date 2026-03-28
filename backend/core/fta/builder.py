import networkx as nx
from backend.models.schemas import FaultTree, FTANode, FTAGate

def build_graph(fault_tree: FaultTree) -> nx.DiGraph:
    """将故障树JSON转为有向图"""
    G = nx.DiGraph()
    for node in fault_tree.nodes:
        G.add_node(node.id, **node.model_dump())
    for gate in fault_tree.gates:
        for input_node in gate.input_nodes:
            G.add_edge(gate.output_node, input_node, gate_id=gate.id, gate_type=gate.type)
    return G

def compute_mcs(fault_tree: FaultTree) -> list[list[str]]:
    """MOCUS算法计算最小割集"""
    G = build_graph(fault_tree)
    top = fault_tree.top_event

    gate_map = {g.output_node: g for g in fault_tree.gates}
    basic_nodes = {n.id for n in fault_tree.nodes if n.type == "basic"}

    def expand(node_id: str) -> list[list[str]]:
        if node_id in basic_nodes:
            return [[node_id]]
        if node_id not in gate_map:
            return [[node_id]]
        gate = gate_map[node_id]
        children = [expand(c) for c in gate.input_nodes]
        if gate.type == "OR":
            result = []
            for child in children:
                result.extend(child)
            return result
        else:  # AND
            result = [[]]
            for child in children:
                new_result = []
                for existing in result:
                    for c in child:
                        new_result.append(existing + c)
                result = new_result
            return result

    raw = expand(top)
    # 去重 + 去超集
    sets = [frozenset(s) for s in raw]
    minimal = []
    for s in sets:
        if not any(m < s for m in minimal):
            minimal = [m for m in minimal if not s < m]
            minimal.append(s)
    return [sorted(list(s)) for s in minimal]


def restructure_fault_tree(ft: FaultTree) -> FaultTree:
    """
    对扁平结构进行分层归类，保证存在多层分类：
    - 若顶事件下直接挂了大量 basic 节点，则按领域归为中间事件（电源/控制/机械/液压/环境/其他）
    - 仅在同类 >= 2 个时才创建中间层，避免无意义分组
    """
    if not ft or not ft.nodes or not ft.gates:
        return ft

    node_map = {n.id: n for n in ft.nodes}
    top_nodes = [n for n in ft.nodes if n.type == "top"]
    top_id = top_nodes[0].id if top_nodes else None
    if not top_id:
        return ft

    gate_map = {g.output_node: g for g in ft.gates}
    top_gate = gate_map.get(top_id)
    if not top_gate:
        return ft

    # 顶层直接挂的 basic
    direct_children = list(top_gate.input_nodes)
    basic_children = [cid for cid in direct_children if node_map.get(cid, FTANode(id="", type="basic", name="", description="")).type == "basic"]
    if len(basic_children) < 4:
        return ft

    # 关键词归类
    buckets = {
        "电源与供电": ["电源", "供电", "电压", "缺相", "短路", "过载", "保险", "熔断", "接触器", "继电器"],
        "控制与通讯": ["控制", "通讯", "网络", "PLC", "参数", "地址", "波特率", "配置"],
        "机械本体": ["机械", "轴承", "转子", "联轴器", "卡滞", "卡死", "振动", "磨损"],
        "液压气动": ["液压", "油", "泵", "阀", "缸", "气压", "泄漏", "过滤"],
        "环境与外部": ["环境", "温度", "湿度", "灰尘", "外部", "干扰"],
    }

    def classify(name: str, desc: str):
        txt = f"{name} {desc}".lower()
        for cat, kws in buckets.items():
            for kw in kws:
                if kw.lower() in txt:
                    return cat
        return "其他"

    grouped: dict[str, list[str]] = {}
    for cid in basic_children:
        n = node_map.get(cid)
        if not n:
            continue
        cat = classify(n.name or "", n.description or "")
        grouped.setdefault(cat, []).append(cid)

    # 仅保留同类 >= 2 的类别，其余保持直连；"其他"若 >=2 也分组
    grouped = {k: v for k, v in grouped.items() if len(v) >= 2}
    if not grouped:
        return ft

    # 生成新中间节点ID
    def next_node_id():
        max_num = 0
        for nid in node_map.keys():
            digits = "".join(ch for ch in nid if ch.isdigit())
            if digits:
                try:
                    max_num = max(max_num, int(digits))
                except Exception:
                    pass
        i = max_num + 1
        while True:
            nid = f"N{i:03d}"
            if nid not in node_map:
                return nid
            i += 1

    # 更新顶层 gate：移除已分组的 basic，新增中间节点
    new_nodes: list[FTANode] = []
    new_gates: list[FTAGate] = []

    for cat, children in grouped.items():
        mid_id = next_node_id()
        new_nodes.append(FTANode(id=mid_id, type="intermediate", name=cat, description=f"{cat}相关故障归类", source_ref=None))
        # 新增 gate（OR）
        new_gates.append(FTAGate(id=f"G_{mid_id}", type="OR", output_node=mid_id, input_nodes=children))
        # 顶层 gate 加入中间节点
        top_gate.input_nodes.append(mid_id)
        # 顶层 gate 移除原 basic
        top_gate.input_nodes = [i for i in top_gate.input_nodes if i not in children]

    # 合并到结果
    ft.nodes.extend(new_nodes)
    ft.gates.extend(new_gates)
    return ft
