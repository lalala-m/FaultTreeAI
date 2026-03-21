import networkx as nx
from models.schemas import FaultTree
from core.fta.builder import build_graph

def validate_fault_tree(fault_tree: FaultTree) -> dict:
    """三层逻辑校验，返回问题列表"""
    issues = []
    G = build_graph(fault_tree)
    node_ids = {n.id for n in fault_tree.nodes}
    gate_map = {g.output_node: g for g in fault_tree.gates}

    # 1. 循环依赖检测
    try:
        cycles = list(nx.simple_cycles(G))
        for cycle in cycles:
            issues.append({
                "node_id": cycle[0],
                "reason": f"存在循环依赖: {' → '.join(cycle + [cycle[0]])}",
                "suggestion": f"删除节点 {cycle[-1]} 到 {cycle[0]} 的关联关系"
            })
    except Exception:
        pass

    # 2. 孤立节点检测
    for node in fault_tree.nodes:
        if node.type != "top":
            predecessors = list(G.predecessors(node.id))
            if not predecessors:
                issues.append({
                    "node_id": node.id,
                    "reason": f"节点 '{node.name}' 没有父节点，存在孤立",
                    "suggestion": "将该节点连接到合适的中间事件，或删除该节点"
                })

    # 3. 逻辑门输入数量校验
    for gate in fault_tree.gates:
        if len(gate.input_nodes) < 2:
            issues.append({
                "node_id": gate.output_node,
                "reason": f"逻辑门 {gate.id}({gate.type}) 输入节点少于2个",
                "suggestion": "补充该逻辑门的输入事件，或将其改为直接连接"
            })

    # 4. 底事件不能有子节点
    for node in fault_tree.nodes:
        if node.type == "basic" and node.id in gate_map:
            issues.append({
                "node_id": node.id,
                "reason": f"底事件 '{node.name}' 不应有子节点",
                "suggestion": "将该节点类型改为 intermediate，或删除其子节点"
            })

    return {"is_valid": len(issues) == 0, "issues": issues}
