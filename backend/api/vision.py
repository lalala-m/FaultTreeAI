"""
视觉识别 API 路由
提供图片识别、结果标注等接口
"""

import asyncio
import io
import os
import uuid
import base64
import logging
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime

try:
    from PIL import Image
except Exception:  # pragma: no cover
    Image = None

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from fastapi import Depends

from backend.api.auth import _bearer, _decode_access_token
from backend.config import settings
from backend.core.llm.manager import get_llm_manager
from backend.core.rtc import AccessToken, PRIV_PUBLISH_STREAM, PRIV_SUBSCRIBE_STREAM, get_rtc_session_manager
from backend.services.rtc_bot.worker import RtcAIBotWorker as _RtcAIBotWorker

_bot_worker: Optional[_RtcAIBotWorker] = None


def _get_bot_worker() -> _RtcAIBotWorker:
    global _bot_worker
    if _bot_worker is None:
        _bot_worker = _RtcAIBotWorker()
    return _bot_worker

# 配置日志
logger = logging.getLogger(__name__)

# 创建路由
router = APIRouter(prefix="/api/vision", tags=["视觉识别"])

# 全局复用的 VLM 客户端缓存，避免每次调用都重建连接池
_vlm_openai_clients: Dict[str, Any] = {}
_vlm_ark_clients: Dict[str, Any] = {}
_VLM_CLIENT_CACHE_LIMIT = 4


def _ensure_vlm_cache_limit(cache: Dict[str, Any]) -> None:
    """限制 VLM 客户端缓存大小，防止配置切换时内存泄漏。"""
    while len(cache) > _VLM_CLIENT_CACHE_LIMIT:
        try:
            cache.pop(next(iter(cache)), None)
        except StopIteration:
            break


def _get_vlm_openai_client(api_key: str, base_url: str) -> Any:
    """获取复用的 OpenAI 兼容 VLM 客户端"""
    from openai import AsyncOpenAI
    key = f"{base_url or 'default'}|{api_key[:8] if api_key else ''}"
    client = _vlm_openai_clients.get(key)
    if client is None:
        client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url or "https://api.openai.com/v1",
            timeout=120,
        )
        _ensure_vlm_cache_limit(_vlm_openai_clients)
        _vlm_openai_clients[key] = client
    return client


def _get_vlm_ark_client(api_key: str, base_url: str) -> Any:
    """获取复用的火山 Ark VLM 客户端"""
    from volcenginesdkarkruntime import Ark
    key = f"{base_url or 'default'}|{api_key[:8] if api_key else ''}"
    client = _vlm_ark_clients.get(key)
    if client is None:
        client = Ark(
            api_key=api_key,
            base_url=base_url or "https://ark.cn-beijing.volces.com/api/v3",
            timeout=120,
        )
        _ensure_vlm_cache_limit(_vlm_ark_clients)
        _vlm_ark_clients[key] = client
    return client


def _compress_image_base64(image_data: str) -> str:
    """
    将图片 base64 压缩后再送 VLM。

    - 解析 data URL 或纯 base64
    - 等比缩放长边到 VLM_MAX_IMAGE_LONG_SIDE
    - 转 JPEG 并按 VLM_IMAGE_QUALITY 压缩
    - 失败时回退原图
    """
    if Image is None:
        return _extract_base64_from_data_url(image_data)

    raw = str(image_data or "").strip()
    b64 = _extract_base64_from_data_url(raw)
    if not b64:
        return raw

    try:
        img_bytes = base64.b64decode(b64)
    except Exception:
        return raw

    try:
        img = Image.open(io.BytesIO(img_bytes))
        img = img.convert("RGB")
        max_side = int(getattr(settings, "VLM_MAX_IMAGE_LONG_SIDE", 768) or 768)
        quality = int(getattr(settings, "VLM_IMAGE_QUALITY", 80) or 80)
        w, h = img.size
        if max(w, h) > max_side:
            ratio = max_side / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception:
        return b64


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


