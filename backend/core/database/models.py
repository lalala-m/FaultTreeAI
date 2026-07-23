"""
SQLAlchemy ORM 模型 — 对应 PostgreSQL Schema
所有表通过 connection.py 的 init_db() 自动创建
"""

import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Text, Integer, Float, BigInteger,
    Boolean, DateTime, ForeignKey, Index, JSON
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from pgvector.sqlalchemy import Vector
from backend.config import settings
from .connection import Base


class Document(Base):
    """原始文档元数据表"""
    __tablename__ = "documents"

    doc_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    filename = Column(String(255), nullable=False)
    file_size = Column(BigInteger)
    file_type = Column(String(20), nullable=False)
    upload_time = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(String(20), nullable=False, default="active")
    metadata_ = Column("metadata", JSONB, default={})

    chunks = relationship("DocumentChunk", back_populates="document", cascade="all, delete-orphan")
    fault_trees = relationship("FaultTree", back_populates="document")

    __table_args__ = (
        Index("idx_documents_status", "status"),
        Index("idx_documents_upload_time", "upload_time"),
    )


class DocumentChunk(Base):
    """文档分块文本表"""
    __tablename__ = "document_chunks"

    chunk_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_id = Column(UUID(as_uuid=True), ForeignKey("documents.doc_id", ondelete="CASCADE"), nullable=False)
    chunk_index = Column(Integer, nullable=False)
    page_num = Column(Integer, default=0)
    text = Column(Text, nullable=False)
    token_count = Column(Integer)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    document = relationship("Document", back_populates="chunks")
    embedding = relationship(
        "ChunkEmbedding",
        back_populates="chunk",
        uselist=False,
        cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("idx_chunks_doc_id", "doc_id"),
    )


class ChunkEmbedding(Base):
    """向量存储表（pgvector）"""
    __tablename__ = "chunk_embeddings"

    embedding_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chunk_id = Column(
        UUID(as_uuid=True),
        ForeignKey("document_chunks.chunk_id", ondelete="CASCADE"),
        nullable=False,
        unique=True
    )
    doc_id = Column(UUID(as_uuid=True), ForeignKey("documents.doc_id", ondelete="CASCADE"), nullable=False)
    embedding = Column(Vector(settings.EMBED_DIM), nullable=False)
    model_name = Column(String(50), nullable=False, default=settings.EMBED_MODEL)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    chunk = relationship("DocumentChunk", back_populates="embedding")

    __table_args__ = (
        Index(
            "idx_chunk_embeddings_hnsw",
            embedding,
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"}
        ),
        Index("idx_chunk_embeddings_doc_id", "doc_id"),
    )


class FaultTree(Base):
    """故障树存储表"""
    __tablename__ = "fault_trees"

    tree_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doc_id = Column(UUID(as_uuid=True), ForeignKey("documents.doc_id", ondelete="SET NULL"))
    top_event = Column(String(500), nullable=False)
    user_prompt = Column(Text)
    nodes_json = Column(JSONB, nullable=False)
    gates_json = Column(JSONB, nullable=False)
    confidence = Column(Float)
    analysis_summary = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    created_by = Column(String(100), default="system")
    is_valid = Column(Boolean, default=None)
    mcs_json = Column(JSONB)

    document = relationship("Document", back_populates="fault_trees")
    validation_logs = relationship("ValidationLog", back_populates="fault_tree", cascade="all, delete-orphan")

    __table_args__ = (
        Index(
            "uq_tree_top_doc",
            "top_event", "doc_id",
            unique=True,
            postgresql_where=doc_id.isnot(None)
        ),
        Index("idx_fault_trees_top_event", "top_event"),
        Index("idx_fault_trees_created_at", "created_at"),
    )


