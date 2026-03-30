"""
视觉识别 API 路由
提供图片识别、结果标注等接口
"""

import io
import uuid
import base64
import logging
from pathlib import Path
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# 配置日志
logger = logging.getLogger(__name__)

# 创建路由
router = APIRouter(prefix="/api/vision", tags=["视觉识别"])


# ==================== 数据模型 ====================

class DetectionBoxResponse(BaseModel):
    """检测框响应"""
    class_id: int
    class_name: str
    confidence: float
    bbox: List[int]  # [x1, y1, x2, y2]
    area_ratio: float = 0.0
    is_anomaly: bool = False
    description: str = ""


class DetectionResultResponse(BaseModel):
    """检测结果响应"""
    detection_id: str
    image_width: int
    image_height: int
    process_time_ms: float
    model_name: str
    device: str
    total_detections: int
    anomaly_count: int
    overall_status: str  # normal, warning, critical
    detections: List[DetectionBoxResponse]
    annotated_image: Optional[str] = None  # Base64 编码的标注图片


class BatchDetectionResponse(BaseModel):
    """批量检测响应"""
    success: bool
    total_images: int
    total_detections: int
    total_anomalies: int
    results: List[DetectionResultResponse]


class ModelInfoResponse(BaseModel):
    """模型信息响应"""
    model_name: str
    model_path: str
    device: str
    is_loaded: bool
    inference_count: int
    average_inference_time_ms: float


class DiagnoseRequest(BaseModel):
    """综合诊断请求"""
    vision_result: Optional[str] = None  # 视觉识别结果
    fault_description: Optional[str] = None  # 故障描述
    equipment_type: Optional[str] = None  # 设备类型


class DiagnoseResponse(BaseModel):
    """综合诊断响应"""
    success: bool
    vision_result: Optional[dict] = None
    fault_description: str
    fault_tree: Optional[dict] = None
    recommendations: List[str] = []


# ==================== 辅助函数 ====================

def _serialize_detection_result(result) -> DetectionResultResponse:
    """序列化检测结果"""
    # 计算图片总面积
    if result.image_width > 0 and result.image_height > 0:
        total_area = result.image_width * result.image_height
    else:
        total_area = 1
    
    detections = []
    for det in result.detections:
        area_ratio = det.area / total_area if total_area > 0 else 0
        is_anomaly = det.class_name.lower() in [
            'abnormal', 'fault', 'damage', 'corrosion', 'crack', 'leakage', 'overheat', 'wear'
        ] or 'abnormal' in det.class_name.lower()
        
        # 生成描述
        description = _generate_description(det, is_anomaly)
        
        detections.append(DetectionBoxResponse(
            class_id=det.class_id,
            class_name=det.class_name,
            confidence=det.confidence,
            bbox=list(det.bbox),
            area_ratio=round(area_ratio, 4),
            is_anomaly=is_anomaly,
            description=description
        ))
    
    return DetectionResultResponse(
        detection_id=str(uuid.uuid4()),
        image_width=result.image_width,
        image_height=result.image_height,
        process_time_ms=round(result.process_time_ms, 2),
        model_name="yolo11m",
        device="cuda",
        total_detections=result.total_detections,
        anomaly_count=result.anomaly_count,
        overall_status=result.overall_status,
        detections=detections
    )


def _generate_description(detection, is_anomaly: bool) -> str:
    """生成检测描述"""
    class_name = detection.class_name
    
    if is_anomaly:
        if 'leakage' in class_name.lower():
            return "检测到泄漏痕迹，建议立即检查密封部件"
        elif 'corrosion' in class_name.lower():
            return "检测到腐蚀现象，需要进行防腐处理"
        elif 'crack' in class_name.lower():
            return "检测到裂纹，存在安全隐患"
        elif 'overheat' in class_name.lower():
            return "检测到过热现象，可能导致设备损坏"
        elif 'wear' in class_name.lower():
            return "检测到磨损，建议检查润滑系统"
        else:
            return f"检测到异常: {class_name}，建议进一步检查"
    else:
        return f"设备状态正常: {class_name}"


def _image_to_base64(image_array) -> str:
    """将图片数组转换为Base64"""
    import cv2
    import numpy as np
    
    # 编码为 JPEG
    encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 85]
    _, buffer = cv2.imencode('.jpg', image_array, encode_param)
    
    # 转换为 Base64
    return base64.b64encode(buffer).decode('utf-8')