class RtcTokenRequest(BaseModel):
    room_id: Optional[str] = None
    user_id: Optional[str] = None


class RtcTokenResponse(BaseModel):
    app_id: str
    room_id: str
    user_id: str
    token: str
    expire_at: int
    issued_at: int


class RtcSessionStartRequest(BaseModel):
    room_id: Optional[str] = None
    user_id: Optional[str] = None


class RtcSessionStartResponse(BaseModel):
    session_id: str
    app_id: str
    room_id: str
    user_id: str
    token: str
    expire_at: int
    issued_at: int
    ai_user_id: str
    ai_status: str
    ai_display_name: str
    welcome_message: str


class RtcSessionStatusResponse(BaseModel):
    session_id: str
    room_id: str
    user_id: str
    ai_user_id: str
    ai_status: str
    ai_display_name: str
    created_at: int
    updated_at: int
    last_analysis_at: int = 0
    message_count: int = 0
    messages: List[dict] = Field(default_factory=list)


class VisionAnalyzeRequest(BaseModel):
    prompt: str
    images: List[str] = Field(default_factory=list)
    session_id: Optional[str] = None
    source: Optional[str] = "local"


class VisionAnalyzeResponse(BaseModel):
    content: str
    session_id: Optional[str] = None
    source: Optional[str] = None
    provider: Optional[str] = None
    overall_status: Optional[str] = None
    detection_summary: Optional[str] = None
    detection_count: int = 0
    anomaly_count: int = 0


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


def _normalize_rtc_identifier(value: Optional[str], fallback: str) -> str:
    raw = str(value or "").strip()
    cleaned = re.sub(r"[^0-9A-Za-z_-]+", "_", raw)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return (cleaned or fallback)[:64]


def _optional_auth_payload(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> Optional[dict]:
    if not creds or not creds.credentials:
        return None
    return _decode_access_token(creds.credentials)


def _build_auth_seed(auth_payload: Optional[dict]) -> str:
    return (
        str((auth_payload or {}).get("employee_id") or "").strip()
        or str((auth_payload or {}).get("username") or "").strip()
        or str((auth_payload or {}).get("sub") or "").strip()
    )


def _create_rtc_token_payload(*, room_id: str, user_id: str) -> RtcTokenResponse:
    app_id = str(getattr(settings, "RTC_APP_ID", "") or "").strip()
    app_key = str(getattr(settings, "RTC_APP_KEY", "") or "").strip()
    if not app_id or not app_key:
        raise HTTPException(
            status_code=503,
            detail="RTC 未配置，请先设置 RTC_APP_ID 和 RTC_APP_KEY",
        )

    issued_at = int(time.time())
    expire_at = issued_at + max(60, int(getattr(settings, "RTC_TOKEN_EXPIRE_SECONDS", 3600) or 3600))

    token = AccessToken(app_id, app_key, room_id, user_id)
    token.add_privilege(PRIV_PUBLISH_STREAM, expire_at)
    token.add_privilege(PRIV_SUBSCRIBE_STREAM, expire_at)
    token.expire_time(expire_at)

    return RtcTokenResponse(
        app_id=app_id,
        room_id=room_id,
        user_id=user_id,
        token=token.serialize(),
        expire_at=expire_at,
        issued_at=issued_at,
    )


def _resolve_rtc_identity(*, auth_payload: Optional[dict], room_id: Optional[str], user_id: Optional[str]) -> tuple[str, str]:
    auth_seed = _build_auth_seed(auth_payload)
    room_prefix = _normalize_rtc_identifier(getattr(settings, "RTC_ROOM_PREFIX", ""), "faulttree")
    default_room = str(getattr(settings, "RTC_DEFAULT_ROOM", "") or "").strip()
    if not default_room:
        default_room = f"{room_prefix}_{_normalize_rtc_identifier(auth_seed, 'room')}"
    final_room_id = _normalize_rtc_identifier(room_id, default_room)

    default_user_seed = _normalize_rtc_identifier(auth_seed, "user")
    default_user_id = f"{default_user_seed}_{secrets.token_hex(3)}"
    final_user_id = _normalize_rtc_identifier(user_id, default_user_id)
    return final_room_id, final_user_id


def _build_ai_user_id(room_id: str) -> str:
    prefix = _normalize_rtc_identifier(getattr(settings, "RTC_AI_USER_PREFIX", ""), "ai_bot")
    room_part = _normalize_rtc_identifier(room_id, "room")
    return _normalize_rtc_identifier(f"{prefix}_{room_part}_{secrets.token_hex(2)}", "ai_bot")


def _decode_data_url_to_bgr(image_data: str):
    raw = str(image_data or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="缺少图片数据")
    payload = raw.split(",", 1)[1] if raw.startswith("data:") and "," in raw else raw
    try:
        image_bytes = base64.b64decode(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="无效图片编码")

    import numpy as np
    import cv2

    img_array = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="无法解析图片")
    return img


