"""
视觉识别 API 路由
提供图片识别、结果标注等接口
"""

import io
import uuid
import base64
import logging
from pathlib import Path
from typing import List, Optional, Tuple
from datetime import datetime

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# 配置日志
logger = logging.getLogger(__name__)

# 创建路由
router = APIRouter(prefix="/api/vision", tags=["视觉识别"])


# ==================== 数据模型 ====================

@router.get("/capabilities")
async def vision_capabilities():
    cuda_available = False
    cuda_device_count = 0
    torch_version = None
    try:
        import torch
        torch_version = getattr(torch, "__version__", None)
        cuda_available = bool(torch.cuda.is_available())
        cuda_device_count = int(torch.cuda.device_count() or 0)
    except Exception:
        pass
    return {
        "torch_version": torch_version,
        "cuda_available": cuda_available,
        "cuda_device_count": cuda_device_count,
    }

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


def _build_single_classification_response(
    *,
    image_width: int,
    image_height: int,
    process_time_ms: float,
    model_name: str,
    device: str,
    label: str,
    confidence: float,
    is_anomaly: bool,
    description: str,
    overall_status: Optional[str] = None,
    bbox: Optional[List[int]] = None,
) -> DetectionResultResponse:
    status = overall_status or ("normal" if not is_anomaly else "warning")
    if bbox is None:
        bbox = [0, 0, 0, 0]
    area_ratio = 0.0
    try:
        if len(bbox) == 4 and image_width > 0 and image_height > 0:
            x1, y1, x2, y2 = [int(v) for v in bbox]
            if x2 > x1 and y2 > y1:
                area_ratio = ((x2 - x1) * (y2 - y1)) / float(image_width * image_height)
    except Exception:
        area_ratio = 0.0
    return DetectionResultResponse(
        detection_id=str(uuid.uuid4()),
        image_width=image_width,
        image_height=image_height,
        process_time_ms=round(process_time_ms, 2),
        model_name=model_name,
        device=device,
        total_detections=1,
        anomaly_count=1 if is_anomaly else 0,
        overall_status=status,
        detections=[
            DetectionBoxResponse(
                class_id=0,
                class_name=label,
                confidence=float(confidence),
                bbox=bbox,
                area_ratio=round(area_ratio, 4),
                is_anomaly=is_anomaly,
                description=description,
            )
        ],
    )


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

def _serialize_detection_result(result, *, model_name: str, device: str) -> DetectionResultResponse:
    """序列化检测结果"""
    # 计算图片总面积
    if result.image_width > 0 and result.image_height > 0:
        total_area = result.image_width * result.image_height
    else:
        total_area = 1
    
    detections = []
    for det in result.detections:
        area_ratio = det.area / total_area if total_area > 0 else 0
        name_lower = det.class_name.lower()
        is_anomaly = (
            name_lower.startswith(('cable_', 'screw_', 'metal_nut_'))
            or any(k in name_lower for k in [
                'abnormal', 'fault', 'damage', 'corrosion', 'crack', 'leakage', 'overheat', 'wear',
                'scratch', 'bent', 'flip', 'missing', 'cut', 'poke', 'swap', 'combined', 'manipulated', 'thread', 'color',
                'bent_wire', 'missing_wire', 'missing_cable', 'cut_inner_insulation', 'cut_outer_insulation', 'poke_insulation', 'cable_swap',
            ])
        )
        
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
        model_name=model_name,
        device=device,
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

def _resolve_model_key(model_key: Optional[str]) -> Optional[str]:
    if not model_key:
        return None
    key = str(model_key).strip().lower()
    model_map = {
        "yolo11m": None,
        "mvtec_fastener_det": "mvtec_fastener_det.pt",
        "mvtec_multi_det": "mvtec_fastener_det.pt",
    }
    if key not in model_map:
        raise HTTPException(status_code=400, detail=f"Unknown model_key: {model_key}")
    filename = model_map.get(key)
    if filename is None:
        return None
    project_root = Path(__file__).resolve().parents[2]
    p = project_root / "data" / "models" / filename
    if not p.exists():
        raise HTTPException(status_code=503, detail=f"Model file not found: {p}")
    return str(p)


def _auto_hint_to_model_key(auto_hint: Optional[str]) -> Optional[str]:
    if not auto_hint:
        return None
    s = str(auto_hint).strip().lower()
    if not s:
        return None
    if s in {"cable", "wire", "line"}:
        return "wire_break_seg"
    if s in {"screw"}:
        return "mvtec_fastener_det"
    if s in {"metal_nut", "nut"}:
        return "mvtec_fastener_det"
    if s in {"fastener"}:
        return "mvtec_fastener_det"
    if s in {"multi"}:
        return "mvtec_fastener_det"
    return None


