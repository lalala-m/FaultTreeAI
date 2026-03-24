"""
故障树模板管理 API
支持模板列表查询、详情获取
"""

import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from typing import List, Optional

router = APIRouter(tags=["模板管理"])

# 模板目录
TEMPLATES_DIR = Path(__file__).parent.parent.parent / "data" / "templates"


def _load_template(template_id: str) -> dict:
    """加载单个模板文件"""
    template_path = TEMPLATES_DIR / f"{template_id}.json"
    if not template_path.exists():
        raise HTTPException(status_code=404, detail=f"模板不存在: {template_id}")
    with open(template_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_index() -> dict:
    """加载模板索引"""
    index_path = TEMPLATES_DIR / "index.json"
    if not index_path.exists():
        return {"templates": []}
    with open(index_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/list")
async def list_templates() -> dict:
    """
    获取模板列表（简洁信息）
    """
    index = _load_index()
    return index


@router.get("/{template_id}")
async def get_template(template_id: str) -> dict:
    """
    获取模板详情（完整信息）
    """
    template = _load_template(template_id)
    return template


@router.get("/{template_id}/top-events")
async def get_template_top_events(template_id: str) -> List[str]:
    """
    获取模板的预设顶事件列表
    """
    template = _load_template(template_id)
    return template.get("top_events", [])


@router.get("/{template_id}/basic-events")
async def get_template_basic_events(template_id: str) -> List[str]:
    """
    获取模板的常见底事件列表
    """
    template = _load_template(template_id)
    return template.get("common_basic_events", [])