def _run_detection_from_image_data(
    image_data: str,
    *,
    conf_threshold: float = 0.15,
    device: str = "cpu",
    model_key: str = "auto",
    suppress_overlay: bool = True,
) -> DetectionResultResponse:
    img = _decode_data_url_to_bgr(image_data)
    mk = (model_key or "").strip().lower()

    if mk == "auto":
        try:
            from backend.core.vision.wire_break import get_wire_break_detector
            import numpy as np

            seg = get_wire_break_detector(device=device)
            wr = seg.detect_break(img, suppress_overlay=suppress_overlay)
            if isinstance(wr.wire_mask, np.ndarray) and float((wr.wire_mask > 0).mean()) >= 0.002:
                mk = "wire_break_seg"
        except Exception:
            mk = "auto"

    if mk == "wire_break_seg":
        from backend.core.vision.wire_break import get_wire_break_detector

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

        return DetectionResultResponse(
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
            annotated_image=None,
        )

    from backend.core.vision.detector import get_detector

    model_path, _ = _resolve_or_route_model_path(model_key=mk, auto_hint=None, device=device, img=img)
    detector = get_detector(model_path=model_path, device=device, conf_threshold=conf_threshold)
    result = detector.detect(img)
    if suppress_overlay:
        h, w = img.shape[:2]
        result = _suppress_overlay_detections(result, img_height=h, img_width=w)
    return _serialize_detection_result(
        result,
        model_name=str(Path(getattr(detector, "model_path", "yolo11m.pt")).name),
        device=getattr(getattr(detector, "device", None), "value", device),
    )


def _summarize_detection(det: DetectionResultResponse) -> str:
    items = []
    for item in list(det.detections or [])[:8]:
        name = str(item.class_name or "")
        confidence = float(item.confidence or 0)
        state = "异常" if item.is_anomaly else "正常"
        desc = str(item.description or "").strip()
        if desc:
            items.append(f"{name}（{state}，置信度 {confidence:.2f}，{desc}）")
        else:
            items.append(f"{name}（{state}，置信度 {confidence:.2f}）")
    return f"检测到 {det.total_detections} 个目标，其中异常 {det.anomaly_count} 个；整体状态 {det.overall_status}。{'；'.join(items)}"


def _extract_keywords(text: str) -> list[str]:
    """从文本中提取关键词，用于知识库检索。"""
    if not text:
        return []
    # 中文词汇（2字以上）+ 英文数字单词
    words = set(re.findall(r'[\u4e00-\u9fa5]{2,}|[a-zA-Z0-9]+', text))
    return [w for w in words if len(w) >= 2]


