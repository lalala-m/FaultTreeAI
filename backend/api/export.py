from fastapi import APIRouter
from fastapi.responses import FileResponse
from models.schemas import FaultTree
from docx import Document
from docx.shared import Pt
import tempfile, os

router = APIRouter()

@router.post("/word")
def export_word(fault_tree: FaultTree):
    doc = Document()
    doc.add_heading("故障树分析报告", 0)

    doc.add_heading("顶事件", level=1)
    doc.add_paragraph(fault_tree.top_event)

    doc.add_heading("分析摘要", level=1)
    doc.add_paragraph(fault_tree.analysis_summary)

    doc.add_heading("节点列表", level=1)
    table = doc.add_table(rows=1, cols=4)
    table.style = "Table Grid"
    hdr = table.rows[0].cells
    hdr[0].text, hdr[1].text, hdr[2].text, hdr[3].text = "ID", "类型", "名称", "描述"
    for node in fault_tree.nodes:
        row = table.add_row().cells
        row[0].text = node.id
        row[1].text = node.type
        row[2].text = node.name
        row[3].text = node.description

    doc.add_heading("逻辑门", level=1)
    for gate in fault_tree.gates:
        doc.add_paragraph(
            f"{gate.id} [{gate.type}]: {gate.output_node} ← {', '.join(gate.input_nodes)}"
        )

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".docx")
    doc.save(tmp.name)
    return FileResponse(tmp.name, filename="故障树分析报告.docx",
                        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
