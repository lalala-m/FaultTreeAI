import networkx as nx
from backend.models.schemas import FaultTree

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