def _retrieve_knowledge_items(query: str, detection_summary: str, top_k: int = 5) -> list[dict]:
    """根据用户问题和画面检测摘要，检索 knowledge_items 中的结构化知识。
    同时兼容 fault 与 maintenance 类型条目。"""
    keywords = _extract_keywords(f"{query or ''} {detection_summary or ''}")
    if not keywords:
        return []

    try:
        import psycopg2
        with psycopg2.connect(
            host=settings.DB_HOST, port=settings.DB_PORT,
            user=settings.DB_USER, password=settings.DB_PASSWORD,
            database=settings.DB_NAME,
        ) as conn:
            conditions = []
            params = []
            for kw in keywords:
                like = f"%{kw}%"
                conditions.append("""
                    (ki.machine_category ILIKE %s OR 
                     ki.machine ILIKE %s OR 
                     ki.problem_category ILIKE %s OR 
                     ki.problem ILIKE %s OR 
                     ki.root_cause ILIKE %s OR 
                     ki.solution ILIKE %s OR
                     ki.operation_category ILIKE %s OR
                     ki.operation_item ILIKE %s OR
                     ki.operation_steps ILIKE %s OR
                     ki.check_standard ILIKE %s OR
                     ki.precautions ILIKE %s)
                """)
                params.extend([like] * 11)

            sql = f"""
                SELECT 
                    ki.knowledge_type,
                    ki.machine_category, ki.machine, ki.problem_category,
                    ki.problem, ki.root_cause, ki.solution,
                    ki.operation_category, ki.operation_item,
                    ki.operation_steps, ki.check_standard, ki.precautions
                FROM knowledge_items ki
                WHERE ki.status = 'active'
                  AND ({' OR '.join(conditions)})
                ORDER BY ki.updated_at DESC
                LIMIT %s
            """
            params.append(top_k)
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall() or []

        return [
            {
                "knowledge_type": str(r[0] or "fault"),
                "machine_category": r[1],
                "machine": r[2],
                "problem_category": r[3],
                "problem": r[4],
                "root_cause": r[5],
                "solution": r[6],
                "operation_category": r[7],
                "operation_item": r[8],
                "operation_steps": r[9],
                "check_standard": r[10],
                "precautions": r[11],
            }
            for r in rows
        ]
    except Exception as exc:
        logger.warning("[Vision] retrieve knowledge items failed: %s", exc)
        return []


def _format_knowledge_items(items: list[dict]) -> str:
    """把 knowledge_items 格式化为 prompt 文本。兼容 maintenance 类型。"""
    if not items:
        return "暂无相关知识库记录。"
    lines = []
    for i, it in enumerate(items, 1):
        if str(it.get("knowledge_type") or "") == "maintenance":
            lines.append(
                f"案例{i}：{it.get('machine_category') or ''}-{it.get('machine') or ''}，"
                f"作业类别：{it.get('operation_category') or ''}，"
                f"作业项：{it.get('operation_item') or ''}，"
                f"操作步骤：{it.get('operation_steps') or ''}，"
                f"验收标准：{it.get('check_standard') or ''}，"
                f"注意事项：{it.get('precautions') or ''}"
            )
        else:
            lines.append(
                f"案例{i}：{it.get('machine_category') or ''}-{it.get('machine') or ''}，"
                f"问题：{it.get('problem') or ''}，"
                f"原因：{it.get('root_cause') or ''}，"
                f"方案：{it.get('solution') or ''}"
            )
    return "\n".join(lines)