def _suppress_overlay_detections(result, *, img_height: int, img_width: int):
    try:
        from backend.core.vision.detector import DetectionResult, DetectionBox
    except Exception:
        return result
    if not result or not getattr(result, "detections", None):
        return result
    h = int(img_height or getattr(result, "image_height", 0) or 0)
    w = int(img_width or getattr(result, "image_width", 0) or 0)
    if h <= 0 or w <= 0:
        return result

    kept = []
    for d in result.detections:
        x1, y1, x2, y2 = d.bbox
        bw = max(0, x2 - x1)
        bh = max(0, y2 - y1)
        if bw <= 1 or bh <= 1:
            continue
        area_ratio = (bw * bh) / float(w * h)
        aspect = bw / float(bh)

        if area_ratio >= 0.85:
            continue
        if y1 >= int(0.78 * h) and aspect >= 4.0:
            continue
        if y2 <= int(0.18 * h) and aspect >= 4.0:
            continue
        if x1 <= int(0.03 * w) and x2 >= int(0.97 * w) and (bh / float(h)) <= 0.16:
            continue
        if x1 >= int(0.78 * w) and y1 >= int(0.70 * h) and area_ratio <= 0.06:
            continue

        kept.append(d)

    if len(kept) == len(result.detections):
        return result
    return DetectionResult(detections=kept, image_width=w, image_height=h, process_time_ms=getattr(result, "process_time_ms", 0))


def _resolve_or_route_model_path(*, model_key: Optional[str], auto_hint: Optional[str], device: str, img) -> Tuple[Optional[str], str]:
    mk = (model_key or "").strip().lower()
    if mk and mk != "auto":
        if mk == "wire_break_seg":
            return None, mk
        return _resolve_model_key(mk), mk
    hinted = _auto_hint_to_model_key(auto_hint)
    if hinted:
        if hinted == "wire_break_seg":
            return None, hinted
        try:
            return _resolve_model_key(hinted), hinted
        except HTTPException:
            pass
    try:
        from backend.core.vision.model_router import choose_model_key
        project_root = Path(__file__).resolve().parents[2]
        chosen_key, _, _ = choose_model_key(bgr_image=img, device=device, project_root=project_root)
        return _resolve_model_key(chosen_key), chosen_key
    except HTTPException:
        raise
    except Exception:
        return None, "yolo11m"


# ==================== API 路由 ====================

