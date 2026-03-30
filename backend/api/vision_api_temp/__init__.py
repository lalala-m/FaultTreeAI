"""
视觉识别 API 模块
"""

# 导入父目录中的 vision.py (不是当前目录)
import sys
from pathlib import Path

# 获取父目录并添加路径
_parent_dir = Path(__file__).parent.parent
if str(_parent_dir) not in sys.path:
    sys.path.insert(0, str(_parent_dir))

# 直接导入父目录的 vision 模块
from backend.api.vision import router

__all__ = ['router']
