"""
YOLO 目标检测器核心模块
基于 Ultralytics YOLO 实现，支持图片/视频流识别、结果标注等功能
"""

import io
import time
import logging
from pathlib import Path
from typing import List, Optional, Union, Tuple
from dataclasses import dataclass, field
from enum import Enum

import numpy as np
import cv2
from PIL import Image

# 配置日志
logger = logging.getLogger(__name__)


class DeviceType(Enum):
    """设备类型枚举"""
    CUDA = "cuda"
    CPU = "cpu"
    MPS = "mps"  # Apple Silicon


@dataclass
class DetectionBox:
    """检测框"""
    class_id: int
    class_name: str
    confidence: float
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2
    
    def __post_init__(self):
        # 计算面积和面积占比
        x1, y1, x2, y2 = self.bbox
        self.area = (x2 - x1) * (y2 - y1)
        self.x, self.y, self.w, self.h = x1, y1, x2 - x1, y2 - y1


@dataclass
class DetectionResult:
    """检测结果"""
    detections: List[DetectionBox] = field(default_factory=list)
    image_width: int = 0
    image_height: int = 0
    process_time_ms: float = 0
    total_detections: int = 0
    anomaly_count: int = 0
    overall_status: str = "normal"  # normal, warning, critical
    
    # 异常类别定义（需要根据实际模型调整）
    ANOMALY_CLASSES = {'abnormal', 'fault', 'damage', 'corrosion', 'crack', 'leakage', 'overheat', 'wear'}
    
    def __post_init__(self):
        self.total_detections = len(self.detections)
        self.anomaly_count = sum(1 for d in self.detections if self._is_anomaly(d))
        
        # 判断整体状态
        if self.anomaly_count == 0:
            self.overall_status = "normal"
        elif self.anomaly_count <= 2:
            self.overall_status = "warning"
        else:
            self.overall_status = "critical"
    
    def _is_anomaly(self, detection: DetectionBox) -> bool:
        """判断是否为异常"""
        # 检查类别名是否包含异常关键词
        name_lower = detection.class_name.lower()
        for keyword in self.ANOMALY_CLASSES:
            if keyword in name_lower:
                return True
        # 检查是否以 abnormal 开头
        return name_lower.endswith('abnormal') or name_lower.endswith('fault')