# ==================== API 路由 ====================

@router.post("/detect/image", response_model=DetectionResultResponse)
async def detect_image(
    file: UploadFile = File(...),
    conf_threshold: float = Form(0.25),
    iou_threshold: float = Form(0.45),
    return_annotated: bool = Form(True),
    device: str = Form("cuda")
):
    """
    上传图片进行目标检测
    
    - **file**: 图片文件 (jpg, png, bmp)
    - **conf_threshold**: 置信度阈值 (0-1)
    - **iou_threshold**: NMS IOU 阈值 (0-1)
    - **return_annotated**: 是否返回标注图片
    - **device**: 计算设备 (cuda/cpu)
    """
    try:
        # 读取图片文件
        contents = await file.read()
        
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file")
        
        # 导入检测器
        from backend.core.vision.detector import get_detector
        
        # 获取或创建检测器
        detector = get_detector(
            device=device,
            conf_threshold=conf_threshold,
            iou_threshold=iou_threshold
        )
        
        # 执行检测
        import numpy as np
        img_array = np.frombuffer(contents, np.uint8)
        import cv2
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        
        result = detector.detect(img)
        
        # 序列化结果
        response = _serialize_detection_result(result)
        
        # 如果需要返回标注图片
        if return_annotated:
            annotated = detector.annotate_image(img, result)
            response.annotated_image = _image_to_base64(annotated)
        
        logger.info(f"Image detection completed: {response.total_detections} objects, {response.anomaly_count} anomalies")
        
        return response
        
    except ImportError as e:
        logger.error(f"Import error: {e}")
        raise HTTPException(status_code=500, detail=f"Model not available: {str(e)}")
    except Exception as e:
        logger.error(f"Detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/detect/batch", response_model=BatchDetectionResponse)
async def detect_batch(
    files: List[UploadFile] = File(...),
    conf_threshold: float = Form(0.25),
    device: str = Form("cuda")
):
    """
    批量图片检测
    
    - **files**: 图片文件列表 (最多 9 张)
    - **conf_threshold**: 置信度阈值
    - **device**: 计算设备
    """
    try:
        if len(files) > 9:
            raise HTTPException(status_code=400, detail="Maximum 9 images allowed")
        
        # 导入检测器
        from backend.core.vision.detector import get_detector
        
        detector = get_detector(device=device, conf_threshold=conf_threshold)
        
        results = []
        total_detections = 0
        total_anomalies = 0
        
        import numpy as np
        import cv2
        
        for file in files:
            # 读取图片
            contents = await file.read()
            if not contents:
                continue
            
            img_array = np.frombuffer(contents, np.uint8)
            img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            
            # 执行检测
            result = detector.detect(img)
            response = _serialize_detection_result(result)
            results.append(response)
            
            total_detections += result.total_detections
            total_anomalies += result.anomaly_count
        
        return BatchDetectionResponse(
            success=True,
            total_images=len(results),
            total_detections=total_detections,
            total_anomalies=total_anomalies,
            results=results
        )
        
    except Exception as e:
        logger.error(f"Batch detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/detect/base64", response_model=DetectionResultResponse)
async def detect_base64(
    image_data: str = Form(...),
    conf_threshold: float = Form(0.25),
    return_annotated: bool = Form(True),
    device: str = Form("cuda")
):
    """
    Base64 编码图片检测
    
    - **image_data**: Base64 编码的图片数据
    - **conf_threshold**: 置信度阈值
    - **return_annotated**: 是否返回标注图片
    - **device**: 计算设备
    """
    try:
        # 解码 Base64
        try:
            image_bytes = base64.b64decode(image_data)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 data")
        
        # 导入检测器
        from backend.core.vision.detector import get_detector
        
        detector = get_detector(device=device, conf_threshold=conf_threshold)
        
        # 执行检测
        import numpy as np
        img_array = np.frombuffer(image_bytes, np.uint8)
        import cv2
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image data")
        
        result = detector.detect(img)
        response = _serialize_detection_result(result)
        
        # 如果需要返回标注图片
        if return_annotated:
            annotated = detector.annotate_image(img, result)
            response.annotated_image = _image_to_base64(annotated)
        
        return response
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Base64 detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/detect/result/{task_id}", response_model=DetectionResultResponse)
async def get_detection_result(task_id: str):
    """
    获取异步检测任务结果（预留接口）
    
    - **task_id**: 任务ID
    """
    # TODO: 实现异步任务结果查询
    raise HTTPException(status_code=501, detail="Async task support not implemented yet")