@router.post("/detect/image", response_model=DetectionResultResponse)
async def detect_image(
    file: UploadFile = File(...),
    conf_threshold: float = Form(0.25),
    iou_threshold: float = Form(0.45),
    return_annotated: bool = Form(True),
    device: str = Form("cpu"),
    model_key: Optional[str] = Form("auto"),
    auto_hint: Optional[str] = Form(None),
    suppress_overlay: bool = Form(False),
):
    """
    上传图片进行目标检测
    
    - **file**: 图片文件 (jpg, png, bmp)
    - **conf_threshold**: 置信度阈值 (0-1)
    - **iou_threshold**: NMS IOU 阈值 (0-1)
    - **return_annotated**: 是否返回标注图片
    - **device**: 计算设备 (cuda/cpu)
    - **model_key**: 模型选择（auto / wire_break_seg / mvtec_fastener_det / yolo11m）
    """
    try:
        # 读取图片文件
        contents = await file.read()
        
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file")
        
        # 解码图片
        import numpy as np
        img_array = np.frombuffer(contents, np.uint8)
        import cv2
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image data")

        mk = (model_key or "").strip().lower()
        if mk == "auto":
            try:
                from backend.core.vision.wire_break import get_wire_break_detector
                seg = get_wire_break_detector(device=device)
                wr = seg.detect_break(img, suppress_overlay=suppress_overlay)
                import numpy as np
                if isinstance(wr.wire_mask, np.ndarray) and float((wr.wire_mask > 0).mean()) >= 0.002:
                    mk = "wire_break_seg"
            except Exception:
                mk = "auto"

        if mk == "wire_break_seg":
            from backend.core.vision.wire_break import get_wire_break_detector, annotate_wire_break

            seg = get_wire_break_detector(device=device)
            wr = seg.detect_break(img, suppress_overlay=suppress_overlay)
            h0, w0 = img.shape[:2]
            total_area = float(max(1, w0 * h0))
            dets = []
            if wr.wire_bbox is not None:
                x1, y1, x2, y2 = wr.wire_bbox
                area_ratio = ((x2 - x1) * (y2 - y1)) / total_area
                dets.append(DetectionBoxResponse(
                    class_id=0,
                    class_name="wire",
                    confidence=float(max(0.01, min(0.99, wr.confidence))),
                    bbox=[int(x1), int(y1), int(x2), int(y2)],
                    area_ratio=round(float(area_ratio), 4),
                    is_anomaly=False,
                    description="电线区域",
                ))
            if wr.is_broken and wr.break_bbox is not None:
                x1, y1, x2, y2 = wr.break_bbox
                area_ratio = ((x2 - x1) * (y2 - y1)) / total_area
                dets.append(DetectionBoxResponse(
                    class_id=1,
                    class_name="wire_break",
                    confidence=float(max(0.01, min(0.99, wr.confidence))),
                    bbox=[int(x1), int(y1), int(x2), int(y2)],
                    area_ratio=round(float(area_ratio), 4),
                    is_anomaly=True,
                    description="疑似电线断裂",
                ))

            response = DetectionResultResponse(
                detection_id=str(uuid.uuid4()),
                image_width=w0,
                image_height=h0,
                process_time_ms=round(float(wr.process_time_ms), 2),
                model_name="wire_seg_unet",
                device=str(getattr(seg, "device", device)),
                total_detections=len(dets),
                anomaly_count=1 if wr.is_broken else 0,
                overall_status="critical" if wr.is_broken else "normal",
                detections=dets,
            )
            if return_annotated:
                annotated = annotate_wire_break(img, wr)
                response.annotated_image = _image_to_base64(annotated)
            return response

        # 导入检测器
        from backend.core.vision.detector import get_detector

        # 获取或创建检测器
        model_path, _ = _resolve_or_route_model_path(model_key=mk, auto_hint=auto_hint, device=device, img=img)
        detector = get_detector(
            model_path=model_path,
            device=device,
            conf_threshold=conf_threshold,
            iou_threshold=iou_threshold
        )

        try:
            result = detector.detect(img)
        except Exception as e:
            msg = str(e)
            if "Invalid device id" in msg and str(device).strip().lower() != "cpu":
                model_path, _ = _resolve_or_route_model_path(model_key=model_key, auto_hint=auto_hint, device="cpu", img=img)
                detector = get_detector(
                    model_path=model_path,
                    device="cpu",
                    conf_threshold=conf_threshold,
                    iou_threshold=iou_threshold,
                )
                result = detector.detect(img)
            else:
                raise
        if suppress_overlay:
            h, w = img.shape[:2]
            result = _suppress_overlay_detections(result, img_height=h, img_width=w)
        
        # 序列化结果
        response = _serialize_detection_result(
            result,
            model_name=str(Path(getattr(detector, "model_path", "yolo11m.pt")).name),
            device=getattr(getattr(detector, "device", None), "value", device),
        )
        
        # 如果需要返回标注图片
        if return_annotated:
            annotated = detector.annotate_image(img, result)
            response.annotated_image = _image_to_base64(annotated)
        
        logger.info(f"Image detection completed: {response.total_detections} objects, {response.anomaly_count} anomalies")
        
        return response
        
    except ImportError as e:
        logger.error(f"Import error: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"视觉识别依赖缺失: {str(e)}（请安装 opencv-python / numpy / ultralytics / torch 等依赖）",
        )
    except RuntimeError as e:
        msg = str(e)
        logger.error(f"Detection runtime error: {msg}")
        if msg.startswith("Failed to load model"):
            raise HTTPException(
                status_code=503,
                detail=f"视觉模型加载失败：{msg}",
            )
        raise HTTPException(status_code=500, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        logger.error(f"Detection error: {msg}")
        raise HTTPException(status_code=500, detail=msg)


@router.post("/detect/batch", response_model=BatchDetectionResponse)
async def detect_batch(
    files: List[UploadFile] = File(...),
    conf_threshold: float = Form(0.25),
    device: str = Form("cpu"),
    model_key: Optional[str] = Form("auto"),
    auto_hint: Optional[str] = Form(None),
    suppress_overlay: bool = Form(False),
):
    """
    批量图片检测
    
    - **files**: 图片文件列表 (最多 9 张)
    - **conf_threshold**: 置信度阈值
    - **device**: 计算设备
    - **model_key**: 模型选择（auto / wire_break_seg / mvtec_fastener_det / yolo11m）
    """
    try:
        if len(files) > 9:
            raise HTTPException(status_code=400, detail="Maximum 9 images allowed")
        
        import numpy as np
        import cv2

        first_img = None
        for f in files:
            contents0 = await f.read()
            try:
                await f.seek(0)
            except Exception:
                try:
                    f.file.seek(0)
                except Exception:
                    pass
            if not contents0:
                continue
            arr0 = np.frombuffer(contents0, np.uint8)
            im0 = cv2.imdecode(arr0, cv2.IMREAD_COLOR)
            if im0 is None:
                continue
            first_img = im0
            break

        mk = (model_key or "").strip().lower()
        if mk == "auto" and first_img is not None:
            try:
                from backend.core.vision.wire_break import get_wire_break_detector
                seg = get_wire_break_detector(device=device)
                wr = seg.detect_break(first_img, suppress_overlay=suppress_overlay)
                if isinstance(wr.wire_mask, np.ndarray) and float((wr.wire_mask > 0).mean()) >= 0.002:
                    mk = "wire_break_seg"
            except Exception:
                mk = "auto"

        if mk == "wire_break_seg":
            from backend.core.vision.wire_break import get_wire_break_detector

            seg = get_wire_break_detector(device=device)
            results = []
            total_detections = 0
            total_anomalies = 0
            for file in files:
                contents = await file.read()
                if not contents:
                    continue
                img_array = np.frombuffer(contents, np.uint8)
                img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if img is None:
                    continue
                wr = seg.detect_break(img, suppress_overlay=suppress_overlay)
                h0, w0 = img.shape[:2]
                total_area = float(max(1, w0 * h0))
                dets = []
                if wr.wire_bbox is not None:
                    x1, y1, x2, y2 = wr.wire_bbox
                    area_ratio = ((x2 - x1) * (y2 - y1)) / total_area
                    dets.append(DetectionBoxResponse(
                        class_id=0,
                        class_name="wire",
                        confidence=float(max(0.01, min(0.99, wr.confidence))),
                        bbox=[int(x1), int(y1), int(x2), int(y2)],
                        area_ratio=round(float(area_ratio), 4),
                        is_anomaly=False,
                        description="电线区域",
                    ))
                if wr.is_broken and wr.break_bbox is not None:
                    x1, y1, x2, y2 = wr.break_bbox
                    area_ratio = ((x2 - x1) * (y2 - y1)) / total_area
                    dets.append(DetectionBoxResponse(
                        class_id=1,
                        class_name="wire_break",
                        confidence=float(max(0.01, min(0.99, wr.confidence))),
                        bbox=[int(x1), int(y1), int(x2), int(y2)],
                        area_ratio=round(float(area_ratio), 4),
                        is_anomaly=True,
                        description="疑似电线断裂",
                    ))
                resp = DetectionResultResponse(
                    detection_id=str(uuid.uuid4()),
                    image_width=w0,
                    image_height=h0,
                    process_time_ms=round(float(wr.process_time_ms), 2),
                    model_name="wire_seg_unet",
                    device=str(getattr(seg, "device", device)),
                    total_detections=len(dets),
                    anomaly_count=1 if wr.is_broken else 0,
                    overall_status="critical" if wr.is_broken else "normal",
                    detections=dets,
                )
                results.append(resp)
                total_detections += len(dets)
                total_anomalies += 1 if wr.is_broken else 0

            return BatchDetectionResponse(
                success=True,
                total_images=len(results),
                total_detections=total_detections,
                total_anomalies=total_anomalies,
                results=results,
            )

        # 导入检测器
        from backend.core.vision.detector import get_detector

        model_path = None
        if first_img is not None:
            model_path, _ = _resolve_or_route_model_path(model_key=mk, auto_hint=auto_hint, device=device, img=first_img)

        detector = get_detector(model_path=model_path, device=device, conf_threshold=conf_threshold)
        
        results = []
        total_detections = 0
        total_anomalies = 0
        
        for file in files:
            # 读取图片
            contents = await file.read()
            if not contents:
                continue
            
            img_array = np.frombuffer(contents, np.uint8)
            img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            if img is None:
                continue
            
            # 执行检测
            result = detector.detect(img)
            if suppress_overlay:
                h, w = img.shape[:2]
                result = _suppress_overlay_detections(result, img_height=h, img_width=w)
            response = _serialize_detection_result(
                result,
                model_name=str(Path(getattr(detector, "model_path", "yolo11m.pt")).name),
                device=getattr(getattr(detector, "device", None), "value", device),
            )
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
    device: str = Form("cpu"),
    model_key: Optional[str] = Form("auto"),
    auto_hint: Optional[str] = Form(None),
    suppress_overlay: bool = Form(False),
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
        
        # 解码图片
        import numpy as np
        img_array = np.frombuffer(image_bytes, np.uint8)
        import cv2
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image data")

        # 导入检测器
        from backend.core.vision.detector import get_detector

        mk = (model_key or "").strip().lower()
        if mk == "auto":
            try:
                from backend.core.vision.wire_break import get_wire_break_detector
                seg = get_wire_break_detector(device=device)
                wr = seg.detect_break(img, suppress_overlay=suppress_overlay)
                import numpy as np
                if isinstance(wr.wire_mask, np.ndarray) and float((wr.wire_mask > 0).mean()) >= 0.002:
                    mk = "wire_break_seg"
            except Exception:
                mk = "auto"

        if mk == "wire_break_seg":
            from backend.core.vision.wire_break import get_wire_break_detector, annotate_wire_break

            seg = get_wire_break_detector(device=device)
            wr = seg.detect_break(img, suppress_overlay=suppress_overlay)
            h0, w0 = img.shape[:2]
            total_area = float(max(1, w0 * h0))
            dets = []
            if wr.wire_bbox is not None:
                x1, y1, x2, y2 = wr.wire_bbox
                area_ratio = ((x2 - x1) * (y2 - y1)) / total_area
                dets.append(DetectionBoxResponse(
                    class_id=0,
                    class_name="wire",
                    confidence=float(max(0.01, min(0.99, wr.confidence))),
                    bbox=[int(x1), int(y1), int(x2), int(y2)],
                    area_ratio=round(float(area_ratio), 4),
                    is_anomaly=False,
                    description="电线区域",
                ))
            if wr.is_broken and wr.break_bbox is not None:
                x1, y1, x2, y2 = wr.break_bbox
                area_ratio = ((x2 - x1) * (y2 - y1)) / total_area
                dets.append(DetectionBoxResponse(
                    class_id=1,
                    class_name="wire_break",
                    confidence=float(max(0.01, min(0.99, wr.confidence))),
                    bbox=[int(x1), int(y1), int(x2), int(y2)],
                    area_ratio=round(float(area_ratio), 4),
                    is_anomaly=True,
                    description="疑似电线断裂",
                ))

            response = DetectionResultResponse(
                detection_id=str(uuid.uuid4()),
                image_width=w0,
                image_height=h0,
                process_time_ms=round(float(wr.process_time_ms), 2),
                model_name="wire_seg_unet",
                device=str(getattr(seg, "device", device)),
                total_detections=len(dets),
                anomaly_count=1 if wr.is_broken else 0,
                overall_status="critical" if wr.is_broken else "normal",
                detections=dets,
            )
            if return_annotated:
                annotated = annotate_wire_break(img, wr)
                response.annotated_image = _image_to_base64(annotated)
            return response

        model_path, _ = _resolve_or_route_model_path(model_key=mk, auto_hint=auto_hint, device=device, img=img)
        detector = get_detector(model_path=model_path, device=device, conf_threshold=conf_threshold)
        
        result = detector.detect(img)
        if suppress_overlay:
            h, w = img.shape[:2]
            result = _suppress_overlay_detections(result, img_height=h, img_width=w)
        response = _serialize_detection_result(
            result,
            model_name=str(Path(getattr(detector, "model_path", "yolo11m.pt")).name),
            device=getattr(getattr(detector, "device", None), "value", device),
        )
        
        # 如果需要返回标注图片
        if return_annotated:
            annotated = detector.annotate_image(img, result)
            response.annotated_image = _image_to_base64(annotated)
        
        return response
        
    except ImportError as e:
        logger.error(f"Import error: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"视觉识别依赖缺失: {str(e)}（请安装 opencv-python / numpy / ultralytics / torch 等依赖）",
        )
    except RuntimeError as e:
        msg = str(e)
        logger.error(f"Base64 detection runtime error: {msg}")
        if msg.startswith("Failed to load model"):
            raise HTTPException(
                status_code=503,
                detail=f"视觉模型加载失败：{msg}",
            )
        raise HTTPException(status_code=500, detail=msg)
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        logger.error(f"Base64 detection error: {msg}")
        if "ultralytics" in msg.lower() or "yolo" in msg.lower() or "model" in msg.lower():
            raise HTTPException(status_code=503, detail=f"视觉识别模型不可用：{msg}")
        raise HTTPException(status_code=500, detail=msg)


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
