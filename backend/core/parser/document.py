import fitz  # PyMuPDF
from docx import Document
from pathlib import Path
from langchain_text_splitters import RecursiveCharacterTextSplitter
import re

splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=50,
    separators=["\n\n", "\n", "。", "；", " "]
)

def _normalize_table_text(text: str) -> str:
    """
    将“常见故障排查表”类表格整理为可解析的文本形式：
    行内多个空白/制表符视为分隔符，生成 '故障现象 | 可能原因 | 解决方法' 结构。
    """
    if not text:
        return ""
    lines = [re.sub(r"[ \t]{2,}", " | ", ln.rstrip()) for ln in text.splitlines()]
    has_header = any(("故障现象" in ln and "可能原因" in ln and "解决方法" in ln) for ln in lines[:6])
    if has_header:
        return "\n".join(lines)
    return text

def parse_pdf(file_path: str) -> list[dict]:
    doc = fitz.open(file_path)
    chunks = []
    for page_num, page in enumerate(doc):
        text = page.get_text("text").strip()
        # 仅保留 PDF 自带文字层，忽略页面中的图片内容。
        text = _normalize_table_text(text)
        if not text:
            continue
        for i, chunk in enumerate(splitter.split_text(text)):
            chunks.append({
                "text": chunk,
                "source": Path(file_path).name,
                "page": page_num + 1,
                "chunk_index": i
            })
    return chunks

def parse_txt(file_path: str) -> list[dict]:
    text = Path(file_path).read_text(encoding="utf-8", errors="ignore")
    text = _normalize_table_text(text)
    chunks = []
    for i, chunk in enumerate(splitter.split_text(text)):
        chunks.append({
            "text": chunk,
            "source": Path(file_path).name,
            "page": 0,
            "chunk_index": i
        })
    return chunks

def parse_docx(file_path: str) -> list[dict]:
    doc = Document(file_path)
    # 提取段落
    full_text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    # 提取表格并标准化为 'a | b | c' 行
    table_lines = []
    try:
        for tb in doc.tables:
            for row in tb.rows:
                cells = [c.text.strip() for c in row.cells]
                # 合并重复单元格内容
                dedup = []
                for c in cells:
                    if not dedup or c != dedup[-1]:
                        dedup.append(c)
                table_lines.append(" | ".join(dedup))
    except Exception:
        pass
    if table_lines:
        full_text = (full_text + "\n" + "\n".join(table_lines)).strip()
    full_text = _normalize_table_text(full_text)
    chunks = []
    for i, chunk in enumerate(splitter.split_text(full_text)):
        chunks.append({
            "text": chunk,
            "source": Path(file_path).name,
            "page": 0,
            "chunk_index": i
        })
    return chunks

def parse_markdown(file_path: str) -> list[dict]:
    """解析 Markdown 文件"""
    text = Path(file_path).read_text(encoding="utf-8")
    chunks = []
    for i, chunk in enumerate(splitter.split_text(text)):
        chunks.append({
            "text": chunk,
            "source": Path(file_path).name,
            "page": 0,
            "chunk_index": i
        })
    return chunks

def parse_document(file_path: str) -> list[dict]:
    ext = Path(file_path).suffix.lower()
    if ext == ".pdf":
        return parse_pdf(file_path)
    elif ext == ".txt" or ext == ".log":
        return parse_txt(file_path)
    elif ext == ".docx":
        return parse_docx(file_path)
    elif ext == ".md" or ext == ".markdown":
        return parse_markdown(file_path)
    else:
        raise ValueError(f"不支持的文件格式: {ext}")