@router.get("/model/info", response_model=ModelInfoResponse)
async def get_model_info():
    """
    获取当前模型信息
    """
    try:
        from backend.core.vision.detector import get_detector
        
        detector = get_detector()
        stats = detector.get_stats()
        
        return ModelInfoResponse(
            model_name=detector.model_path,
            model_path=detector.model_path,
            device=stats["device"],
            is_loaded=stats["is_loaded"],
            inference_count=stats["inference_count"],
            average_inference_time_ms=round(stats["average_inference_time_ms"], 2)
        )
        
    except Exception as e:
        logger.error(f"Get model info error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/model/stats")
async def get_model_stats():
    """
    获取模型统计信息
    """
    try:
        from backend.core.vision.detector import get_detector
        
        detector = get_detector()
        stats = detector.get_stats()
        
        return JSONResponse(content={
            "success": True,
            "data": stats
        })
        
    except Exception as e:
        logger.error(f"Get stats error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/diagnose", response_model=DiagnoseResponse)
async def diagnose(
    request: DiagnoseRequest
):
    """
    综合诊断（视觉 + 文本描述）
    
    结合视觉识别结果和文本描述，生成故障树建议
    
    - **vision_result**: 视觉识别结果
    - **fault_description**: 故障描述
    - **equipment_type**: 设备类型
    """
    try:
        result = {
            "vision_result": None,
            "fault_description": "",
            "fault_tree": None,
            "recommendations": []
        }
        
        # 处理视觉识别结果
        if request.vision_result:
            result["vision_result"] = {"raw": request.vision_result}
            result["fault_description"] += f"视觉检测: {request.vision_result}\n"
        
        # 处理文本描述
        if request.fault_description:
            if result["fault_description"]:
                result["fault_description"] += "\n"
            result["fault_description"] += f"故障描述: {request.fault_description}"
        
        # 生成推荐建议
        if request.equipment_type:
            result["recommendations"] = _generate_recommendations(request.equipment_type)
        
        # TODO: 调用 LLM 生成故障树
        # 目前返回基础结构
        result["fault_tree"] = {
            "top_event": request.equipment_type or "设备故障",
            "description": result["fault_description"],
            "status": "generated"
        }
        
        return DiagnoseResponse(
            success=True,
            **result
        )
        
    except Exception as e:
        logger.error(f"Diagnose error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _generate_recommendations(equipment_type: str) -> List[str]:
    """生成推荐建议"""
    recommendations = []
    
    type_lower = equipment_type.lower()
    
    if 'motor' in type_lower or '电机' in type_lower:
        recommendations = [
            "检查电机轴承温度和振动",
            "测量电机绝缘电阻",
            "检查电机接线是否松动",
            "观察是否有异常声响"
        ]
    elif 'pump' in type_lower or '泵' in type_lower:
        recommendations = [
            "检查泵的密封情况",
            "测量泵的流量和压力",
            "检查轴承润滑状态",
            "检查入口过滤器是否堵塞"
        ]
    elif 'valve' in type_lower or '阀门' in type_lower:
        recommendations = [
            "检查阀门开关灵活性",
            "检查阀门密封性",
            "测量执行器输出力矩",
            "检查控制信号是否正常"
        ]
    elif 'pipe' in type_lower or '管道' in type_lower:
        recommendations = [
            "检查管道腐蚀情况",
            "测量管道壁厚",
            "检查焊接部位完整性",
            "进行压力测试"
        ]
    else:
        recommendations = [
            "进行全面的视觉检查",
            "测量关键参数",
            "检查安全保护装置",
            "查阅设备维护手册"
        ]
    
    return recommendations


@router.get("/health")
async def health_check():
    """
    健康检查
    """
    try:
        from backend.core.vision.detector import get_detector
        
        detector = get_detector()
        is_loaded = detector._is_loaded
        
        return JSONResponse(content={
            "status": "healthy" if is_loaded else "loading",
            "model_loaded": is_loaded,
            "timestamp": datetime.now().isoformat()
        })
        
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }
        )