async def _generate_ai_reply(
    *,
    prompt: str,
    detection_summary: str,
    image_count: int,
    image_base64: Optional[str] = None,
) -> tuple[str, Optional[str]]:
    """
    生成 AI 诊断回复。

    当配置了 VLM_PROVIDER 且传入 image_base64 时，优先使用原生多模态模型；
    否则使用检测摘要 + 知识库检索 + 文本 LLM 的回退方案。
    """
    # 检索知识库中的相关结构化知识
    knowledge_items = _retrieve_knowledge_items(prompt, detection_summary, top_k=5)
    knowledge_text = _format_knowledge_items(knowledge_items)
    logger.info("[Vision] retrieved %d knowledge items for query: %s", len(knowledge_items), prompt[:40])

    # 1. 尝试原生 VLM（vision-language model）
    vlm_provider = str(getattr(settings, "VLM_PROVIDER", "") or "").strip().lower()
    vlm_model = str(getattr(settings, "VLM_MODEL", "") or "gpt-4o").strip()
    vlm_base_url = str(getattr(settings, "VLM_BASE_URL", "") or "").strip()
    vlm_api_key = str(getattr(settings, "VLM_API_KEY", "") or "").strip()

    if vlm_provider and image_base64:
        try:
            vlm_prompt = (
                "请根据用户问题、当前画面、以及以下相关知识库案例，给出简练的判断和处理建议。\n"
                "输出要求：控制在 200 字以内；先给一句话结论，再给 2-3 条具体处理建议。\n\n"
                f"相关知识库案例：\n{knowledge_text}\n\n"
                f"用户问题：{prompt}"
            )
            compressed_image = _compress_image_base64(image_base64)
            content, provider = await _generate_vlm_reply(
                prompt=vlm_prompt,
                image_base64=compressed_image,
                provider=vlm_provider,
                model=vlm_model,
                base_url=vlm_base_url,
                api_key=vlm_api_key,
            )
            if content:
                return content, provider
        except Exception as exc:
            logger.warning("VLM reply failed, fallback to text LLM: %s", exc)

    # 2. 文本 LLM 回退方案（结合知识库 + 检测摘要）
    final_prompt = (
        "你是工业设备故障诊断 AI 助手。请根据用户问题、当前画面检测摘要和以下相关知识库案例，"
        "给出简练的判断和处理建议。\n"
        "输出要求：控制在 200 字以内；先给一句话结论，再给 2-3 条具体处理建议。\n\n"
        f"用户问题：{prompt}\n"
        f"画面检测摘要：{detection_summary or '暂无画面检测结果'}\n"
        f"相关知识库案例：\n{knowledge_text}"
    )

    try:
        mgr = get_llm_manager()
        resp, provider = await mgr.generate_with_fallback(final_prompt)
        content = str(getattr(resp, "content", "") or "").strip()
        if content:
            return content, provider
    except Exception as exc:
        logger.warning("Vision assistant fallback: %s", exc)

    fallback = [
        "当前已接入 AI 通话分析链路，但大模型回复暂不可用。",
        f"你的问题：{prompt}",
    ]
    if detection_summary:
        fallback.append(f"我先基于检测结果给出判断：{detection_summary}")
        fallback.append("建议你继续保持画面对准关键部位，并补充近景、铭牌、接线端子或异常位置的细节。")
    else:
        fallback.append("当前还没有可用画面，我建议先让我抓取当前摄像头画面后再判断。")
    return "\n".join(fallback), None


