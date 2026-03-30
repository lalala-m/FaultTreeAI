"""
视觉识别核心模块
提供 YOLO 检测器功能
"""

from .detector import YOLODetector, get_detector, reset_detector, DetectionResult, DetectionBox

__all__ = ['YOLODetector', 'get_detector', 'reset_detector', 'DetectionResult', 'DetectionBox']