class YOLODetector:
    """
    YOLO 目标检测器
    
    支持功能：
    - 单张图片检测
    - 批量图片检测
    - 图片标注
    - GPU/CPU 切换
    - TensorRT 优化（可选）
    """
    
    # 类别颜色映射 (BGR格式)
    CLASS_COLORS = {
        'normal': (0, 255, 0),      # 绿色
        'abnormal': (0, 0, 255),    # 红色
        'warning': (0, 165, 255),   # 橙色
        'default': (255, 0, 0),     # 蓝色
    }
    
    def __init__(
        self,
        model_path: str = "yolo11m.pt",
        device: str = "cuda",  # 默认使用 GPU
        conf_threshold: float = 0.25,
        iou_threshold: float = 0.45,
        img_size: int = 640,
        half: bool = True,  # GPU 下启用半精度加速
        verbose: bool = False
    ):
        """
        初始化检测器
        
        Args:
            model_path: 模型文件路径 (.pt, .onnx, .engine)
            device: 计算设备 ("cuda", "cpu", "mps")
            conf_threshold: 置信度阈值
            iou_threshold: NMS IOU 阈值
            img_size: 输入图片尺寸
            half: 是否使用半精度推理
            verbose: 是否输出详细日志
        """
        self.model_path = model_path
        self.device = self._validate_device(device)
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold
        self.img_size = img_size
        self.half = half and self.device == DeviceType.CUDA
        self.verbose = verbose
        
        self.model = None
        self.class_names = {}
        self._is_loaded = False
        
        # 统计信息
        self.inference_count = 0
        self.total_inference_time = 0
        
        logger.info(f"YOLODetector initialized: device={self.device.value}, conf={conf_threshold}")
    
    def _validate_device(self, device: str) -> DeviceType:
        """验证并返回有效的设备类型"""
        if device == "cuda":
            if not self._check_cuda_available():
                logger.warning("CUDA not available, falling back to CPU")
                return DeviceType.CPU
            return DeviceType.CUDA
        elif device == "mps":
            return DeviceType.MPS
        else:
            return DeviceType.CPU
    
    def _check_cuda_available(self) -> bool:
        """检查 CUDA 是否可用"""
        try:
            import torch
            return torch.cuda.is_available()
        except ImportError:
            return False
    
    def load(self) -> bool:
        """
        加载模型
        
        Returns:
            是否加载成功
        """
        if self._is_loaded:
            return True
        
        try:
            from ultralytics import YOLO
            
            # 确定设备字符串
            device_str = self.device.value
            if self.device == DeviceType.CUDA:
                device_str = "0" if torch.cuda.device_count() > 0 else "cpu"
            
            # 加载模型
            self.model = YOLO(self.model_path)
            
            # 设置设备
            if self.device == DeviceType.CUDA:
                self.model.to('cuda')
            
            # 获取类别名称
            if hasattr(self.model, 'names'):
                self.class_names = self.model.names
            
            self._is_loaded = True
            logger.info(f"Model loaded successfully: {self.model_path}")
            
            # 预热模型
            self.warmup()
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            self._is_loaded = False
            return False
    
    def warmup(self, warmup_runs: int = 3):
        """
        预热模型
        
        Args:
            warmup_runs: 预热次数
        """
        if not self._is_loaded or self.model is None:
            return
        
        logger.info(f"Warming up model ({warmup_runs} runs)...")
        
        try:
            # 创建dummy图片进行预热
            dummy_img = np.zeros((self.img_size, self.img_size, 3), dtype=np.uint8)
            
            for _ in range(warmup_runs):
                self.model(dummy_img, verbose=False, conf=self.conf_threshold, iou=self.iou_threshold)
            
            logger.info("Model warmup completed")
            
        except Exception as e:
            logger.warning(f"Warmup failed: {e}")
    
    def detect(self, image: Union[np.ndarray, str, bytes]) -> DetectionResult:
        """
        执行目标检测
        
        Args:
            image: 输入图片 (numpy数组/文件路径/字节数据)
            
        Returns:
            DetectionResult: 检测结果
        """
        start_time = time.time()
        
        # 加载模型
        if not self.load():
            raise RuntimeError("Failed to load model")
        
        # 读取图片
        img_array = self._read_image(image)
        if img_array is None:
            raise ValueError("Failed to read image")
        
        h, w = img_array.shape[:2]
        
        # 执行检测
        try:
            results = self.model(
                img_array,
                verbose=self.verbose,
                conf=self.conf_threshold,
                iou=self.iou_threshold,
                imgsz=self.img_size
            )
            
            # 解析结果
            detections = []
            if results and len(results) > 0:
                result = results[0]
                if result.boxes is not None:
                    boxes = result.boxes.cpu().numpy()
                    
                    for box in boxes:
                        class_id = int(box.cls)
                        confidence = float(box.conf[0])
                        bbox = box.xyxy[0].astype(int).tolist()  # x1, y1, x2, y2
                        
                        class_name = self.class_names.get(class_id, f"class_{class_id}")
                        
                        detections.append(DetectionBox(
                            class_id=class_id,
                            class_name=class_name,
                            confidence=confidence,
                            bbox=tuple(bbox)
                        ))
            
            # 计算处理时间
            process_time = (time.time() - start_time) * 1000
            
            # 更新统计
            self.inference_count += 1
            self.total_inference_time += process_time
            
            result = DetectionResult(
                detections=detections,
                image_width=w,
                image_height=h,
                process_time_ms=process_time
            )
            
            if self.verbose:
                logger.info(f"Detection completed: {result.total_detections} objects in {process_time:.1f}ms")
            
            return result
            
        except Exception as e:
            logger.error(f"Detection failed: {e}")
            raise
    
    def detect_batch(self, images: List[Union[np.ndarray, str, bytes]]) -> List[DetectionResult]:
        """
        批量检测
        
        Args:
            images: 图片列表
            
        Returns:
            检测结果列表
        """
        return [self.detect(img) for img in images]
    
    def annotate_image(
        self,
        image: Union[np.ndarray, str, bytes],
        result: Optional[DetectionResult] = None,
        show_confidence: bool = True,
        show_class: bool = True,
        thickness: int = 2,
        font_scale: float = 0.5
    ) -> np.ndarray:
        """
        标注图片
        
        Args:
            image: 原始图片
            result: 检测结果（如果为None，会先执行检测）
            show_confidence: 是否显示置信度
            show_class: 是否显示类别名
            thickness: 边框粗细
            font_scale: 字体大小
            
        Returns:
            标注后的图片 (numpy数组)
        """
        # 读取原始图片
        img_array = self._read_image(image)
        if img_array is None:
            raise ValueError("Failed to read image")
        
        # 如果没有提供检测结果，先执行检测
        if result is None:
            result = self.detect(img_array)
        
        # 复制图片用于标注
        annotated = img_array.copy()
        
        # 绘制检测框
        for detection in result.detections:
            x1, y1, x2, y2 = detection.bbox
            
            # 获取颜色
            color = self._get_detection_color(detection.class_name)
            
            # 绘制边框
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, thickness)
            
            # 准备标签文本
            label_parts = []
            if show_class:
                label_parts.append(detection.class_name)
            if show_confidence:
                label_parts.append(f"{detection.confidence:.2f}")
            
            if label_parts:
                label = " ".join(label_parts)
                
                # 计算标签背景
                (label_w, label_h), baseline = cv2.getTextSize(
                    label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 1
                )
                
                # 绘制标签背景
                cv2.rectangle(
                    annotated,
                    (x1, y1 - label_h - baseline - 5),
                    (x1 + label_w, y1),
                    color,
                    -1  # 填充
                )
                
                # 绘制标签文字
                cv2.putText(
                    annotated,
                    label,
                    (x1, y1 - baseline - 2),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    font_scale,
                    (255, 255, 255),  # 白色文字
                    1
                )
        
        # 添加统计信息
        self._add_stats_overlay(annotated, result)
        
        return annotated
    
    def _get_detection_color(self, class_name: str) -> Tuple[int, int, int]:
        """获取检测类别对应的颜色"""
        name_lower = class_name.lower()
        
        if 'normal' in name_lower:
            return self.CLASS_COLORS['normal']
        elif 'abnormal' in name_lower or 'fault' in name_lower:
            return self.CLASS_COLORS['abnormal']
        elif 'warning' in name_lower:
            return self.CLASS_COLORS['warning']
        else:
            return self.CLASS_COLORS['default']
    
    def _add_stats_overlay(self, image: np.ndarray, result: DetectionResult):
        """在图片角落添加统计信息"""
        # 统计信息背景
        h, w = image.shape[:2]
        padding = 10
        stats_height = 80
        
        # 绘制半透明背景
        overlay = image.copy()
        cv2.rectangle(overlay, (w - 200 - padding, padding), (w - padding, padding + stats_height), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.6, image, 0.4, 0, image)
        
        # 添加文字
        stats = [
            f"检测数: {result.total_detections}",
            f"异常数: {result.anomaly_count}",
            f"耗时: {result.process_time_ms:.0f}ms",
            f"状态: {result.overall_status}"
        ]
        
        y_offset = padding + 15
        for stat in stats:
            cv2.putText(image, stat, (w - 195, y_offset), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
            y_offset += 18
    
    def _read_image(self, image: Union[np.ndarray, str, bytes]) -> Optional[np.ndarray]:
        """读取图片为numpy数组"""
        try:
            if isinstance(image, np.ndarray):
                return image
            elif isinstance(image, str):
                # 文件路径
                if not Path(image).exists():
                    logger.error(f"Image file not found: {image}")
                    return None
                img = cv2.imread(image)
                return img
            elif isinstance(image, bytes):
                # 字节数据
                nparr = np.frombuffer(image, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                return img
            else:
                return None
        except Exception as e:
            logger.error(f"Failed to read image: {e}")
            return None
    
    def get_stats(self) -> dict:
        """获取统计信息"""
        avg_time = self.total_inference_time / self.inference_count if self.inference_count > 0 else 0
        return {
            "inference_count": self.inference_count,
            "total_inference_time_ms": self.total_inference_time,
            "average_inference_time_ms": avg_time,
            "is_loaded": self._is_loaded,
            "device": self.device.value,
            "model_path": self.model_path
        }
    
    def __del__(self):
        """清理资源"""
        if self.model is not None:
            try:
                del self.model
                if self.device == DeviceType.CUDA:
                    import torch
                    torch.cuda.empty_cache()
            except:
                pass


# 导入 torch 用于 CUDA 检查
try:
    import torch
except ImportError:
    pass


import os

# 项目根目录
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_MODEL_PATH = os.path.join(PROJECT_ROOT, "data", "models", "yolo11m.pt")

# 全局检测器实例（延迟加载）
_detector_instance: Optional[YOLODetector] = None


def get_detector(
    model_path: str = None,
    device: str = "cuda",
    conf_threshold: float = 0.25,
    **kwargs
) -> YOLODetector:
    """
    获取全局检测器实例（单例模式）
    
    Args:
        model_path: 模型路径（默认使用 data/models/yolo11m.pt）
        device: 设备类型
        conf_threshold: 置信度阈值
        
    Returns:
        YOLODetector 实例
    """
    global _detector_instance
    
    # 使用默认模型路径
    if model_path is None:
        model_path = DEFAULT_MODEL_PATH
        # 如果默认路径不存在，尝试使用 yolo11m.pt（ultralytics会自动下载）
        if not os.path.exists(model_path):
            logger.warning(f"Model not found at {model_path}, will use default yolo11m.pt")
            model_path = "yolo11m.pt"
    
    if _detector_instance is None:
        _detector_instance = YOLODetector(
            model_path=model_path,
            device=device,
            conf_threshold=conf_threshold,
            **kwargs
        )
        _detector_instance.load()
    
    return _detector_instance


def reset_detector():
    """重置全局检测器实例"""
    global _detector_instance
    if _detector_instance is not None:
        del _detector_instance
    _detector_instance = None