async def _generate_vlm_reply(
    *,
    prompt: str,
    image_base64: str,
    provider: str,
    model: str,
    base_url: str,
    api_key: str,
) -> tuple[Optional[str], Optional[str]]:
    """
    调用原生多模态 LLM。

    支持两种模式：
    1. OpenAI 兼容接口（provider=openai）：使用 chat.completions
    2. 火山 Ark SDK（provider=ark 或模型名以 doubao-seed- 开头）：使用 responses.create
    """
    if not api_key:
        raise ValueError("VLM_API_KEY not configured")

    # 确保图片是 data URL 格式
    image_url = image_base64 if image_base64.startswith("data:") else f"data:image/jpeg;base64,{image_base64}"

    model_lower = str(model or "").strip().lower()
    use_ark = str(provider or "").strip().lower() == "ark" or model_lower.startswith("doubao-seed-")

    if use_ark:
        return await _generate_ark_vlm_reply(
            prompt=prompt,
            image_url=image_url,
            model=model,
            base_url=base_url,
            api_key=api_key,
        )

    client = _get_vlm_openai_client(api_key, base_url)

    messages = [
        {
            "role": "system",
            "content": (
                "你是工业设备故障诊断 AI 助手。请根据用户问题和提供的现场画面，"
                "给出简明、专业、可执行的答复。输出要求：先给结论，再给依据，再给处理建议；"
                "如果信息不足，明确说明还需要补拍什么。"
            ),
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt or "请分析当前画面中的设备状态。"},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        },
    ]

    response = await client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=float(getattr(settings, "LLM_TEMPERATURE", 0.1) or 0.1),
        max_tokens=int(getattr(settings, "LLM_MAX_TOKENS", 2048) or 2048),
    )

    content = response.choices[0].message.content if response.choices else ""
    content = str(content or "").strip()
    return content, f"vlm-{provider}"


async def _generate_ark_vlm_reply(
    *,
    prompt: str,
    image_url: str,
    model: str,
    base_url: str,
    api_key: str,
) -> tuple[Optional[str], Optional[str]]:
    """
    使用火山 Ark SDK 调用视觉模型（如 doubao-seed-1-6-vision）。

    火山官方示例使用 Ark 客户端的 chat.completions.create 直接传入模型 ID，
    不需要创建 Endpoint，也无需使用 responses.create。
    """
    client = _get_vlm_ark_client(api_key, base_url)

    messages = [
        {
            "role": "system",
            "content": (
                "你是工业设备故障诊断 AI 助手。请根据用户问题和提供的现场画面，"
                "给出简明、专业、可执行的答复。输出要求：先给结论，再给依据，再给处理建议；"
                "如果信息不足，明确说明还需要补拍什么。"
            ),
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt or "请分析当前画面中的设备状态。"},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        },
    ]

    def _call():
        return client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=float(getattr(settings, "LLM_TEMPERATURE", 0.1) or 0.1),
            max_tokens=int(getattr(settings, "LLM_MAX_TOKENS", 2048) or 2048),
        )

    try:
        response = await asyncio.to_thread(_call)
    except Exception as exc:
        logger.warning("Ark VLM chat.completions.create failed: %s", exc)
        raise

    content = response.choices[0].message.content if response.choices else ""
    content = str(content or "").strip()
    return content, "vlm-ark"


def _extract_base64_from_data_url(image_data: str) -> str:
    """从 data URL 中提取纯 base64 内容。"""
    raw = str(image_data or "").strip()
    if raw.startswith("data:") and "," in raw:
        return raw.split(",", 1)[1]
    return raw

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


@router.post("/rtc/token", response_model=RtcTokenResponse)
async def create_rtc_token(req: RtcTokenRequest, auth_payload: Optional[dict] = Depends(_optional_auth_payload)):
    room_id, user_id = _resolve_rtc_identity(auth_payload=auth_payload, room_id=req.room_id, user_id=req.user_id)
    return _create_rtc_token_payload(room_id=room_id, user_id=user_id)