class ClarifyCache(Base):
    """Clarify 问题缓存表：相同 top_event 复用历史问题"""
    __tablename__ = "clarify_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)
    top_event = Column(Text, nullable=False, unique=True)
    questions = Column(JSONB, nullable=False, default=[])
    raw_intro = Column(Text)
    refined_query_hint = Column(Text)
    provider = Column(String(100))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_clarify_cache_top_event", "top_event"),
    )


class DiagnosisCase(Base):
    """诊断案例表：top_event + clarify 答案 → 排查步骤 + 可选故障树 + 原因权重"""
    __tablename__ = "diagnosis_cases"

    case_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    top_event = Column(Text, nullable=False)
    questions = Column(JSONB, nullable=False, default=[])
    answers = Column(JSONB, nullable=False, default={})
    answers_hash = Column(String(64), nullable=False)
    tree_id = Column(UUID(as_uuid=True), ForeignKey("fault_trees.tree_id", ondelete="CASCADE"), nullable=True)
    cause_weights = Column(JSONB, nullable=False, default={})
    steps_json = Column(JSONB, nullable=False, default=[])
    messages_json = Column(JSONB, nullable=False, default=[])
    hit_count = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    fault_tree = relationship("FaultTree", backref="diagnosis_cases")

    __table_args__ = (
        Index("idx_diagnosis_cases_top_event", "top_event"),
        Index("idx_diagnosis_cases_hash", "answers_hash"),
        Index("idx_diagnosis_cases_top_hash", "top_event", "answers_hash"),
    )


class ValidationLog(Base):
    """校验日志表"""
    __tablename__ = "validation_logs"

    log_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tree_id = Column(UUID(as_uuid=True), ForeignKey("fault_trees.tree_id", ondelete="CASCADE"), nullable=False)
    validation_type = Column(String(50), nullable=False)
    node_id = Column(String(50))
    issue_level = Column(String(20), nullable=False)
    description = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    fault_tree = relationship("FaultTree", back_populates="validation_logs")

    __table_args__ = (
        Index("idx_validation_logs_tree_id", "tree_id"),
    )


class Session(Base):
    """会话记录表"""
    __tablename__ = "sessions"

    session_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tree_id = Column(UUID(as_uuid=True), ForeignKey("fault_trees.tree_id", ondelete="SET NULL"))
    messages = Column(JSONB, nullable=False, default=[])
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FaultTreeFeedback(Base):
    """故障树反馈记录表 - 记录专家修改"""
    __tablename__ = "fault_tree_feedbacks"

    feedback_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tree_id = Column(UUID(as_uuid=True), ForeignKey("fault_trees.tree_id", ondelete="CASCADE"), nullable=False)
    original_nodes = Column(JSONB, nullable=False)  # 修改前的节点
    modified_nodes = Column(JSONB, nullable=False)  # 修改后的节点
    original_gates = Column(JSONB, nullable=False)  # 修改前的逻辑门
    modified_gates = Column(JSONB, nullable=False)  # 修改后的逻辑门
    feedback_type = Column(String(20), nullable=False, default="edit")  # edit/add/delete
    feedback_reason = Column(Text)  # 修改原因
    status = Column(String(20), nullable=False, default="pending")  # pending/approved/rejected
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    reviewed_at = Column(DateTime(timezone=True))
    reviewed_by = Column(String(100))

    __table_args__ = (
        Index("idx_feedbacks_tree_id", "tree_id"),
        Index("idx_feedbacks_status", "status"),
        Index("idx_feedbacks_created_at", "created_at"),
    )


class ManualBook(Base):
    """规范手册缓存表：按流水线持久化 AI 生成的手册"""
    __tablename__ = "manual_books"

    book_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pipeline = Column(String(120), nullable=False)
    use_ai = Column(Boolean, nullable=False, default=True)
    sections = Column(JSONB, nullable=False, default=[])
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_manual_books_pipeline", "pipeline"),
        Index("idx_manual_books_pipeline_ai", "pipeline", "use_ai"),
    )


# 全局引用 settings（避免循环导入时访问不到）
from backend.config import settings
