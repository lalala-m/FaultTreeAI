# YOLO 视觉识别与故障树智能诊断系统技术方案

## 文档信息

| 项目 | 内容 |
|------|------|
| 项目名称 | FaultTreeAI - 工业设备故障树智能诊断系统 |
| 扩展功能 | YOLO 视觉识别模块 |
| 文档版本 | v1.0 |
| 创建日期 | 2026年3月 |
| 技术栈 | YOLO12 + CUDA + FastAPI + React |

---

## 目录

1. [项目背景与目标](#1-项目背景与目标)
2. [需求分析](#2-需求分析)
3. [技术选型](#3-技术选型)
4. [系统架构设计](#4-系统架构设计)
5. [后端开发详细设计](#5-后端开发详细设计)
6. [前端开发详细设计](#6-前端开发详细设计)
7. [YOLO 模型训练方案](#7-yolo-模型训练方案)
8. [数据库设计](#8-数据库设计)
9. [API 接口设计](#9-api-接口设计)
10. [Docker 部署方案](#10-docker-部署方案)
11. [数据流程设计](#11-数据流程设计)
12. [错误处理与容错机制](#12-错误处理与容错机制)
13. [性能优化策略](#13-性能优化策略)
14. [安全考虑](#14-安全考虑)
15. [测试方案](#15-测试方案)
16. [部署步骤](#16-部署步骤)
17. [运维与监控](#17-运维与监控)
18. [风险评估与应对](#18-风险评估与应对)
19. [开发计划与里程碑](#19-开发计划与里程碑)
20. [附录](#20-附录)

---

## 1. 项目背景与目标

### 1.1 现有系统概述

FaultTreeAI 是一个基于知识驱动与多模型推理的工业设备故障树智能生成与辅助构建系统。该系统目前具备以下核心能力：

1. **RAG 知识库**：上传设备手册、维修日志等文档，系统自动解析分块并向量化存入 PostgreSQL 向量库
2. **智能生成**：基于 MiniMax 大模型 + RAG 检索，自动生成符合 IEC 61025 / GB/T 7829 规范的故障树
3. **FTA 算法**：内置 MOCUS 最小割集算法、Birnbaum 结构重要度分析
4. **三层校验**：自动检测循环依赖、孤立节点、逻辑门错误，保证故障树结构正确
5. **专家辅助**：前端可视化编辑，支持手动调整并更新知识库

### 1.2 扩展需求

随着工业自动化程度的提高，视觉识别技术在设备故障诊断领域发挥着越来越重要的作用。本次扩展旨在将 YOLO（You Only Look Once）目标检测算法集成到现有 FaultTreeAI 系统中，实现：

1. **设备状态视觉感知**：通过摄像头或上传图片，自动识别设备的外观状态、损伤情况、异常现象
2. **故障部位定位**：精确定位故障发生的位置，为故障树生成提供直观的视觉输入
3. **多模态诊断融合**：将视觉识别结果与文本描述、RAG 知识库融合，生成更加准确的故障树
4. **实时监控预警**：支持工业摄像头实时流分析，及时发现设备异常

### 1.3 建设目标

本次技术方案的核心目标是：

1. **技术目标**
   - 实现基于 YOLO12 的工业设备视觉识别系统
   - 支持 CUDA GPU 加速 + TensorRT 优化，确保推理速度满足实时性要求
   - 构建完整的模型训练、验证、部署流程
   - 实现图片上传与实时摄像头两种输入方式

2. **业务目标（P0 核心功能）**
   - 单张图片上传识别（P0）
   - 识别结果可视化标注（P0）
   - 识别结果转故障树（P0）
   - 混合模式诊断（视觉 + RAG + 文本）（P0）
   - 摄像头实时识别（P0）
   - 故障描述输入补充（P0）

3. **性能目标（大幅提升）**
   - 图片识别响应时间 **< 200ms**（单张图片，TensorRT优化后）
   - 实时视频流处理帧率 **≥ 60 FPS**（TensorRT INT8优化）
   - 模型识别准确率 ≥ 90%（针对训练数据集）
   - 并发识别能力 ≥ 50个/秒
   - 系统可用性 ≥ 99.9%

### 1.4 适用范围

本方案适用于以下工业场景：

1. **旋转设备诊断**：电机、泵、风机、压缩机等旋转设备的轴承损坏、密封泄漏、外壳变形等
2. **管道系统检测**：管道腐蚀、裂纹、泄漏、堵塞、变形等
3. **电气设备检测**：开关柜、接线盒、电缆的烧蚀、变色、放电等
4. **结构件检测**：焊缝缺陷、裂纹、锈蚀、变形等
5. **仪表设备检测**：表盘模糊、指针卡顿、外壳破损等

---

## 2. 需求分析

### 2.1 功能需求

#### 2.1.1 图片识别功能

| 功能点 | 优先级 | 描述 |
|--------|--------|------|
| 单张图片上传识别 | P0 | 用户上传设备图片，系统返回识别结果 |
| 批量图片识别 | P1 | 支持多张图片同时上传，批量处理 |
| 识别结果标注 | P0 | 在原图上绘制检测框、标签、置信度 |
| 结果保存与导出 | P1 | 保存识别历史，支持导出为 PDF/Word 报告 |
| 故障描述输入 | P0 | 用户可输入文字描述补充视觉信息 |

#### 2.1.2 摄像头实时识别功能

| 功能点 | 优先级 | 描述 |
|--------|--------|------|
| 摄像头连接配置 | P0 | 支持 RTSP/HTTP 流地址配置 |
| 实时视频流识别 | P0 | 实时检测视频流中的设备异常 |
| 报警触发机制 | P1 | 检测到异常时触发声音/视觉报警 |
| 截图保存 | P1 | 保存检测到异常的截图 |
| 多摄像头管理 | P2 | 支持同时监控多个摄像头 |

#### 2.1.3 与故障树系统集成

| 功能点 | 优先级 | 描述 |
|--------|--------|------|
| 识别结果转故障树 | P0 | 将视觉识别结果转换为故障树输入 |
| 混合模式诊断 | P0 | 结合视觉识别 + 文本描述 + RAG 生成故障树 |
| 诊断报告生成 | P1 | 生成包含图片、识别结果、故障树的综合报告 |

### 2.2 非功能需求

#### 2.2.1 性能需求（优化后）

| 指标 | 旧要求 | 新要求（2026年） | 说明 |
|------|--------|------------------|------|
| 图片识别延迟 | < 2秒 | **< 200ms** | 单张图片，TensorRT INT8 优化后 |
| 视频流处理帧率 | ≥ 15 FPS | **≥ 60 FPS** | TensorRT 加速 |
| 并发识别能力 | ≥ 5个/秒 | **≥ 50个/秒** | GPU 并行推理 |
| GPU 利用率 | 70%-90% | 70%-95% | 推理时 GPU 合理利用 |
| 内存占用 | < 8GB | **< 4GB** | 模型量化后内存占用 |
| 模型推理速度 | - | **≥ 300 FPS** | YOLO12 + TensorRT FP16 |

#### 2.2.2 可用性需求

| 指标 | 要求 |
|------|------|
| 系统可用性 | ≥ 99% |
| 平均故障恢复时间 | < 30分钟 |
| 计划内维护窗口 | 每月一次，控制在4小时内 |

#### 2.2.3 安全需求

| 需求类型 | 描述 |
|----------|------|
| 身份认证 | 支持用户名密码、Token 认证 |
| 权限控制 | 基于角色的访问控制（RBAC） |
| 数据加密 | HTTPS 传输加密，敏感数据存储加密 |
| 操作审计 | 记录所有操作日志，支持审计追溯 |

### 2.3 数据需求

#### 2.3.1 训练数据需求

| 数据类型 | 数量要求 | 格式要求 |
|----------|----------|----------|
| 设备正常状态图片 | 5000+ 张 | JPG/PNG, 640x640 或更高 |
| 设备故障状态图片 | 10000+ 张 | JPG/PNG, 包含各类故障类型 |
| 标注数据 | 全部图片 | YOLO TXT 格式标注 |

#### 2.3.2 存储需求

| 数据类型 | 存储量（预估） | 存储周期 |
|----------|----------------|----------|
| 训练数据集 | 50GB | 永久保留 |
| 识别历史 | 100GB/年 | 1年 |
| 模型文件 | 500MB | 版本管理 |
| 日志数据 | 10GB/年 | 6个月 |

---

## 3. 技术选型

### 3.1 YOLO 框架选型

#### 3.1.1 版本对比

| 版本 | 发布年份 | 优势 | 劣势 | 推荐度 |
|------|----------|------|------|--------|
| YOLOv8 | 2023 | 生态成熟，API 友好 | 相对较旧 | ★★★ |
| YOLOv10 | 2024 | 端到端设计，无 NMS 延迟 | 生态待完善 | ★★★★ |
| YOLO11 | 2025 | 最新版本，精度速度平衡最好 | 生态新 | ★★★★★ |
| YOLO12 | 2026 | 最新稳定版，性能最优，支持更多任务 | 刚发布 | ★★★★★ |

#### 3.1.2 最终选择：YOLO12

**选择理由：**

1. **技术先进性**
   - YOLO12 是 Ultralytics 官方发布的最新稳定版本（2026年）
   - 采用更先进的 CSPDarknet 主干网络
   - 引入 PAA（Probability Anchor Assignment）自适应锚框分配
   - 支持多种输入尺寸自适应
   - 新增注意力机制，精度进一步提升

2. **性能优势**
   - 在 COCO 数据集上达到 58.2% AP（最高精度版本）
   - 推理速度相比 YOLO11 提升约 25%
   - 参数量优化，内存占用更少
   - TensorRT 加速后可达 **300+ FPS**

3. **生态支持**
   - 与 ultralytics Python 包完美集成
   - 支持 ONNX、TensorRT、OpenVINO 等多种导出格式
   - 提供完整的训练、验证、部署工具链

4. **CUDA 兼容性**
   - 原生支持 CUDA 12.x
   - 对 NVIDIA GPU 有良好的优化
   - 支持多 GPU 并行训练

### 3.2 深度学习框架选型

#### 3.2.1 PyTorch vs TensorFlow 对比

| 特性 | PyTorch | TensorFlow |
|------|---------|------------|
| 学习曲线 | 平缓 | 较陡 |
| 动态图 | 支持 | 不支持（TF2.0后支持） |
| 部署工具 | TorchScript, ONNX | TF Serving, TFLite |
| YOLO 支持 | 官方支持 | 社区支持 |
| 社区活跃度 | 非常高 | 高 |

**最终选择：PyTorch**

选择理由：
- YOLOv11 官方使用 PyTorch 开发
- 动态图特性便于调试
- 与现有 Python 后端无缝集成
- 社区资源丰富

### 3.3 GPU 加速方案

#### 3.3.1 CUDA 版本选择

| CUDA 版本 | 支持的 PyTorch 版本 | 推荐度 |
|-----------|---------------------|--------|
| CUDA 11.8 | PyTorch 2.0-2.1 | ★★★ |
| CUDA 12.1 | PyTorch 2.2+ | ★★★★ |
| CUDA 12.4 | PyTorch 2.3+ | ★★★★★ |

**推荐配置：CUDA 12.4 + PyTorch 2.3+**

#### 3.3.2 cuDNN 优化

- 使用 cuDNN 8.9+ 获得最佳卷积性能
- 启用 cuDNN benchmark 模式
- 配置合适的 cudnn_tuner 参数

### 3.4 后端技术栈

| 组件 | 选型 | 版本 | 说明 |
|------|------|------|------|
| Web 框架 | FastAPI | 0.115+ | 异步高性能 API 框架 |
| 异步任务 | Celery + Redis | - | 后台任务队列 |
| 图片处理 | OpenCV + Pillow | - | 图像预处理 |
| 视频流 | OpenCV + FFmpeg | - | RTSP 流处理 |
| 数据库 | PostgreSQL + pgvector | 16 | 向量存储 |
| 缓存 | Redis | 7+ | 结果缓存 |

### 3.5 前端技术栈

| 组件 | 选型 | 版本 | 说明 |
|------|------|------|------|
| 框架 | React | 18+ | 核心框架 |
| UI 库 | Ant Design | 5+ | 组件库 |
| 状态管理 | Zustand | - | 轻量级状态管理 |
| 图片处理 | Fabric.js | - | Canvas 绘制 |
| 视频播放 | Video.js | - | 视频流播放 |

---

## 4. 系统架构设计

### 4.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           客户端层                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Web 浏览器  │  │   移动端 APP │  │  工业摄像头   │  │   API 客户端 │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
└─────────┼────────────────┼────────────────┼────────────────┼────────────┘
          │                │                │                │
          └────────────────┴────────────────┴────────────────┘
                                    │
                              HTTPS/WSS
                                    │
┌───────────────────────────────────┼───────────────────────────────────┐
│                           网关 / 负载均衡层                               │
│                        Nginx / Traefik                                 │
└───────────────────────────────────┼───────────────────────────────────┘
                                    │
┌───────────────────────────────────┼───────────────────────────────────┐
│                           应用服务层                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │
│  │   FastAPI 主服务  │  │   YOLO 推理服务  │  │   WebSocket 服务 │          │
│  │   (端口 8000)    │  │   (端口 8001)    │  │   (端口 8002)    │          │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │
│           │                    │                    │                    │
│  ┌────────┴────────────────────┴────────────────────┴────────┐          │
│  │                      Celery 异步任务队列                     │          │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │          │
│  │  │ 图片识别  │  │ 模型训练  │  │ 报告生成  │  │ 视频流处理 │  │          │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │          │
│  └───────────────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────┼───────────────────────────────────┐
│                           数据存储层                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  PostgreSQL  │  │     Redis    │  │   文件存储    │                  │
│  │  + pgvector  │  │   (缓存/队列) │  │ (MinIO/本地) │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────┼───────────────────────────────────┐
│                           GPU 计算层                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    NVIDIA GPU (CUDA)                              │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │    │
│  │  │  YOLOv11 模型 │  │  TensorRT 优化 │  │  多模型并行    │          │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 模块划分

| 模块名称 | 职责 | 技术实现 | 部署位置 |
|----------|------|----------|----------|
| vision-api | 图片识别 API | FastAPI + Uvicorn | Docker Container |
| vision-stream | 视频流处理 | FastAPI + OpenCV | Docker Container |
| vision-trainer | 模型训练服务 | PyTorch + Celery | 独立 GPU 服务器 |
| vision-worker | 异步任务处理 | Celery Worker | Docker Container |
| vision-frontend | 前端页面 | React + Ant Design | Nginx |

### 4.3 数据流向

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  用户输入 │ ──▶ │ 图片预处理│ ──▶ │ YOLO推理 │ ──▶ │ 结果后处理│ ──▶ │ 返回结果 │
└─────────┘     └─────────┘     └─────────┘     └─────────┘     └─────────┘
                     │               │               │
                     ▼               ▼               ▼
              ┌───────────┐   ┌───────────┐   ┌───────────┐
              │ 图片增强   │   │ GPU计算   │   │ 标注图片生成│
              │ 裁剪缩放   │   │ NMS过滤  │   │ 结果存储  │
              └───────────┘   └───────────┘   └───────────┘
```

---

## 5. 后端开发详细设计

### 5.1 项目结构

```
backend/
├── api/                          # API 路由
│   ├── __init__.py
│   ├── vision.py                 # 视觉识别 API
│   ├── vision_stream.py          # 视频流 API
│   ├── vision_model.py           # 模型管理 API
│   └── vision_dataset.py         # 数据集管理 API
├── core/                         # 核心模块
│   ├── vision/                   # 视觉识别核心
│   │   ├── __init__.py
│   │   ├── detector.py           # YOLO 检测器
│   │   ├── preprocessor.py       # 图片预处理
│   │   ├── postprocessor.py      # 结果后处理
│   │   ├── annotator.py         # 结果标注
│   │   └── tracker.py           # 目标跟踪（视频）
│   ├── models/                   # 模型管理
│   │   ├── __init__.py
│   │   ├── yolo_model.py         # YOLO 模型封装
│   │   ├── model_manager.py      # 模型管理器
│   │   └── trainer.py            # 模型训练器
│   ├── stream/                  # 视频流处理
│   │   ├── __init__.py
│   │   ├── rtsp_client.py        # RTSP 客户端
│   │   ├── frame_processor.py    # 帧处理器
│   │   └── stream_manager.py      # 流管理器
│   └── database/                 # 数据库
│       ├── models.py            # ORM 模型
│       └── connection.py         # 数据库连接
├── services/                     # 业务服务
│   ├── vision_service.py         # 视觉识别服务
│   ├── report_service.py         # 报告生成服务
│   └── alert_service.py          # 报警服务
├── schemas/                      # Pydantic 模型
│   ├── vision.py
│   └── stream.py
├── utils/                       # 工具函数
│   ├── image_utils.py
│   ├── file_utils.py
│   └── config_utils.py
├── tasks/                       # Celery 任务
│   ├── __init__.py
│   ├── detect_tasks.py
│   ├── train_tasks.py
│   └── report_tasks.py
├── config.py                    # 配置文件
├── main.py                      # 应用入口
└── requirements_vision.txt       # 视觉模块依赖
```

### 5.2 核心类设计

#### 5.2.1 YOLODetector 类

```python
class YOLODetector:
    """YOLO 目标检测器"""
    
    def __init__(
        self,
        model_path: str,
        device: str = "cuda",
        conf_threshold: float = 0.25,
        iou_threshold: float = 0.45,
        img_size: int = 640,
        half: bool = False
    ):
        """
        初始化检测器
        
        Args:
            model_path: 模型文件路径 (.pt, .onnx, .engine)
            device: 计算设备 ("cuda", "cpu", "mps")
            conf_threshold: 置信度阈值
            iou_threshold: IOU 阈值用于 NMS
            img_size: 输入图片尺寸
            half: 是否使用半精度推理
        """
        pass
    
    def detect(self, image: np.ndarray) -> DetectionResult:
        """
        执行目标检测
        
        Args:
            image: 输入图片 (H, W, C) RGB 格式
            
        Returns:
            DetectionResult: 检测结果
        """
        pass
    
    def detect_batch(self, images: List[np.ndarray]) -> List[DetectionResult]:
        """
        批量检测
        
        Args:
            images: 图片列表
            
        Returns:
            检测结果列表
        """
        pass
    
    def detect_file(self, file_path: str) -> DetectionResult:
        """
        检测图片文件
        
        Args:
            file_path: 图片文件路径
            
        Returns:
            检测结果
        """
        pass
    
    def warmup(self):
        """预热模型"""
        pass
    
    def get_model_info(self) -> dict:
        """获取模型信息"""
        pass
```

#### 5.2.2 StreamManager 类

```python
class StreamManager:
    """视频流管理器"""
    
    def __init__(self):
        self.streams: Dict[str, RTSPStream] = {}
        self.processors: Dict[str, FrameProcessor] = {}
    
    def add_stream(
        self,
        stream_id: str,
        url: str,
        model: YOLODetector,
        callback: Callable = None
    ) -> bool:
        """
        添加视频流
        
        Args:
            stream_id: 流 ID
            url: RTSP/HTTP 流地址
            model: 检测模型
            callback: 检测结果回调函数
            
        Returns:
            是否成功
        """
        pass
    
    def remove_stream(self, stream_id: str):
        """移除视频流"""
        pass
    
    def get_stream_status(self, stream_id: str) -> StreamStatus:
        """获取流状态"""
        pass
    
    def start_all(self):
        """启动所有流"""
        pass
    
    def stop_all(self):
        """停止所有流"""
        pass
```

#### 5.2.3 ModelTrainer 类

```python
class ModelTrainer:
    """YOLO 模型训练器"""
    
    def __init__(
        self,
        data_yaml: str,
        model_config: str = "yolo11n.yaml",
        output_dir: str = "./runs/train"
    ):
        """
        初始化训练器
        
        Args:
            data_yaml: 数据集配置文件路径
            model_config: 模型配置文件路径
            output_dir: 输出目录
        """
        pass
    
    def train(
        self,
        epochs: int = 100,
        batch_size: int = 16,
        img_size: int = 640,
        device: str = "cuda",
        resume: str = None,
        pretrained: bool = True
    ) -> TrainResult:
        """
        执行训练
        
        Args:
            epochs: 训练轮数
            batch_size: 批次大小
            img_size: 图片尺寸
            device: 训练设备
            resume: 恢复训练的检查点路径
            pretrained: 是否使用预训练权重
            
        Returns:
            TrainResult: 训练结果
        """
        pass
    
    def validate(self, weights: str = None) -> ValResult:
        """
        验证模型
        
        Args:
            weights: 模型权重路径
            
        Returns:
            ValResult: 验证结果
        """
        pass
    
    def export(
        self,
        weights: str,
        format: str = "onnx",
        img_size: int = 640
    ) -> str:
        """
        导出模型
        
        Args:
            weights: 模型权重路径
            format: 导出格式 (onnx, torchscript, tensorrt)
            img_size: 图片尺寸
            
        Returns:
            导出的模型路径
        """
        pass
```

### 5.3 API 路由设计

#### 5.3.1 图片识别 API

```python
@router.post("/detect/image")
async def detect_image(
    file: UploadFile = File(...),
    device: str = Form("cuda"),
    conf_threshold: float = Form(0.25),
    iou_threshold: float = Form(0.45),
    return_annotated: bool = Form(True)
) -> DetectionResponse:
    """
    上传图片进行目标检测
    
    - **file**: 图片文件 (jpg, png, bmp)
    - **device**: 计算设备 (cuda/cpu)
    - **conf_threshold**: 置信度阈值
    - **iou_threshold**: NMS IOU 阈值
    - **return_annotated**: 是否返回标注图片
    """
    pass

@router.post("/detect/batch")
async def detect_batch(
    files: List[UploadFile] = File(...),
    device: str = Form("cuda"),
    conf_threshold: float = Form(0.25)
) -> BatchDetectionResponse:
    """
    批量图片检测
    """
    pass

@router.post("/detect/base64")
async def detect_base64(
    image_data: str = Body(...),
    conf_threshold: float = Body(0.25)
) -> DetectionResponse:
    """
    Base64 编码图片检测
    """
    pass

@router.get("/detect/result/{task_id}")
async def get_detection_result(task_id: str) -> TaskResult:
    """
    获取异步检测任务结果
    """
    pass
```

#### 5.3.2 视频流 API

```python
@router.post("/stream/add")
async def add_stream(
    stream_id: str = Body(...),
    url: str = Body(...),
    name: str = Body(None),
    conf_threshold: float = Body(0.25)
) -> StreamResponse:
    """
    添加视频流
    
    - **stream_id**: 流唯一标识
    - **url**: RTSP/HTTP 流地址
    - **name**: 流名称
    """
    pass

@router.delete("/stream/{stream_id}")
async def remove_stream(stream_id: str) -> SuccessResponse:
    """
    移除视频流
    """
    pass

@router.get("/stream/{stream_id}/status")
async def get_stream_status(stream_id: str) -> StreamStatusResponse:
    """
    获取流状态
    """
    pass

@router.get("/stream/{stream_id}/snapshot")
async def get_stream_snapshot(stream_id: str) -> StreamingResponse:
    """
    获取流当前帧截图
    """
    pass

@router.websocket("/stream/{stream_id}/ws")
async def stream_websocket(websocket: WebSocket, stream_id: str):
    """
    WebSocket 实时推送检测结果
    """
    pass
```

#### 5.3.3 模型管理 API

```python
@router.get("/model/info")
async def get_model_info() -> ModelInfoResponse:
    """
    获取当前模型信息
    """
    pass

@router.post("/model/switch")
async def switch_model(
    model_name: str = Body(...),
    device: str = Body("cuda")
) -> SuccessResponse:
    """
    切换检测模型
    """
    pass

@router.get("/model/list")
async def list_models() -> List[ModelInfo]:
    """
    列出所有可用模型
    """
    pass

@router.post("/model/upload")
async def upload_model(
    file: UploadFile = File(...),
    name: str = Form(...)
) -> SuccessResponse:
    """
    上传新模型
    """
    pass
```

---

## 6. 前端开发详细设计

### 6.1 页面结构

```
frontend/src/
├── pages/
│   ├── VisionDetect.jsx         # 图片识别页面
│   ├── VisionStream.jsx         # 视频监控页面
│   ├── VisionHistory.jsx        # 识别历史页面
│   ├── VisionDataset.jsx        # 数据集管理页面
│   └── VisionDiagnose.jsx       # 视觉诊断页面（集成故障树）
├── components/
│   ├── vision/
│   │   ├── ImageUploader.jsx    # 图片上传组件
│   │   ├── ImageAnnotator.jsx   # 图片标注组件
│   │   ├── DetectionResult.jsx # 检测结果展示
│   │   ├── StreamPlayer.jsx     # 视频流播放器
│   │   ├── StreamConfig.jsx    # 流配置组件
│   │   ├── CameraGrid.jsx      # 多摄像头网格
│   │   ├── AlertPanel.jsx       # 报警面板
│   │   └── ReportGenerator.jsx # 报告生成组件
│   └── common/
│       ├── Loading.jsx
│       └── ErrorBoundary.jsx
├── services/
│   └── visionApi.js            # 视觉识别 API 服务
├── hooks/
│   ├── useVisionDetect.js      # 图片识别 Hook
│   ├── useVisionStream.js      # 视频流 Hook
│   └── useWebSocket.js          # WebSocket Hook
└── styles/
    └── vision.css              # 视觉模块样式
```

### 6.2 核心组件设计

#### 6.2.1 ImageUploader 组件

```jsx
// 图片上传组件
// 功能：
// - 支持拖拽上传
// - 支持点击上传
// - 支持批量上传
// - 支持图片预览

import React, { useState } from 'react';
import { Upload, Button, message } from 'antd';
import { UploadOutlined, InboxOutlined } from '@ant-design/icons';

const { Dragger } = Upload;

export default function ImageUploader({ onUpload, loading, maxCount = 9 }) {
  const [fileList, setFileList] = useState([]);
  
  const handleChange = (info) => {
    const { status } = info.file;
    if (status === 'done') {
      message.success(`${info.file.name} 上传成功`);
      onUpload?.(fileList);
    } else if (status === 'error') {
      message.error(`${info.file.name} 上传失败`);
    }
    setFileList(info.fileList);
  };
  
  const props = {
    name: 'file',
    multiple: true,
    maxCount,
    fileList,
    onChange: handleChange,
    beforeUpload: (file) => {
      const isImage = file.type.startsWith('image/');
      if (!isImage) {
        message.error('只能上传图片文件');
        return false;
      }
      const isLt10M = file.size / 1024 / 1024 < 10;
      if (!isLt10M) {
        message.error('图片大小不能超过 10MB');
        return false;
      }
      return true;
    },
  };
  
  return (
    <Dragger {...props}>
      <p className="ant-upload-drag-icon">
        <InboxOutlined />
      </p>
      <p className="ant-upload-text">点击或拖拽上传设备图片</p>
      <p className="ant-upload-hint">
        支持单张或批量上传，支持 jpg、png、bmp 格式
      </p>
    </Dragger>
  );
}
```

#### 6.2.2 DetectionResult 组件

```jsx
// 检测结果展示组件
// 功能：
// - 展示原始图片和标注图片
// - 展示检测到的目标列表
// - 展示统计信息
// - 支持切换查看不同结果

import React, { useState } from 'react';
import { Card, Row, Col, Table, Tag, Space, Button, Slider } from 'antd';
import { DownloadOutlined, ShareAltOutlined } from '@ant-design/icons';

export default function DetectionResult({ result, loading }) {
  const [showConfidence, setShowConfidence] = useState(0.3);
  
  const filteredDetections = result?.detections?.filter(
    d => d.confidence >= showConfidence
  ) || [];
  
  const columns = [
    { title: '类别', dataIndex: 'class', key: 'class',
      render: (text) => <Tag color="blue">{text}</Tag> },
    { title: '置信度', dataIndex: 'confidence', key: 'confidence',
      render: (v) => `${(v * 100).toFixed(1)}%` },
    { title: '位置', dataIndex: 'bbox', key: 'bbox',
      render: ([x, y, w, h]) => `[${x}, ${y}, ${w}, ${h}]` },
    { title: '面积占比', dataIndex: 'area_ratio', key: 'area_ratio',
      render: (v) => `${(v * 100).toFixed(2)}%` },
  ];
  
  return (
    <Card loading={loading}>
      <Row gutter={16}>
        {/* 标注图片 */}
        <Col span={12}>
          <img 
            src={result?.annotated_image} 
            alt="标注结果"
            style={{ width: '100%', borderRadius: 8 }}
          />
        </Col>
        
        {/* 统计信息 */}
        <Col span={12}>
          <div className="stats-panel">
            <div className="stat-item">
              <span className="stat-label">检测数量</span>
              <span className="stat-value">{filteredDetections.length}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">设备总数</span>
              <span className="stat-value">
                {new Set(filteredDetections.map(d => d.class)).size}
              </span>
            </div>
            <div className="stat-item">
              <span className="stat-label">异常数量</span>
              <span className="stat-value" style={{ color: 'red' }}>
                {filteredDetections.filter(d => d.is_anomaly).length}
              </span>
            </div>
          </div>
          
          {/* 置信度筛选 */}
          <div style={{ marginTop: 16 }}>
            <span>显示置信度 ≥ </span>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={showConfidence}
              onChange={setShowConfidence}
              style={{ width: 200, display: 'inline-block' }}
            />
            <span>{(showConfidence * 100).toFixed(0)}%</span>
          </div>
          
          <Space style={{ marginTop: 16 }}>
            <Button icon={<DownloadOutlined />}>下载结果</Button>
            <Button icon={<ShareAltOutlined />}>分享</Button>
          </Space>
        </Col>
      </Row>
      
      {/* 检测列表 */}
      <Table
        columns={columns}
        dataSource={filteredDetections}
        rowKey={(record, index) => `${record.class}-${index}`}
        style={{ marginTop: 16 }}
        size="small"
      />
    </Card>
  );
}
```

#### 6.2.3 VisionDetect 页面

```jsx
// 图片识别主页面
// 功能：
// - 图片上传
// - 一键识别
// - 结果展示
// - 快速生成故障树

import React, { useState } from 'react';
import { Layout, Row, Col, Card, Button, Space, message, Divider } from 'antd';
import ImageUploader from '../components/vision/ImageUploader';
import DetectionResult from '../components/vision/DetectionResult';
import { ThunderboltOutlined, RocketOutlined } from '@ant-design/icons';
import visionApi from '../services/visionApi';

const { Content } = Layout;

export default function VisionDetect() {
  const [images, setImages] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedResult, setSelectedResult] = useState(null);
  
  const handleDetect = async () => {
    if (images.length === 0) {
      message.warning('请先上传图片');
      return;
    }
    
    setLoading(true);
    try {
      const response = await visionApi.detectBatch(images);
      setResults(response.results);
      setSelectedResult(response.results[0]);
      message.success('识别完成');
    } catch (error) {
      message.error('识别失败: ' + error.message);
    }
    setLoading(false);
  };
  
  const handleGenerateFaultTree = () => {
    if (!selectedResult) {
      message.warning('请先选择识别结果');
      return;
    }
    // 跳转到故障树生成页面，传递识别结果
    const faultDescription = selectedResult.detections
      .map(d => `${d.class}（置信度${(d.confidence*100).toFixed(1)}%）`)
      .join('；');
    window.location.href = `/generate?vision_result=${encodeURIComponent(faultDescription)}`;
  };
  
  return (
    <Layout className="page-container">
      <Content>
        <Card title="设备视觉识别">
          <Row gutter={16}>
            {/* 左侧：上传区域 */}
            <Col span={8}>
              <ImageUploader onUpload={setImages} />
              
              <Divider />
              
              <Space direction="vertical" style={{ width: '100%' }}>
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  onClick={handleDetect}
                  loading={loading}
                  block
                  size="large"
                >
                  开始识别
                </Button>
                
                <Button
                  icon={<RocketOutlined />}
                  onClick={handleGenerateFaultTree}
                  block
                  disabled={!selectedResult}
                >
                  基于识别结果生成故障树
                </Button>
              </Space>
            </Col>
            
            {/* 右侧：结果展示 */}
            <Col span={16}>
              {selectedResult ? (
                <DetectionResult result={selectedResult} />
              ) : (
                <Card style={{ textAlign: 'center', padding: 100 }}>
                  <div style={{ fontSize: 64 }}>🔍</div>
                  <p>上传图片后点击识别按钮开始检测</p>
                </Card>
              )}
            </Col>
          </Row>
        </Card>
      </Content>
    </Layout>
  );
}
```

### 6.3 API 服务设计

```javascript
// visionApi.js
// 视觉识别 API 服务

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

class VisionApiService {
  // 图片识别
  async detectImage(file, options = {}) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('conf_threshold', options.confThreshold || 0.25);
    formData.append('iou_threshold', options.iouThreshold || 0.45);
    formData.append('return_annotated', options.returnAnnotated !== false);
    
    const response = await fetch(`${API_BASE_URL}/api/vision/detect/image`, {
      method: 'POST',
      body: formData,
    });
    
    if (!response.ok) {
      throw new Error(`识别失败: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  // 批量识别
  async detectBatch(files, options = {}) {
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    formData.append('conf_threshold', options.confThreshold || 0.25);
    
    const response = await fetch(`${API_BASE_URL}/api/vision/detect/batch`, {
      method: 'POST',
      body: formData,
    });
    
    return response.json();
  }
  
  // 获取识别历史
  async getHistory(params = {}) {
    const query = new URLSearchParams(params);
    const response = await fetch(`${API_BASE_URL}/api/vision/history?${query}`);
    return response.json();
  }
  
  // 流管理
  async addStream(config) {
    const response = await fetch(`${API_BASE_URL}/api/vision/stream/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    return response.json();
  }
  
  async removeStream(streamId) {
    const response = await fetch(`${API_BASE_URL}/api/vision/stream/${streamId}`, {
      method: 'DELETE',
    });
    return response.json();
  }
  
  // WebSocket 连接
  createStreamSocket(streamId, onMessage, onError) {
    const ws = new WebSocket(`ws://localhost:8000/api/vision/stream/${streamId}/ws`);
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      onMessage?.(data);
    };
    
    ws.onerror = (error) => {
      onError?.(error);
    };
    
    return ws;
  }
}

export default new VisionApiService();
```

---

## 7. YOLO 模型训练方案

### 7.1 数据集准备

#### 7.1.1 数据收集

**工业设备数据来源：**

1. **现场采集**
   - 使用工业相机拍摄真实设备图片
   - 覆盖不同光照、角度、距离条件
   - 记录设备型号、状态、故障类型

2. **公开数据集**
   - 工业安全数据集
   - 机械故障数据集
   - 电力设备数据集

3. **数据增强生成**
   - 基于 GAN 的故障图像生成
   - 基于物理模型的数据增强

**数据采集规范：**

| 项目 | 要求 |
|------|------|
| 图片格式 | JPG/PNG |
| 图片尺寸 | ≥ 640x640（推荐 1920x1080） |
| 分辨率 | 高清优先 |
| 光照条件 | 明亮、昏暗、逆光各占一定比例 |
| 拍摄角度 | 正面、侧面、斜面、俯视 |
| 遮挡情况 | 无遮挡、部分遮挡、严重遮挡 |
| 故障程度 | 轻微、中等、严重 |

#### 7.1.2 数据标注

**标注工具选择：**

1. **LabelImg**（开源免费）
   - 支持 YOLO TXT 格式
   - 界面简洁，操作方便
   - 适合中小型数据集

2. **Label Studio**（功能强大）
   - 支持多种标注类型
   - 支持团队协作
   - 适合大型项目

3. **CVAT**（企业级）
   - 支持自动标注
   - 支持视频标注
   - 适合大规模项目

**标注规范：**

```
类别定义：
┌─────────────────────────────────────────────────────────────┐
│ 类别ID │ 类别名称        │ 描述                    │ 颜色    │
├────────┼─────────────────┼──────────────────────────┼─────────┤
│ 0      │ motor_normal    │ 电机正常状态             │ 绿色    │
│ 1      │ motor_abnormal  │ 电机异常状态             │ 红色    │
│ 2      │ pump_normal     │ 泵正常状态               │ 绿色    │
│ 3      │ pump_leakage    │ 泵泄漏                   │ 红色    │
│ 4      │ valve_normal    │ 阀门正常                 │ 绿色    │
│ 5      │ valve_stuck     │ 阀门卡阻                 │ 橙色    │
│ 6      │ pipe_normal     │ 管道正常                 │ 绿色    │
│ 7      │ pipe_corrosion  │ 管道腐蚀                 │ 红色    │
│ 8      │ pipe_crack      │ 管道裂纹                 │ 红色    │
│ 9      │ bearing_wear    │ 轴承磨损                 │ 橙色    │
│ 10     │ bearing_overheat│ 轴承过热                 │ 红色    │
└─────────────────────────────────────────────────────────────┘
```

#### 7.1.3 数据集配置

```yaml
# data/industrial_equipment.yaml

# 数据集根目录
path: ./datasets/industrial_equipment
train: images/train
val: images/val
test: images/test

# 类别数量
nc: 11

# 类别名称
names:
  0: motor_normal
  1: motor_abnormal
  2: pump_normal
  3: pump_leakage
  4: valve_normal
  5: valve_stuck
  6: pipe_normal
  7: pipe_corrosion
  8: pipe_crack
  9: bearing_wear
  10: bearing_overheat

# 数据增强配置
augmentation:
  hsv_h: 0.015    # 色调增强
  hsv_s: 0.7      # 饱和度增强
  hsv_v: 0.4      # 亮度增强
  degrees: 10.0   # 旋转角度
  translate: 0.1  # 平移比例
  scale: 0.5     # 缩放比例
  shear: 0.0     # 剪切角度
  perspective: 0.0  # 透视变换
  flipud: 0.0    # 上下翻转
  fliplr: 0.5    # 左右翻转
  mosaic: 1.0    # 马赛克增强
  mixup: 0.1     # MixUp 增强
  copy_paste: 0.0  # Copy-Paste 增强
```

### 7.2 模型配置

#### 7.2.1 YOLOv11 模型变体选择

| 模型 | 参数量 | FLOPs | mAP@50 | 推理速度 | 适用场景 |
|------|--------|-------|--------|----------|----------|
| YOLOv11n | 2.6M | 6.5G | 39.5% | 最快 | 边缘设备、移动端 |
| YOLOv11s | 9.4M | 21.4G | 47.0% | 快 | 桌面端、轻量部署 |
| YOLOv11m | 19.9M | 67.7G | 51.5% | 中等 | 服务器、平衡场景 |
| YOLOv11l | 25.3M | 87.6G | 53.4% | 较慢 | 高精度需求 |
| YOLOv11x | 56.9M | 194.9G | 54.7% | 最慢 | 最高精度需求 |

**推荐选择：YOLOv11m**

选择理由：
- 在精度和速度之间取得良好平衡
- 适合服务器端部署
- 推理速度可满足实时性要求（配合 GPU）
- 内存占用适中

#### 7.2.2 自定义模型配置

```yaml
# models/yolo11m_custom.yaml

# YOLOv11m 配置文件

# 骨干网络
backbone:
  # [from, repeats, module, args]
  - [-1, 1, Conv, [64, 3, 2]]           # 0-P1/2  640->320
  - [-1, 1, Conv, [128, 3, 2]]         # 1-P2/4  320->160
  - [-1, 2, C3k2, [256, False, 0.25]]
  - [-1, 1, Conv, [256, 3, 2]]         # 3-P3/8  160->80
  - [-1, 2, C3k2, [512, False, 0.25]]
  - [-1, 1, SPPF, [512, 5]]             # 5
  - [-1, 2, C3k2, [512, True]]
  - [-1, 1, Conv, [512, 3, 2]]          # 7-P4/16 80->40
  - [-1, 2, C3k2, [512, True]]
  - [-1, 1, Conv, [512, 3, 2]]          # 9-P5/32 40->20
  - [-1, 2, C3k2, [512, True]]
  - [-1, 1, Conv, [512, 3, 2]]          # 11-P6/64 20->10
  - [-1, 2, C3k2, [768, True]]
  - [-1, 1, Conv, [768, 3, 2]]          # 13-P7/128 10->5
  - [-1, 2, C3k2, [1024, True]]

# 头部网络
head:
  - [-1, 1, nn.Upsample, [None, 2, 'nearest']]
  - [[-1, 10], 1, Concat, [1]]          # cat backbone P5
  - [-1, 2, C3k2, [512, False]]         # 16

  - [-1, 1, nn.Upsample, [None, 2, 'nearest']]
  - [[-1, 6], 1, Concat, [1]]           # cat backbone P4
  - [-1, 2, C3k2, [512, False]]         # 19

  - [-1, 1, nn.Upsample, [None, 2, 'nearest']]
  - [[-1, 4], 1, Concat, [1]]           # cat backbone P3
  - [-1, 2, C3k2, [256, False]]         # 22 (P3/8-small)

  - [-1, 1, Conv, [256, 3, 2]]
  - [[-1, 19], 1, Concat, [1]]          # cat head P4
  - [-1, 2, C3k2, [512, False]]         # 25 (P4/16-medium)

  - [-1, 1, Conv, [512, 3, 2]]
  - [[-1, 16], 1, Concat, [1]]          # cat head P5
  - [-1, 2, C3k2, [512, True]]          # 28 (P5/32-large)

  - [-1, 1, Conv, [512, 3, 2]]
  - [[-1, 13], 1, Concat, [1]]          # cat head P6
  - [-1, 2, C3k2, [768, True]]          # 31 (P6/64-xlarge)

  - [-1, 1, Conv, [768, 3, 2]]
  - [[-1, 28], 1, Concat, [1]]          # cat head P7
  - [-1, 2, C3k2, [1024, True]]          # 34 (P7/128-xxlarge)

  - [[22, 25, 28, 31, 34], 1, Detect, [nc]]  # Detect(P3, P4, P5, P6, P7)
```

### 7.3 训练配置

#### 7.3.1 训练脚本

```python
"""
YOLOv11 模型训练脚本
"""

from ultralytics import YOLO
import torch
import os

def train_yolo_model():
    """训练 YOLO 模型"""
    
    # 检查 GPU
    print(f"PyTorch 版本: {torch.__version__}")
    print(f"CUDA 可用: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"CUDA 版本: {torch.version.cuda}")
        print(f"GPU 数量: {torch.cuda.device_count()}")
        print(f"GPU 名称: {torch.cuda.get_device_name(0)}")
        print(f"GPU 内存: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.2f} GB")
    
    # 加载预训练模型
    model = YOLO('yolo11m.pt')  # 加载预训练权重
    
    # 训练配置
    results = model.train(
        # 数据配置
        data='data/industrial_equipment.yaml',
        
        # 训练参数
        epochs=300,                 # 训练轮数
        patience=50,               # 早停耐心值
        batch=16,                  # 批次大小（根据GPU内存调整）
        imgsz=640,                 # 输入图片尺寸
        
        # 优化器配置
        optimizer='AdamW',          # 优化器
        lr0=0.001,                 # 初始学习率
        lrf=0.01,                  # 最终学习率 = lr0 * lrf
        momentum=0.937,            # SGD 动量
        weight_decay=0.0005,       # 权重衰减
        
        # 数据增强
        augment=True,              # 数据增强
        mosaic=1.0,                # 马赛克增强
        mixup=0.1,                # MixUp 增强
        copy_paste=0.0,           # Copy-Paste 增强
        
        # 正则化
        hsv_h=0.015,              # 色调增强
        hsv_s=0.7,                # 饱和度增强
        hsv_v=0.4,                # 亮度增强
        degrees=10.0,             # 旋转角度
        translate=0.1,            # 平移比例
        scale=0.5,                # 缩放比例
        shear=2.0,                # 剪切角度
        flipud=0.0,               # 上下翻转
        fliplr=0.5,               # 左右翻转
        
        # 其他配置
        workers=8,                 # 数据加载线程数
        device=0,                 # GPU 设备编号
        project='runs/train',
        name='industrial_equipment',
        exist_ok=True,            # 覆盖已有结果
        pretrained=True,           # 使用预训练权重
        verbose=True,             # 详细输出
        seed=0,                   # 随机种子
        deterministic=True,      # 确定性强健性
        single_cls=False,         # 多类别检测
        rect=False,               # 矩形训练
        cos_lr=True,              # 余弦学习率调度
        close_mosaic=10,          # 最后N轮关闭马赛克
        resume=False,             # 恢复训练
        amp=True,                 # 混合精度训练
        cache=True,               # 缓存图片到内存（需要大内存）
        fraction=1.0,             # 使用数据集的比例
    )
    
    # 打印最佳模型路径
    print(f"最佳模型: {results.best}")
    print(f"最终模型: {results.last}")
    
    return results

def validate_model(weights_path):
    """验证模型"""
    model = YOLO(weights_path)
    
    results = model.val(
        data='data/industrial_equipment.yaml',
        batch=32,
        imgsz=640,
        device=0,
        split='test',  # 使用测试集
        save_json=True,
        save_hybrid=True,
    )
    
    print(f"mAP50: {results.box.map50:.4f}")
    print(f"mAP50-95: {results.box.map:.4f}")
    
    return results

def export_model(weights_path, format='onnx'):
    """导出模型"""
    model = YOLO(weights_path)
    
    # 导出为不同格式
    formats = ['onnx', 'torchscript', 'engine'] if format == 'all' else [format]
    
    for fmt in formats:
        model.export(format=fmt, imgsz=640, dynamic=False, simplify=True)
        print(f"导出 {fmt} 格式成功")

if __name__ == '__main__':
    # 训练模型
    train_yolo_model()
    
    # 验证模型
    validate_model('runs/train/industrial_equipment/weights/best.pt')
    
    # 导出模型
    export_model('runs/train/industrial_equipment/weights/best.pt', format='onnx')
```

#### 7.3.2 训练监控配置

```yaml
# training_config.yaml
# 训练配置文件

experiment:
  name: industrial_equipment_v1
  tags: [yolov11, industrial, fault_detection]
  notes: |
    工业设备故障视觉识别模型
    - 包含11个类别
    - 覆盖电机、泵、阀门、管道、轴承等设备
    
training:
  epochs: 300
  batch_size: 16
  image_size: 640
  device: cuda:0
  
  # 学习率调度
  lr:
    initial: 0.001
    final: 0.00001
    schedule: cosine  # cosine / linear / step
  
  # 早停
  early_stopping:
    enabled: true
    patience: 50
    min_delta: 0.0001
    
  # 混合精度
  amp:
    enabled: true
    dtype: float16
    
  # 多GPU训练
  multi_gpu:
    enabled: false
    devices: [0, 1]
    
dataset:
  train_split: 0.7    # 训练集比例
  val_split: 0.2      # 验证集比例
  test_split: 0.1     # 测试集比例
  min_images_per_class: 100  # 每类最小图片数

hyperparameters:
  weight_decay: 0.0005
  momentum: 0.937
  warmup_epochs: 3
  warmup_momentum: 0.8
  warmup_bias_lr: 0.1

augmentation:
  mosaic: 1.0
  mixup: 0.1
  hsv_h: 0.015
  hsv_s: 0.7
  hsv_v: 0.4
  degrees: 10.0
  translate: 0.1
  scale: 0.5
  shear: 2.0
  flipud: 0.0
  fliplr: 0.5
  
callbacks:
  on_train_start:
    - tensorboard
    - wandb
    
  on_train_end:
    - save_model
    - export_onnx
    - generate_report
```

### 7.4 模型优化

#### 7.4.1 TensorRT 优化

```python
"""
TensorRT 模型转换和优化
"""

from ultralytics import YOLO
import tensorrt as trt
import pycuda.driver as cuda
import pycuda.autoinit

def export_to_tensorrt(weights_path, output_dir='models'):
    """导出为 TensorRT 格式"""
    
    # 加载模型
    model = YOLO(weights_path)
    
    # 导出 ONNX
    onnx_path = model.export(format='onnx')
    
    # TensorRT 转换
    # 创建 builder 和 network
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH))
    config = builder.create_builder_config()
    
    # 设置精度
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 4 << 30)  # 4GB
    config.set_flag(trt.BuilderFlag.FP16)  # 使用半精度
    
    # 解析 ONNX
    parser = trt.OnnxParser(network, logger)
    with open(onnx_path, 'rb') as f:
        parser.parse(f.read())
    
    # 构建 engine
    engine = builder.build_serialized_network(network, config)
    
    # 保存 engine
    engine_path = f"{output_dir}/yolo11m_tensorrt.engine"
    with open(engine_path, 'wb') as f:
        f.write(engine)
    
    print(f"TensorRT 模型已保存: {engine_path}")
    return engine_path


class TensorRTDetector:
    """TensorRT 推理引擎"""
    
    def __init__(self, engine_path):
        """初始化 TensorRT 引擎"""
        
        # 加载 engine
        with open(engine_path, 'rb') as f:
            engine = trt.Runtime(logger).deserialize_cuda_engine(f.read())
        
        self.context = engine.create_execution_context()
        
        # 获取输入输出信息
        self.input_idx = 0
        self.output_idx = 1
        
        self.input_shape = engine.get_binding_shape(self.input_idx)
        self.output_shape = engine.get_binding_shape(self.output_idx)
        
        # 分配内存
        self.d_input = cuda.mem_alloc(trt.nptype(np.float32) * np.prod(self.input_shape))
        self.d_output = cuda.mem_alloc(trt.nptype(np.float32) * np.prod(self.output_shape))
        self.bindings = [int(self.d_input), int(self.d_output)]
        
        self.stream = cuda.Stream()
        
    def detect(self, image):
        """执行推理"""
        
        # 图片预处理
        input_data = self.preprocess(image)
        
        # 内存拷贝
        cuda.memcpy_htod_async(self.d_input, input_data, self.stream)
        
        # 推理
        self.context.execute_async_v2(self.bindings, self.stream.handle)
        
        # 拷贝结果
        output = np.empty(self.output_shape, dtype=np.float32)
        cuda.memcpy_dtoh_async(output, self.d_output, self.stream)
        
        self.stream.synchronize()
        
        # 后处理
        return self.postprocess(output)
```

#### 7.4.2 模型量化

```python
"""
INT8 量化推理
"""

def calibrate_for_int8(dataset_path, num_samples=100):
    """INT8 量化校准"""
    
    # 创建量化配置
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 4 << 30)
    config.set_flag(trt.BuilderFlag.INT8)
    
    # 创建校准器
    calibrator = DatasetCalibrator(
        dataset_path=dataset_path,
        num_samples=num_samples,
        input_shape=(1, 3, 640, 640)
    )
    config.int8_calibrator = calibrator
    
    # 构建 engine
    engine = builder.build_serialized_network(network, config)
    
    return engine


class DatasetCalibrator(trt.IInt8Calibrator):
    """数据集校准器"""
    
    def __init__(self, dataset_path, num_samples, input_shape):
        super().__init__()
        self.dataset_path = dataset_path
        self.num_samples = num_samples
        self.input_shape = input_shape
        self.current_idx = 0
        
        # 预加载数据到内存
        self.images = self.load_calibration_data()
        
    def get_batch(self, bindings, names):
        """获取一个批次的数据"""
        if self.current_idx < self.num_samples:
            batch = self.images[self.current_idx]
            cuda.memcpy_htod_async(bindings[0], batch, self.stream)
            self.current_idx += 1
            return True
        return False
    
    def get_batch_size(self):
        return 1
    
    def read_calibration_cache(self):
        """读取校准缓存"""
        if os.path.exists('calibration_cache.bin'):
            with open('calibration_cache.bin', 'rb') as f:
                return f.read()
        return None
    
    def write_calibration_cache(self, cache):
        """写入校准缓存"""
        with open('calibration_cache.bin', 'wb') as f:
            f.write(cache)
```

---

## 8. 数据库设计

### 8.1 ER 图

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ 设备类型     │     │   设备       │     │ 设备图像     │
│ (equipment_  │────<│ (equipment)  │────<│ (equipment_  │
│   type)      │     │              │     │   image)     │
└──────────────┘     └──────────────┘     └──────────────┘
                            │
                            │
                            ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ 故障类型     │     │ 视觉检测记录 │     │ 检测结果     │
│ (fault_type) │────<│ (vision_    │────<│ (detection_  │
│              │     │   detection) │     │   result)    │
└──────────────┘     └──────────────┘     └──────────────┘
                            │
                            ▼
┌──────────────┐     ┌──────────────┐
│ 视频流配置   │     │ 报警记录     │
│ (stream_    │────<│ (alert_     │
│   config)   │     │   record)    │
└──────────────┘     └──────────────┘
```

### 8.2 表结构设计

#### 8.2.1 设备类型表

```sql
CREATE TABLE equipment_type (
    type_id SERIAL PRIMARY KEY,
    type_name VARCHAR(100) NOT NULL UNIQUE,      -- 类型名称
    type_code VARCHAR(50) NOT NULL UNIQUE,       -- 类型代码
    description TEXT,                            -- 类型描述
    icon_url VARCHAR(500),                       -- 图标URL
    yolo_class_ids INTEGER[],                   -- 关联的YOLO类别ID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE equipment_type IS '设备类型表';
COMMENT ON COLUMN equipment_type.yolo_class_ids IS '该类型设备对应的YOLO检测类别ID数组';
```

#### 8.2.2 设备表

```sql
CREATE TABLE equipment (
    equipment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    equipment_name VARCHAR(200) NOT NULL,        -- 设备名称
    equipment_code VARCHAR(100) UNIQUE,          -- 设备编号
    equipment_type_id INTEGER REFERENCES equipment_type(type_id),
    location VARCHAR(500),                        -- 安装位置
    manufacturer VARCHAR(200),                   -- 制造商
    model VARCHAR(100),                          -- 型号
    serial_number VARCHAR(100),                  -- 序列号
    install_date DATE,                           -- 安装日期
    status VARCHAR(20) DEFAULT 'normal',        -- 状态：normal, warning, fault, offline
    metadata JSONB,                              -- 扩展信息
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_equipment_type ON equipment(equipment_type_id);
CREATE INDEX idx_equipment_status ON equipment(status);
```

#### 8.2.3 视觉检测记录表

```sql
CREATE TABLE vision_detection (
    detection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    equipment_id UUID REFERENCES equipment(equipment_id),
    detection_type VARCHAR(20) NOT NULL,         -- image, stream, batch
    source_url VARCHAR(500),                     -- 图片URL或流地址
    original_image_path VARCHAR(500),            -- 原始图片路径
    annotated_image_path VARCHAR(500),           -- 标注图片路径
    stream_id VARCHAR(100),                      -- 流ID（如果是视频流）
    device_info JSONB,                           -- 设备信息
    capture_time TIMESTAMP,                      -- 采集时间
    process_time_ms INTEGER,                     -- 处理耗时（毫秒）
    model_version VARCHAR(50),                  -- 使用的模型版本
    model_name VARCHAR(100),                     -- 模型名称
    conf_threshold FLOAT,                        -- 使用的置信度阈值
    total_detections INTEGER,                    -- 总检测数
    anomaly_count INTEGER DEFAULT 0,             -- 异常数量
    overall_status VARCHAR(20),                  -- 整体状态：normal, warning, critical
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100)                      -- 操作人
);

CREATE INDEX idx_detection_equipment ON vision_detection(equipment_id);
CREATE INDEX idx_detection_time ON vision_detection(capture_time);
CREATE INDEX idx_detection_status ON vision_detection(overall_status);
CREATE INDEX idx_detection_type ON vision_detection(detection_type);
```

#### 8.2.4 检测结果详情表

```sql
CREATE TABLE detection_result (
    result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detection_id UUID REFERENCES vision_detection(detection_id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL,                   -- 类别ID
    class_name VARCHAR(100) NOT NULL,            -- 类别名称
    confidence FLOAT NOT NULL,                   -- 置信度
    bbox_x INTEGER NOT NULL,                     -- 边界框X
    bbox_y INTEGER NOT NULL,                     -- 边界框Y
    bbox_width INTEGER NOT NULL,                 -- 边界框宽度
    bbox_height INTEGER NOT NULL,                -- 边界框高度
    area_ratio FLOAT,                            -- 面积占比
    is_anomaly BOOLEAN DEFAULT FALSE,            -- 是否异常
    anomaly_type VARCHAR(50),                    -- 异常类型
    anomaly_level VARCHAR(20),                   -- 异常等级：low, medium, high, critical
    severity_score FLOAT,                        -- 严重程度评分
    description TEXT,                            -- 描述
    suggestions TEXT,                            -- 处理建议
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 添加向量存储扩展（用于相似图片检索）
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE detection_feature (
    feature_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detection_id UUID REFERENCES vision_detection(detection_id) ON DELETE CASCADE,
    class_id INTEGER,
    image_embedding VECTOR(1024),                 -- 图像特征向量
    feature_hash VARCHAR(64),                    -- 特征哈希（用于去重）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_detection_result_detection ON detection_result(detection_id);
CREATE INDEX idx_detection_result_class ON detection_result(class_id);
CREATE INDEX idx_detection_result_anomaly ON detection_result(is_anomaly);
CREATE INDEX idx_detection_feature_embedding ON detection_feature USING ivfflat(image_embedding vector_cosine_ops);
```

#### 8.2.5 视频流配置表

```sql
CREATE TABLE stream_config (
    stream_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_name VARCHAR(200) NOT NULL,            -- 流名称
    stream_type VARCHAR(20) NOT NULL,            -- rtsp, http, hls, webcam
    stream_url VARCHAR(1000) NOT NULL,            -- 流地址
    equipment_id UUID REFERENCES equipment(equipment_id),
    enabled BOOLEAN DEFAULT TRUE,                -- 是否启用
    frame_interval INTEGER DEFAULT 1,            -- 抽帧间隔
    detection_enabled BOOLEAN DEFAULT TRUE,       -- 是否启用检测
    alert_enabled BOOLEAN DEFAULT TRUE,          -- 是否启用报警
    alert_threshold INTEGER DEFAULT 3,            -- 报警阈值（连续N帧异常触发报警）
    conf_threshold FLOAT DEFAULT 0.25,            -- 置信度阈值
    roi_x INTEGER,                                -- 感兴趣区域
    roi_y INTEGER,
    roi_width INTEGER,
    roi_height INTEGER,
    status VARCHAR(20) DEFAULT 'offline',        -- online, offline, error
    last_frame_time TIMESTAMP,                    -- 最后收到帧的时间
    last_detection_time TIMESTAMP,                 -- 最后检测到异常的时间
    fps FLOAT DEFAULT 0,                          -- 当前帧率
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stream_equipment ON stream_config(equipment_id);
CREATE INDEX idx_stream_status ON stream_config(status);
```

#### 8.2.6 报警记录表

```sql
CREATE TABLE alert_record (
    alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    detection_id UUID REFERENCES vision_detection(detection_id),
    stream_id UUID REFERENCES stream_config(stream_id),
    alert_type VARCHAR(50) NOT NULL,             -- anomaly_detected, threshold_exceeded, stream_offline
    alert_level VARCHAR(20) NOT NULL,            -- info, warning, error, critical
    title VARCHAR(200),                           -- 报警标题
    description TEXT,                            -- 报警描述
    equipment_id UUID REFERENCES equipment(equipment_id),
    snapshot_path VARCHAR(500),                   -- 报警截图路径
    detected_objects JSONB,                       -- 检测到的对象列表
    acknowledged BOOLEAN DEFAULT FALSE,            -- 是否已确认
    acknowledged_by VARCHAR(100),                  -- 确认人
    acknowledged_at TIMESTAMP,                     -- 确认时间
    resolved BOOLEAN DEFAULT FALSE,                -- 是否已解决
    resolved_by VARCHAR(100),                     -- 解决人
    resolved_at TIMESTAMP,                         -- 解决时间
    resolution TEXT,                              -- 解决方案
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_alert_detection ON alert_record(detection_id);
CREATE INDEX idx_alert_stream ON alert_record(stream_id);
CREATE INDEX idx_alert_equipment ON alert_record(equipment_id);
CREATE INDEX idx_alert_level ON alert_record(alert_level);
CREATE INDEX idx_alert_time ON alert_record(created_at);
CREATE INDEX idx_alert_acknowledged ON alert_record(acknowledged);
```

---

## 9. API 接口设计

### 9.1 接口列表

| 模块 | 接口路径 | 方法 | 描述 |
|------|----------|------|------|
| 图片识别 | /api/vision/detect/image | POST | 单张图片识别 |
| 图片识别 | /api/vision/detect/batch | POST | 批量图片识别 |
| 图片识别 | /api/vision/detect/base64 | POST | Base64图片识别 |
| 图片识别 | /api/vision/detect/async | POST | 异步图片识别 |
| 图片识别 | /api/vision/detect/result/{task_id} | GET | 获取异步任务结果 |
| 视频流 | /api/vision/stream/add | POST | 添加视频流 |
| 视频流 | /api/vision/stream/remove/{stream_id} | DELETE | 移除视频流 |
| 视频流 | /api/vision/stream/list | GET | 获取流列表 |
| 视频流 | /api/vision/stream/{stream_id}/status | GET | 获取流状态 |
| 视频流 | /api/vision/stream/{stream_id}/snapshot | GET | 获取流截图 |
| 视频流 | /ws/stream/{stream_id} | WebSocket | 实时推送 |
| 模型管理 | /api/vision/model/info | GET | 获取模型信息 |
| 模型管理 | /api/vision/model/list | GET | 获取模型列表 |
| 模型管理 | /api/vision/model/switch | POST | 切换模型 |
| 数据集 | /api/vision/dataset/upload | POST | 上传训练数据 |
| 数据集 | /api/vision/dataset/list | GET | 获取数据集列表 |
| 历史记录 | /api/vision/history | GET | 获取识别历史 |
| 历史记录 | /api/vision/history/{id} | GET | 获取历史详情 |
| 诊断 | /api/vision/diagnose | POST | 综合诊断（视觉+故障树） |
| 诊断 | /api/vision/report/{detection_id} | GET | 生成诊断报告 |

### 9.2 请求响应示例

#### 9.2.1 图片识别请求/响应

**请求：**
```
POST /api/vision/detect/image
Content-Type: multipart/form-data

file: [图片文件]
conf_threshold: 0.25
iou_threshold: 0.45
return_annotated: true
```

**响应：**
```json
{
  "success": true,
  "data": {
    "detection_id": "550e8400-e29b-41d4-a716-446655440000",
    "image_width": 1920,
    "image_height": 1080,
    "process_time_ms": 156,
    "model_name": "yolo11m_industrial_v1",
    "model_version": "1.0.0",
    "device": "cuda:0",
    "total_detections": 5,
    "anomaly_count": 2,
    "overall_status": "warning",
    "detections": [
      {
        "class_id": 3,
        "class_name": "pump_leakage",
        "confidence": 0.94,
        "bbox": [120, 340, 200, 180],
        "area_ratio": 0.17,
        "is_anomaly": true,
        "anomaly_type": "leakage",
        "anomaly_level": "high",
        "description": "泵体左侧发现明显液体泄漏痕迹"
      },
      {
        "class_id": 0,
        "class_name": "motor_normal",
        "confidence": 0.89,
        "bbox": [800, 200, 300, 400],
        "area_ratio": 0.56,
        "is_anomaly": false,
        "description": "电机外观正常，无明显异常"
      }
    ],
    "annotated_image": "/data/annotated/550e8400-e29b-41d4-a716-446655440000.jpg"
  }
}
```

#### 9.2.2 视频流添加请求/响应

**请求：**
```json
POST /api/vision/stream/add
Content-Type: application/json

{
  "stream_name": "生产线1号摄像头",
  "stream_type": "rtsp",
  "stream_url": "rtsp://192.168.1.100:554/stream1",
  "equipment_id": "550e8400-e29b-41d4-a716-446655440001",
  "conf_threshold": 0.3,
  "alert_enabled": true,
  "alert_threshold": 3
}
```

**响应：**
```json
{
  "success": true,
  "data": {
    "stream_id": "660e8400-e29b-41d4-a716-446655440002",
    "status": "online",
    "message": "视频流添加成功"
  }
}
```

---

## 10. Docker 部署方案

### 10.1 Dockerfile 设计

#### 10.1.1 视觉识别服务 Dockerfile

```dockerfile
# Dockerfile.vision
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# 设置环境变量
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV CUDA_HOME=/usr/local/cuda

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-dev \
    python3-pip \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    ffmpeg \
    libopencv-dev \
    && rm -rf /var/lib/apt/lists/*

# 设置 Python 符号链接
RUN ln -sf /usr/bin/python3.11 /usr/bin/python

# 安装 Python 依赖
COPY requirements_vision.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements_vision.txt

# 安装 ultralytics（YOLO）
RUN pip install --no-cache-dir ultralytics

# 创建应用目录
RUN mkdir -p /app/data/{models,uploads,annotated,streams}
WORKDIR /app

# 复制应用代码
COPY backend/ /app/backend/
COPY core/ /app/core/

# 下载预训练模型
RUN python -c "from ultralytics import YOLO; YOLO('yolo11m.pt')"

# 暴露端口
EXPOSE 8001

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8001/health || exit 1

# 启动命令
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8001"]
```

#### 10.1.2 requirements_vision.txt

```
# 核心依赖
fastapi==0.115.0
uvicorn[standard]==0.30.0
pydantic==2.9.0
pydantic-settings==2.5.0
python-multipart==0.0.9
aiofiles==24.1.0

# 图片处理
opencv-python==4.10.0.84
Pillow==10.4.0
imageio==2.35.1

# YOLO 相关
ultralytics==8.3.0
torch==2.4.0
torchvision==0.19.0

# GPU 加速
nvidia-cuda-runtime-cu12==12.4.0
nvidia-cublas-cu12==12.4.0
nvidia-cudnn-cu12==9.2.0

# 视频流处理
opencv-python-headless==4.10.0.84
ffmpeg-python==0.2.0

# 数据库
psycopg2-binary==2.9.10
asyncpg==0.30.0
sqlalchemy==2.0.30

# 异步任务
celery==5.4.0
redis==5.0.8
flower==2.0.1

# 工具库
numpy==1.26.4
scipy==1.14.1
pandas==2.2.2
matplotlib==3.9.2
seaborn==0.13.2

# WebSocket
websockets==12.0

# 日志
python-json-logger==2.0.7
loguru==0.7.2
```

### 10.2 Docker Compose 配置

```yaml
# docker-compose.vision.yml
version: '3.8'

services:
  # 视觉识别主服务
  vision-api:
    build:
      context: .
      dockerfile: Dockerfile.vision
    container_name: faulttree-vision-api
    ports:
      - "8001:8001"
    environment:
      - DATABASE_URL=postgresql+asyncpg://postgres:${DB_PASSWORD:-faulttree123}@db:5432/faulttree
      - REDIS_URL=redis://redis:6379/0
      - CUDA_VISIBLE_DEVICES=0
      - MODEL_PATH=/app/data/models
      - UPLOAD_PATH=/app/data/uploads
      - ANNOTATED_PATH=/app/data/annotated
    volumes:
      - ./data/models:/app/data/models
      - ./data/uploads:/app/data/uploads
      - ./data/annotated:/app/data/annotated
      - model_cache:/root/.cache/ultralytics
    depends_on:
      - redis
      - db
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # 视频流处理服务
  vision-stream:
    build:
      context: .
      dockerfile: Dockerfile.vision
    container_name: faulttree-vision-stream
    ports:
      - "8002:8002"
    environment:
      - CUDA_VISIBLE_DEVICES=0
      - REDIS_URL=redis://redis:6379/1
      - MODEL_PATH=/app/data/models
    volumes:
      - ./data/models:/app/data/models
      - ./data/streams:/app/data/streams
      - model_cache:/root/.cache/ultralytics
    depends_on:
      - redis
      - vision-api
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    command: uvicorn backend.api.vision_stream:app --host 0.0.0.0 --port 8002

  # Celery Worker
  vision-worker:
    build:
      context: .
      dockerfile: Dockerfile.vision
    container_name: faulttree-vision-worker
    environment:
      - CUDA_VISIBLE_DEVICES=0
      - REDIS_URL=redis://redis:6379/0
      - MODEL_PATH=/app/data/models
    volumes:
      - ./data/models:/app/data/models
      - model_cache:/root/.cache/ultralytics
    depends_on:
      - redis
      - db
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    command: celery -A backend.tasks worker --loglevel=info --concurrency=4

  # Redis
  redis:
    image: redis:7-alpine
    container_name: faulttree-redis
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

  # Flower (Celery 监控)
  flower:
    build:
      context: .
      dockerfile: Dockerfile.vision
    container_name: faulttree-flower
    ports:
      - "5555:5555"
    environment:
      - CELERY_BROKER_URL=redis://redis:6379/0
      - CELERY_RESULT_BACKEND=redis://redis:6379/0
    depends_on:
      - redis
      - vision-worker
    command: celery -A backend.tasks flower --port=5555

volumes:
  redis_data:
  model_cache:
```

---

## 11. 数据流程设计

### 11.1 图片识别数据流

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 用户上传  │───>│ 文件存储  │───>│ 图片预处理│───>│ YOLO推理 │───>│ 结果后处理│
│ 图片文件  │    │ MinIO/本地│    │ 缩放/归一化│   │ GPU计算  │    │ NMS/过滤 │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                                    │
        ┌───────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 异常判断  │───>│ 结果标注  │───>│ 数据库存储│───>│ WebSocket│───>│ 前端展示  │
│ 状态评级  │    │ 绘制框图  │    │ PostgreSQL│   │ 实时推送  │    │ React组件 │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### 11.2 视频流处理数据流

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ RTSP/HTTP│───>│ 视频流拉取│───>│ 帧提取   │───>│ 帧缓冲   │
│ 视频流   │    │ OpenCV   │    │ 按间隔抽帧│    │ RingBuffer│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                         │
         ┌───────────────────────────────────────────────┘
         │
         ▼
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ YOLO推理 │───>│ 结果聚合 │───>│ 报警判断 │───>│ 截图保存 │───>│ WebSocket│
│ GPU计算  │    │ 连续帧   │    │ 阈值触发 │    │ 异常帧   │    │ 推送     │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### 11.3 混合诊断数据流

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ 视觉识别结果 │    │ 文本描述    │    │ RAG知识检索 │
│ YOLO检测    │    │ 用户输入    │    │ 知识库匹配 │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │ 数据融合处理    │
                 │ 特征提取整合    │
                 └────────┬────────┘
                          │
                          ▼
                 ┌─────────────────┐    ┌─────────────────┐
                 │ LLM 故障树生成  │───>│ 故障树结构     │
                 │ MiniMax API    │    │ 最小割集计算   │
                 └────────┬────────┘    └─────────────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │ 综合诊断报告    │
                 │ 图片+识别+故障树 │
                 └─────────────────┘
```

---

## 12. 错误处理与容错机制

### 12.1 错误分类

| 错误类型 | 代码范围 | 说明 | 处理策略 |
|----------|----------|------|----------|
| 输入错误 | 4000-4999 | 参数错误、格式错误 | 返回详细错误信息 |
| 资源错误 | 5000-5999 | GPU不足、内存不足 | 重试或降级处理 |
| 服务错误 | 6000-6999 | 模型加载失败、服务不可用 | 切换备用服务 |
| 外部错误 | 7000-7999 | 视频流断开、存储故障 | 自动重连 |

### 12.2 重试机制

```python
from tenacity import retry, stop_after_attempt, wait_exponential

class YOLODetector:
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    def detect_with_retry(self, image):
        """带重试的检测"""
        try:
            return self.detect(image)
        except CUDAOutOfMemoryError:
            # 清理 GPU 内存
            torch.cuda.empty_cache()
            raise
        except Exception as e:
            if "timeout" in str(e).lower():
                raise
            return self.fallback_detect(image)
```

### 12.3 降级策略

```python
class ModelManager:
    def __init__(self):
        self.models = {
            'yolo11m': YOLODetector('yolo11m.pt'),
            'yolo11s': YOLODetector('yolo11s.pt'),  # 轻量备用
        }
        self.current_model = 'yolo11m'
        
    def detect_with_fallback(self, image):
        """降级检测"""
        try:
            # 尝试当前模型
            return self.models[self.current_model].detect(image)
        except GPUError:
            # 降级到轻量模型
            self.current_model = 'yolo11s'
            return self.models['yolo11s'].detect(image)
        except Exception:
            # 降级到 CPU
            return self.cpu_detect(image)
```

---

## 13. 性能优化策略

### 13.1 GPU 优化

```python
# GPU 优化配置
torch.cuda.empty_cache()  # 定期清理内存
torch.backends.cudnn.benchmark = True  # 启用 cuDNN 自动优化
torch.backends.cudnn.deterministic = False  # 牺牲确定性换取速度

# 混合精度推理
with torch.cuda.amp.autocast():
    results = model(image.half())  # 半精度推理
```

### 13.2 批处理优化

```python
class BatchDetector:
    def __init__(self, batch_size=8):
        self.batch_size = batch_size
        self.buffer = []
        
    def add(self, image):
        self.buffer.append(image)
        if len(self.buffer) >= self.batch_size:
            return self.process_batch()
        return None
        
    def process_batch(self):
        """批量处理"""
        batch = torch.stack(self.buffer)
        results = self.model(batch)
        self.buffer.clear()
        return results
```

### 13.3 缓存策略

```python
# Redis 缓存
@cache.memoize(timeout=3600)
def get_detection_result(detection_id):
    """缓存检测结果"""
    return db.query(DetectionResult).filter_by(id=detection_id).first()

# 模型预热
def warmup(self):
    """预热模型"""
    dummy_input = torch.randn(1, 3, 640, 640).cuda()
    for _ in range(10):
        self.model(dummy_input)
```

---

## 14. 安全考虑

### 14.1 输入验证

```python
from pydantic import BaseModel, validator

class ImageUpload(BaseModel):
    file: UploadFile
    conf_threshold: float = 0.25
    iou_threshold: float = 0.45
    
    @validator('file')
    def validate_file(cls, v):
        allowed_types = ['image/jpeg', 'image/png', 'image/bmp']
        if v.content_type not in allowed_types:
            raise ValueError(f'不支持的文件类型: {v.content_type}')
        
        # 检查文件大小
        file_size = v.file.seek(0, 2)
        v.file.seek(0)
        max_size = 10 * 1024 * 1024  # 10MB
        if file_size > max_size:
            raise ValueError(f'文件大小超过限制: {file_size / 1024 / 1024:.2f}MB')
        
        return v
```

### 14.2 权限控制

```python
from fastapi import Security, HTTPException
from fastapi.security import APIKeyHeader

api_key_header = APIKeyHeader(name="X-API-Key")

async def verify_api_key(api_key: str = Security(api_key_header)):
    if api_key not in valid_api_keys:
        raise HTTPException(status_code=403, detail="无效的API密钥")
    return api_key
```

---

## 15. 测试方案

### 15.1 单元测试

```python
# tests/test_detector.py
import pytest
from backend.core.vision.detector import YOLODetector

@pytest.fixture
def detector():
    return YOLODetector('models/yolo11m.pt', device='cpu')

def test_detector_init(detector):
    assert detector is not None
    assert detector.conf_threshold == 0.25

def test_detect_image(detector):
    import cv2
    image = cv2.imread('tests/fixtures/test_motor.jpg')
    result = detector.detect(image)
    
    assert result.total_detections >= 0
    assert result.process_time_ms > 0
```

### 15.2 集成测试

```python
# tests/test_api.py
import pytest
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def test_detect_image_endpoint():
    with open('tests/fixtures/test_motor.jpg', 'rb') as f:
        response = client.post(
            '/api/vision/detect/image',
            files={'file': f}
        )
    
    assert response.status_code == 200
    data = response.json()
    assert data['success'] is True
    assert 'detections' in data['data']
```

### 15.3 性能测试

```python
# tests/test_performance.py
import time
import pytest

def test_inference_speed(detector):
    import cv2
    image = cv2.imread('tests/fixtures/test_motor.jpg')
    
    # 预热
    for _ in range(5):
        detector.detect(image)
    
    # 性能测试
    times = []
    for _ in range(100):
        start = time.time()
        detector.detect(image)
        times.append(time.time() - start)
    
    avg_time = sum(times) / len(times)
    p95_time = sorted(times)[int(len(times) * 0.95)]
    
    assert avg_time < 0.5, f"平均推理时间过长: {avg_time:.3f}s"
    assert p95_time < 1.0, f"P95推理时间过长: {p95_time:.3f}s"
```

---

## 16. 部署步骤

### 16.1 环境准备

```bash
# 1. 安装 NVIDIA 驱动
# 参考: https://docs.nvidia.com/datacenter/tesla/tesla-installation-notes/

# 2. 安装 Docker
# 参考: https://docs.docker.com/engine/install/ubuntu/

# 3. 安装 NVIDIA Container Toolkit
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
    sudo tee /etc/apt/sources.list.d/nvidia-docker.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker

# 4. 验证 GPU 支持
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

### 16.2 部署执行

```bash
# 1. 克隆代码
git clone https://github.com/lalala-m/FaultTreeAI.git
cd FaultTreeAI

# 2. 创建必要目录
mkdir -p data/{models,uploads,annotated,streams,datasets}

# 3. 放置训练好的模型
# 将 yolo11m_industrial_v1.pt 放入 data/models/

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env，配置数据库、Redis等

# 5. 构建并启动服务
docker-compose -f docker-compose.vision.yml up -d

# 6. 查看服务状态
docker-compose -f docker-compose.vision.yml ps

# 7. 查看日志
docker-compose -f docker-compose.vision.yml logs -f vision-api
```

---

## 17. 运维与监控

### 17.1 监控指标

| 指标类型 | 指标名称 | 告警阈值 |
|----------|----------|----------|
| GPU | GPU 利用率 | < 30% 或 > 95% |
| GPU | GPU 显存使用 | > 90% |
| GPU | GPU 温度 | > 85°C |
| 服务 | API 响应时间 | > 2s |
| 服务 | API 错误率 | > 5% |
| 队列 | Celery 队列长度 | > 1000 |

### 17.2 日志管理

```python
# 配置日志
from loguru import logger
import sys

logger.configure(
    handlers=[
        {"sink": sys.stdout, "format": "{time} {level} {message}", "level": "INFO"},
        {"sink": "logs/vision.log", "rotation": "500 MB", "retention": "30 days"},
    ]
)
```

---

## 18. 风险评估与应对

| 风险 | 影响 | 概率 | 应对措施 |
|------|------|------|----------|
| GPU 资源不足 | 高 | 中 | 水平扩展、模型量化 |
| 模型精度不足 | 高 | 中 | 持续收集数据、迭代训练 |
| 视频流不稳定 | 中 | 高 | 自动重连、降级处理 |
| 数据标注成本高 | 中 | 高 | 半自动标注工具 |
| 算力成本高 | 中 | 低 | 弹性计算、模型优化 |

---

## 19. 开发计划与里程碑（P0 优先）

### 19.1 开发阶段（聚焦 P0 核心功能）

| 阶段 | 时间 | 目标 | 优先级 |
|------|------|------|--------|
| **Sprint 0** - 环境准备 | 第1周 | GPU环境、Docker、YOLO12安装、TensorRT配置 | P0 |
| **Sprint 1** - 图片识别API | 第2-3周 | 单张/批量图片识别、结果标注、YOLODetector封装 | P0 |
| **Sprint 2** - 性能优化 | 第4周 | TensorRT INT8优化、批处理优化、< 200ms响应 | P0 |
| **Sprint 3** - 故障树集成 | 第5-6周 | 识别结果→故障树、混合模式诊断、RAG融合 | P0 |
| **Sprint 4** - 视频流处理 | 第7-8周 | RTSP流拉取、实时检测、WebSocket推送 | P0 |
| **Sprint 5** - 前端页面 | 第9-10周 | VisionDetect页面、结果展示、生成故障树入口 | P0 |
| **Sprint 6** - 模型训练 | 第11-12周 | 数据收集、标注、YOLO12微调 | P1 |
| **Sprint 7** - 集成上线 | 第13-14周 | 系统集成、性能压测、监控配置 | P1 |

### 19.2 P0 核心功能清单

**第一阶段（Sprint 0-5）必须交付：**

| 功能 | 描述 | Sprint |
|------|------|--------|
| ✅ YOLO12环境 | GPU + CUDA + TensorRT 推理环境 | Sprint 0 |
| ✅ 单张图片识别 | 上传图片，< 200ms返回结果 | Sprint 1 |
| ✅ 识别结果标注 | 在原图绘制检测框、类别、置信度 | Sprint 1 |
| ✅ TensorRT优化 | INT8量化，≥ 300 FPS推理 | Sprint 2 |
| ✅ 故障树生成 | 识别结果转换为故障树输入 | Sprint 3 |
| ✅ 混合诊断 | 视觉+RAG+文本融合生成故障树 | Sprint 3 |
| ✅ 实时视频流 | RTSP摄像头实时检测、≥ 60 FPS | Sprint 4 |
| ✅ 前端识别页面 | 上传→识别→结果展示→生成故障树 | Sprint 5 |

### 19.3 P1 扩展功能（第二阶段）

| 功能 | 描述 |
|------|------|
| 报警触发机制 | 异常检测触发声音/视觉报警 |
| 截图保存 | 保存检测到异常的帧 |
| 诊断报告生成 | PDF/Word综合报告 |
| 自定义模型训练 | 使用自有数据训练YOLO12 |
| 多摄像头管理 | 同时监控多个摄像头 |

---

## 20. 附录

### 20.1 参考资源

1. **YOLOv11 官方文档**: https://docs.ultralytics.com/
2. **PyTorch 文档**: https://pytorch.org/docs/
3. **CUDA 文档**: https://docs.nvidia.com/cuda/
4. **FastAPI 文档**: https://fastapi.tiangolo.com/
5. **Docker GPU 支持**: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/

### 20.2 术语表

| 术语 | 说明 |
|------|------|
| YOLO | You Only Look Once，目标检测算法 |
| CUDA | NVIDIA 统一计算设备架构 |
| RAG | 检索增强生成 |
| FTA | 故障树分析 |
| MOCUS | 最小割集算法 |
| NMS | 非极大值抑制 |
| AP | 平均精度 |
| FPS | 帧每秒 |

### 20.3 联系方式

如有问题，请联系项目组：
- 项目负责人：[待定]
- 技术支持：[待定]
- 文档版本：v1.0

---

**文档结束**

*本方案为FaultTreeAI视觉识别模块的详细技术设计文档，如有疑问请联系项目组。*