@router.post("/rtc/session/start", response_model=RtcSessionStartResponse)
async def start_rtc_session(req: RtcSessionStartRequest, auth_payload: Optional[dict] = Depends(_optional_auth_payload)):
    room_id, user_id = _resolve_rtc_identity(auth_payload=auth_payload, room_id=req.room_id, user_id=req.user_id)
    token_payload = _create_rtc_token_payload(room_id=room_id, user_id=user_id)
    ai_user_id = _build_ai_user_id(room_id)
    welcome_message = str(getattr(settings, "RTC_AI_WELCOME_MESSAGE", "") or "").strip() or "我已接通，请开始描述问题。"
    ai_display_name = str(getattr(settings, "RTC_AI_DISPLAY_NAME", "") or "").strip() or "故障检修系统"
    manager = get_rtc_session_manager()
    created_by = _build_auth_seed(auth_payload) or user_id
    session = manager.create_session(
        room_id=room_id,
        user_id=user_id,
        ai_user_id=ai_user_id,
        created_by=created_by,
        welcome_message=welcome_message,
    )
    session_id = str(session["session_id"])

    # 启动 RTC AI Bot（Linux SDK）
    if getattr(settings, "RTC_BOT_ENABLED", False):
        try:
            bot_worker = _get_bot_worker()
            ai_token_payload = _create_rtc_token_payload(room_id=room_id, user_id=ai_user_id)
            bot_worker.start_bot(
                session_id=session_id,
                token=ai_token_payload.token,
                room_id=room_id,
                ai_user_id=ai_user_id,
            )
            manager.set_ai_status(session_id, "observing")
        except Exception as exc:
            logger.exception("Failed to start RTC bot: %s", exc)

    return RtcSessionStartResponse(
        session_id=session_id,
        app_id=token_payload.app_id,
        room_id=token_payload.room_id,
        user_id=token_payload.user_id,
        token=token_payload.token,
        expire_at=token_payload.expire_at,
        issued_at=token_payload.issued_at,
        ai_user_id=ai_user_id,
        ai_status=str(session["status"]),
        ai_display_name=ai_display_name,
        welcome_message=welcome_message,
    )


@router.get("/rtc/session/{session_id}", response_model=RtcSessionStatusResponse)
async def get_rtc_session(session_id: str):
    manager = get_rtc_session_manager()
    session = manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="RTC 会话不存在")
    return RtcSessionStatusResponse(
        session_id=str(session["session_id"]),
        room_id=str(session["room_id"]),
        user_id=str(session["user_id"]),
        ai_user_id=str(session["ai_user_id"]),
        ai_status=str(session["status"]),
        ai_display_name=str(getattr(settings, "RTC_AI_DISPLAY_NAME", "") or "故障检修系统"),
        created_at=int(session["created_at"]),
        updated_at=int(session["updated_at"]),
        last_analysis_at=int(session.get("last_analysis_at") or 0),
        message_count=int(session.get("message_count") or 0),
        messages=list(session.get("messages") or []),
    )


@router.post("/rtc/session/{session_id}/end")
async def end_rtc_session(session_id: str):
    manager = get_rtc_session_manager()

    # 停止 RTC AI Bot
    if getattr(settings, "RTC_BOT_ENABLED", False):
        try:
            bot_worker = _get_bot_worker()
            bot_worker.stop_bot(session_id)
        except Exception as exc:
            logger.exception("Failed to stop RTC bot: %s", exc)

    session = manager.end_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="RTC 会话不存在")
    return {"success": True, "session_id": session_id, "status": "ended"}


@router.post("/vl/analyze", response_model=VisionAnalyzeResponse)
async def analyze_with_ai(req: VisionAnalyzeRequest):
    prompt = str(req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="缺少分析问题")

    images = [str(item or "").strip() for item in list(req.images or []) if str(item or "").strip()]
    detection_summary = ""
    overall_status = None
    detection_count = 0
    anomaly_count = 0

    manager = get_rtc_session_manager()
    session = None
    if req.session_id:
        session = manager.get_session(req.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="RTC 会话不存在")
        manager.mark_analyzing(req.session_id)
        manager.append_message(req.session_id, role="user", content=prompt)

    if images:
        try:
            det = _run_detection_from_image_data(images[0], suppress_overlay=True)
            detection_summary = _summarize_detection(det)
            overall_status = str(det.overall_status or "")
            detection_count = int(det.total_detections or 0)
            anomaly_count = int(det.anomaly_count or 0)
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("Vision detection summary failed: %s", exc)
            detection_summary = f"画面检测暂不可用：{exc}"

    content, provider = await _generate_ai_reply(
        prompt=prompt,
        detection_summary=detection_summary,
        image_count=len(images),
        image_base64=images[0] if images else None,
    )

    if req.session_id and session:
        manager.append_message(req.session_id, role="assistant", content=content)
        manager.mark_ready(req.session_id)

    return VisionAnalyzeResponse(
        content=content,
        session_id=req.session_id,
        source=str(req.source or "local"),
        provider=provider,
        overall_status=overall_status,
        detection_summary=detection_summary or None,
        detection_count=detection_count,
        anomaly_count=anomaly_count,
    )

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


