import fitz  # PyMuPDF
from docx import Document
from pathlib import Path
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=50,
    separators=["\n\n", "\n", "。", "；", " "]
)

def parse_pdf(file_path: str) -> list[dict]:
    doc = fitz.open(file_path)
    chunks = []
    for page_num, page in enumerate(doc):
        text = page.get_text("text").strip()
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
    full_text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
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
