from models.schemas import FaultTree
from core.fta.builder import compute_mcs

def compute_importance(fault_tree: FaultTree) -> list[dict]:
    """计算底事件Birnbaum结构重要度"""
    mcs_list = compute_mcs(fault_tree)
    basic_nodes = [n.id for n in fault_tree.nodes if n.type == "basic"]

    importance = {}
    total = len(mcs_list) if mcs_list else 1

    for node_id in basic_nodes:
        count = sum(1 for mcs in mcs_list if node_id in mcs)
        importance[node_id] = round(count / total, 4)

    node_map = {n.id: n.name for n in fault_tree.nodes}
    result = [
        {"node_id": nid, "name": node_map.get(nid, nid), "importance": score}
        for nid, score in sorted(importance.items(), key=lambda x: -x[1])
    ]
    return result