class VideoExtractFramesResponse(BaseModel):
    """后端视频抽帧响应"""
    frames: List[Dict[str, Any]] = Field(default_factory=list)
    count: int = 0
    message: str = ""


@router.post("/video/extract-frames", response_model=VideoExtractFramesResponse)
async def extract_video_frames(
    video: UploadFile = File(...),
    max_seconds: float = Form(10.0),
    max_frames: int = Form(24),
):
    """
    后端视频抽帧接口。

    用于浏览器无法解码的视频（如 B 站常见的 H.265/HEVC/AV1），
    由服务器用 ffmpeg 直接抽取关键帧并返回 base64 图片列表。
    """
    try:
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            raise HTTPException(status_code=503, detail="服务器未安装 ffmpeg/ffprobe，无法处理视频")

        suffix = Path(video.filename or "video.mp4").suffix.lower()
        if suffix not in {".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".m4v", ".webm"}:
            raise HTTPException(status_code=400, detail=f"不支持的格式: {suffix}")

        tmpdir = tempfile.mkdtemp(prefix="vision_video_")
        try:
            video_path = os.path.join(tmpdir, f"input{suffix}")
            content = await video.read()
            if not content:
                raise HTTPException(status_code=400, detail="视频文件为空")
            with open(video_path, "wb") as f:
                f.write(content)

            probe_cmd = [
                ffprobe, "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", video_path
            ]
            probe = subprocess.run(probe_cmd, capture_output=True, text=True)
            duration = 0.0
            try:
                duration = max(0.0, float(probe.stdout.strip()))
            except Exception:
                pass

            if duration <= 0:
                raise HTTPException(status_code=400, detail="无法读取视频时长，可能格式不支持")

            segment = min(duration, max_seconds)
            count = max(1, min(max_frames, int(segment * 3))) if segment > 0 else 1
            step = segment / count if count > 0 else 0

            frames = []
            max_side = 768

            for i in range(count):
                t = min(segment - 0.001, max(0, (i + 0.5) * step))
                frame_path = os.path.join(tmpdir, f"frame_{i:04d}.jpg")
                cmd = [
                    ffmpeg, "-y", "-ss", str(t), "-i", video_path,
                    "-vframes", "1", "-q:v", "2", "-pix_fmt", "rgb24",
                    frame_path
                ]
                result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if result.returncode != 0 or not os.path.exists(frame_path):
                    continue

                try:
                    img = Image.open(frame_path)
                    img = img.convert("RGB")
                    w, h = img.size
                    if max(w, h) > max_side:
                        ratio = max_side / max(w, h)
                        img = img.resize((int(w * ratio), int(h * ratio)), Image.Resampling.LANCZOS)
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=80, optimize=True)
                    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
                    frames.append({
                        "id": f"video_{int(time.time() * 1000)}_{i}",
                        "time": round(t, 3),
                        "image": f"data:image/jpeg;base64,{b64}"
                    })
                except Exception:
                    continue

            if not frames:
                raise HTTPException(status_code=400, detail="未能从视频中抽取有效帧")

            return VideoExtractFramesResponse(
                frames=frames,
                count=len(frames),
                message=f"已抽取 {len(frames)} 帧"
            )
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("视频抽帧失败: %s", e)
        raise HTTPException(status_code=500, detail=f"视频抽帧失败: {e}")
