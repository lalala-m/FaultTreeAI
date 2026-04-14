/**
 * 视觉识别主页面
 * 整合图片上传、视频识别、摄像头捕获、识别、结果展示、故障树生成等功能
 */

import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Layout, Row, Col, Card, Button, message, Divider, Space, Tabs, Alert, Select, Tag, Empty } from 'antd';
import { ThunderboltOutlined, RocketOutlined, SyncOutlined, CameraOutlined, VideoCameraOutlined, PictureOutlined } from '@ant-design/icons';
import ImageUploader from '../../components/vision/ImageUploader';
import CameraCapture from '../../components/vision/CameraCapture';
import VideoUploader from '../../components/vision/VideoUploader';
import DetectionResult from '../../components/vision/DetectionResult';
import './VisionDetect.css';

const { Content } = Layout;

export default function VisionDetect({ onNavigate }) {
  const [images, setImages] = useState([]);
  const [cameraImage, setCameraImage] = useState(null);
  const [videoFrames, setVideoFrames] = useState([]);
  const [allImages, setAllImages] = useState([]);
  const [results, setResults] = useState(null);
  const [resultsSource, setResultsSource] = useState(null)
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('image');
  const tabsWrapRef = useRef(null)
  const [tabsOffset, setTabsOffset] = useState(0)
  const [cameraDevices, setCameraDevices] = useState([])
  const [cameraSlots, setCameraSlots] = useState([null, null, null, null])
  const [cameraShots, setCameraShots] = useState([])
  
  const [settings, setSettings] = useState({
    confThreshold: 0.25,
    iouThreshold: 0.45,
    returnAnnotated: true,
    modelKey: 'wire_break_seg',
  });

  useEffect(() => {
    const allowed = new Set(['auto', 'wire_break_seg', 'mvtec_fastener_det', 'yolo11m'])
    setSettings((prev) => {
      const mk = String(prev.modelKey || '').toLowerCase()
      if (!allowed.has(mk)) return { ...prev, modelKey: 'wire_break_seg' }
      return prev
    })
  }, [])

  useEffect(() => {
    setSettings((prev) => {
      const mk = String(prev.modelKey || '').toLowerCase()
      if (!mk) return prev
      if (mk === 'yolo11m' && prev.confThreshold < 0.2) {
        return { ...prev, confThreshold: 0.25 }
      }
      if (mk === 'wire_break_seg' && prev.confThreshold >= 0.2) {
        return { ...prev, confThreshold: 0.12 }
      }
      if ((mk === 'mvtec_fastener_det' || mk === 'auto') && prev.confThreshold >= 0.25) {
        return { ...prev, confThreshold: 0.15 }
      }
      return prev
    })
  }, [settings.modelKey])

  useEffect(() => {
    if (activeTab !== 'camera') return
    const loadDevices = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        const cams = (Array.isArray(list) ? list : []).filter(d => d?.kind === 'videoinput')
        setCameraDevices(cams)
        setCameraSlots((prev) => {
          const next = Array.isArray(prev) && prev.length === 4 ? [...prev] : [null, null, null, null]
          const ids = cams.map(d => d.deviceId).filter(Boolean)
          for (let i = 0; i < 4; i += 1) {
            if (next[i] && ids.includes(next[i])) continue
            next[i] = ids[i] || null
          }
          return next
        })
      } catch {
        setCameraDevices([])
      }
    }
    loadDevices()
  }, [activeTab])
  // 收集所有图片
  useEffect(() => {
    const collected = [];
    
    images.forEach((img, idx) => {
      if (img.originFileObj) {
        collected.push({
          id: `img-${idx}`,
          source: 'upload',
          file: img.originFileObj,
          preview: img.preview || img.url,
        });
      }
    });
    
    if (cameraImage) {
      collected.push({ id: 'camera-1', source: 'camera', base64: cameraImage });
    }
    
    videoFrames.forEach((frame) => {
      collected.push({ id: `video-${frame.id}`, source: 'video', base64: frame.image });
    });
    
    setAllImages(collected);
  }, [images, cameraImage, videoFrames]);

  const visibleResult = useMemo(() => {
    if (!results) return null
    const src = String(resultsSource || '').toLowerCase()
    const tab = String(activeTab || '').toLowerCase()
    const normalized = src === 'upload' ? 'image' : src
    if (!normalized) return results
    if (normalized === tab) return results
    if (tab === 'image' && normalized === 'image') return results
    return null
  }, [results, resultsSource, activeTab])

  const handleImageUpload = useCallback((fileList) => {
    setImages(fileList || []);
  }, []);

  const handleCameraCapture = useCallback((base64Image) => {
    setCameraImage(base64Image);
    message.success('摄像头图片已捕获');
  }, []);

  const handleVideoFrameCapture = useCallback((frames) => {
    setVideoFrames(frames || []);
  }, []);

  const handleDetect = useCallback(async () => {
    if (allImages.length === 0) {
      message.warning('请先上传图片、拍照或从视频中提取帧');
      return;
    }

    setLoading(true);
    setResults(null);

    try {
      const firstImage = allImages[0];
      const formData = new FormData();
      
      if (firstImage.source === 'upload' && firstImage.file) {
        formData.append('file', firstImage.file);
      } else {
        const base64Data = firstImage.base64.split(',')[1] || firstImage.base64;
        formData.append('image_data', base64Data);
      }
      
      formData.append('conf_threshold', settings.confThreshold.toString());
      formData.append('iou_threshold', settings.iouThreshold.toString());
      formData.append('return_annotated', settings.returnAnnotated.toString());
      formData.append('model_key', settings.modelKey);
      if (String(settings.modelKey || '').toLowerCase() === 'wire_break_seg') {
        formData.append('suppress_overlay', 'true')
      }

      const API_URL = import.meta.env.VITE_API_URL || '';
      const endpoint = (firstImage.source === 'upload' && firstImage.file)
        ? '/api/vision/detect/image'
        : '/api/vision/detect/base64';
      
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        let detail = response.statusText
        try {
          const errJson = await response.json()
          detail = errJson?.detail || errJson?.error || detail
        } catch {
        }
        throw new Error(`识别失败: ${detail}`);
      }

      const data = await response.json();
      const originalImageUrl = firstImage.source === 'upload' ? (firstImage.preview || '') : (firstImage.base64 || '')
      const src = firstImage.source === 'upload' ? 'image' : firstImage.source
      setResults({ ...data, original_image_url: originalImageUrl, source: src });
      setResultsSource(src)
      message.success(`识别完成！检测到 ${data.total_detections} 个结果，其中 ${data.anomaly_count} 个异常`);

    } catch (error) {
      console.error('识别错误:', error);
      const mock = createMockResult()
      setResults(mock);
      setResultsSource('image')
      message.warning('API 调用失败，使用模拟结果');
    } finally {
      setLoading(false);
    }
  }, [allImages, settings]);

  const primaryActionLabel = useMemo(() => {
    const mk = String(settings.modelKey || '').toLowerCase()
    if (mk === 'wire_break_seg') return '检测断裂'
    if (mk === 'mvtec_fastener_det') return '检测缺陷'
    return '识别当前图片'
  }, [settings.modelKey])

  const handleBatchDetect = useCallback(async () => {
    const runDetect = async (imagesList) => {
      if (!imagesList || imagesList.length === 0) return null
      const normalizedSources = new Set(
        imagesList.map((img) => (img?.source === 'upload' ? 'image' : String(img?.source || '').toLowerCase()))
      )
      const batchSource = normalizedSources.size === 1 ? [...normalizedSources][0] : String(activeTab || 'image').toLowerCase()
      const API_URL = import.meta.env.VITE_API_URL || ''
      const resultsList = []

      for (const img of imagesList) {
        try {
          const formData = new FormData()
          if (img.source === 'upload' && img.file) {
            formData.append('file', img.file)
          } else {
            const base64Data = (img.base64 || '').split(',')[1] || img.base64
            formData.append('image_data', base64Data)
          }
          formData.append('conf_threshold', settings.confThreshold.toString())
          formData.append('iou_threshold', settings.iouThreshold.toString())
          formData.append('return_annotated', settings.returnAnnotated.toString())
          formData.append('model_key', settings.modelKey)
          if (String(settings.modelKey || '').toLowerCase() === 'wire_break_seg') {
            formData.append('suppress_overlay', 'true')
          }

          const endpoint = (img.source === 'upload' && img.file)
            ? '/api/vision/detect/image'
            : '/api/vision/detect/base64'

          const response = await fetch(`${API_URL}${endpoint}`, { method: 'POST', body: formData })
          if (!response.ok) continue
          const data = await response.json()
          const originalImageUrl = img.source === 'upload' ? (img.preview || '') : (img.base64 || '')
          resultsList.push({ ...data, source: (img.source === 'upload' ? 'image' : img.source), original_image_url: originalImageUrl })
        } catch (e) {
          console.error('单张识别失败:', e)
        }
      }

      if (resultsList.length === 0) return null
      const totalDetections = resultsList.reduce((sum, r) => sum + (r.total_detections || 0), 0)
      const totalAnomalies = resultsList.reduce((sum, r) => sum + (r.anomaly_count || 0), 0)
      return {
        ...resultsList[0],
        total_detections: totalDetections,
        anomaly_count: totalAnomalies,
        batch_results: resultsList,
        source: batchSource,
      }
    }

    if (allImages.length === 0) {
      message.warning('没有可识别的图片');
      return;
    }

    setLoading(true);
    
    try {
      const merged = await runDetect(allImages)
      if (!merged) {
        message.error('所有图片识别失败')
        return
      }
      setResults(merged)
      setResultsSource(String(merged.source || activeTab || 'image'))
      message.success(`批量识别完成！共处理 ${(merged.batch_results || []).length} 张图片`)
      
    } catch (error) {
      console.error('批量识别错误:', error);
      message.error('批量识别失败');
    } finally {
      setLoading(false);
    }
  }, [allImages, settings, activeTab]);

  const handleGenerateFaultTree = useCallback(() => {
    const r0 = visibleResult
    if (!r0) {
      message.warning('请先进行识别');
      return;
    }
    
    const batch = Array.isArray(r0.batch_results) ? r0.batch_results : null
    const detections = batch
      ? batch.flatMap((r, idx) => (r.detections || []).map(d => ({ ...d, _frame: idx + 1 })))
      : (r0.detections || [])
    const anomalyDetections = detections.filter(d => d.is_anomaly)

    const fastenerMap = {
      metal_nut_bent: '螺母弯折',
      metal_nut_color: '螺母变色',
      metal_nut_flip: '螺母翻转异常',
      metal_nut_scratch: '螺母划痕',
      screw_manipulated_front: '螺丝正面异常',
      screw_scratch_head: '螺丝头部划痕',
      screw_scratch_neck: '螺丝颈部划痕',
      screw_thread_side: '螺丝侧面螺纹异常',
      screw_thread_top: '螺丝顶部螺纹异常',
      manipulated_front: '正面异常',
      scratch_head: '头部划痕',
      scratch_neck: '颈部划痕',
      thread_side: '侧面螺纹异常',
      thread_top: '顶部螺纹异常',
      bent: '弯折',
      color: '变色',
      flip: '翻转异常',
      scratch: '划痕',
    }

    let keywords = ''
    const classSet = new Set(detections.map(d => String(d?.class_name || '').trim()).filter(Boolean))
    const inferredKey = settings.modelKey === 'auto'
      ? ([...classSet].some(k => k === 'wire' || k === 'wire_break') ? 'wire_break_seg'
        : ([...classSet].some(k => k.startsWith('metal_nut_') || k.startsWith('screw_') || Object.prototype.hasOwnProperty.call(fastenerMap, k)) ? 'mvtec_fastener_det' : 'auto'))
      : settings.modelKey

    if (inferredKey === 'mvtec_fastener_det') {
      const groups = new Map()
      detections.forEach((d) => {
        const k = String(d?.class_name || '').trim()
        if (!k || k === 'good') return
        groups.set(k, Math.max(Number(groups.get(k) || 0), Number(d.confidence || 0)))
      })
      const list = [...groups.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => fastenerMap[k] || k)
      keywords = list.length ? `紧固件缺陷：${list.join('；')}` : '紧固件缺陷：未检测到明确异常'
    } else if (inferredKey === 'wire_break_seg') {
      const hasBreak = detections.some(d => String(d?.class_name || '').trim() === 'wire_break')
      keywords = hasBreak ? '线缆异常：电线断裂' : '线缆：未检测到断裂'
    } else {
      const list = (anomalyDetections.length > 0 ? anomalyDetections : detections)
        .filter(d => d?.class_name)
        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
        .slice(0, batch ? 6 : 3)
        .map(d => String(d.class_name))
      keywords = list.length ? `视觉异常：${[...new Set(list)].join('；')}` : '视觉异常：未检测到明确异常'
    }

    const lines = (anomalyDetections.length > 0 ? anomalyDetections : detections)
      .slice(0, batch ? 12 : 6)
      .map(d => {
        const prefix = batch ? `帧${d._frame}：` : ''
        return `${prefix}${d.class_name}（置信度${(d.confidence * 100).toFixed(1)}%）：${d.description}`
      })

    const summary = lines.join('；\n')

    if (anomalyDetections.length === 0) {
      message.info('未检测到异常，将使用当前识别结果生成故障树')
    }

    const visionId = `vision_${Date.now()}`
    try {
      sessionStorage.setItem(`faulttreeai_vision_result:${visionId}`, JSON.stringify(r0))
    } catch {
    }

    const payload = {
      vision_id: visionId,
      fault_description: keywords,
      equipment_type: inferredKey === 'wire_break_seg' ? 'cable' : inferredKey === 'mvtec_fastener_det' ? 'fastener' : 'other',
      source: 'vision'
    }
    try {
      sessionStorage.setItem('faulttreeai_pending_vision_to_generate', JSON.stringify(payload))
    } catch {
    }

    if (typeof onNavigate === 'function') {
      onNavigate('dashboard')
      setTimeout(() => {
        try {
          window.dispatchEvent(new CustomEvent('dashboard-inject', { detail: payload }))
        } catch {
        }
      }, 0)
      return
    }
    message.warning('无法跳转到总览页：缺少导航函数')
  }, [visibleResult, onNavigate, settings.modelKey]);

  const handleReset = useCallback(() => {
    setImages([]);
    setCameraImage(null);
    setVideoFrames([]);
    setAllImages([]);
    setResults(null);
    setResultsSource(null)
  }, []);

  const createMockResult = () => {
    return {
      detection_id: 'mock-' + Date.now(),
      image_width: 640,
      image_height: 480,
      process_time_ms: 20,
      model_name: 'yolo11m',
      device: 'cuda',
      total_detections: 3,
      anomaly_count: 2,
      overall_status: 'warning',
      detections: [
        { class_id: 0, class_name: 'motor_normal', confidence: 0.95, bbox: [100, 100, 300, 250], area_ratio: 0.25, is_anomaly: false, description: '电机外观正常' },
        { class_id: 3, class_name: 'bearing_wear', confidence: 0.87, bbox: [350, 200, 500, 350], area_ratio: 0.12, is_anomaly: true, description: '检测到轴承磨损，建议检查润滑系统' },
        { class_id: 5, class_name: 'pipe_corrosion', confidence: 0.72, bbox: [50, 300, 200, 420], area_ratio: 0.15, is_anomaly: true, description: '检测到管道腐蚀，需要进行防腐处理' }
      ],
      annotated_image: null
    };
  };

  const sourceStats = {
    upload: images.length,
    camera: cameraImage ? 1 : 0,
    video: videoFrames.length,
    total: allImages.length
  };

  const tabItems = useMemo(() => ([
    {
      key: 'image',
      label: <span><PictureOutlined /> 图片上传</span>,
      children: (
        <Card size="small">
          <ImageUploader onUpload={handleImageUpload} onDetect={handleDetect} loading={loading} maxCount={9} />
        </Card>
      )
    },
    {
      key: 'camera',
      label: <span><CameraOutlined /> 摄像头</span>,
      children: (
        <Card size="small">
          <Row gutter={[12, 12]}>
            {Array.from({ length: 4 }).map((_, idx) => (
              <Col key={idx} xs={12} sm={12}>
                <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontWeight: 600 }}>摄像头{idx + 1}</div>
                  <Select
                    size="small"
                    value={cameraSlots[idx]}
                    placeholder="选择设备"
                    style={{ width: 220, maxWidth: '100%' }}
                    options={cameraDevices.map((d, i) => ({
                      value: d.deviceId,
                      label: d.label || `摄像头设备${i + 1}`,
                    }))}
                    onChange={(v) => {
                      setCameraSlots((prev) => {
                        const next = Array.isArray(prev) && prev.length === 4 ? [...prev] : [null, null, null, null]
                        next[idx] = v
                        return next
                      })
                    }}
                    allowClear
                  />
                </div>
                <CameraCapture
                  key={`${idx}:${cameraSlots[idx] || 'default'}`}
                  title={`摄像头${idx + 1}实时识别`}
                  active={activeTab === 'camera'}
                  autoStart={false}
                  initialDeviceId={cameraSlots[idx]}
                  cameraIndex={idx + 1}
                  hideRecords
                  externalCapture
                  onRecord={(record) => {
                    if (!record?.image) return
                    setCameraShots((prev) => [record, ...(Array.isArray(prev) ? prev : [])].slice(0, 40))
                  }}
                  onCapture={(base64) => {
                    setCameraImage(base64)
                    handleCameraCapture(base64)
                  }}
                  onResult={(r) => { setResults(r); setResultsSource('camera') }}
                  disabled={loading}
                  modelKey={settings.modelKey}
                  confThreshold={settings.confThreshold}
                  iouThreshold={settings.iouThreshold}
                  returnAnnotated={settings.returnAnnotated}
                  intervalMs={260}
                />
              </Col>
            ))}
          </Row>
        </Card>
      )
    },
    {
      key: 'video',
      label: <span><VideoCameraOutlined /> 视频</span>,
      children: (
        <Card size="small">
          <VideoUploader
            onFrameCapture={(frame) => setVideoFrames(prev => [...prev, { id: frame.id, image: frame.image, time: frame.time }])}
            onDetect={async (frames) => {
              setVideoFrames(frames.map(f => ({ id: f.id, image: f.image, time: f.time })))
              setLoading(true)
              try {
                const imgs = frames.map(f => ({ id: `video-${f.id}`, source: 'video', base64: f.image }))
                const API_URL = import.meta.env.VITE_API_URL || ''
                const resultsList = []
                let firstError = null
                for (const img of imgs) {
                  const formData = new FormData()
                  const base64Data = (img.base64 || '').split(',')[1] || img.base64
                  formData.append('image_data', base64Data)
                  formData.append('conf_threshold', settings.confThreshold.toString())
                  formData.append('iou_threshold', settings.iouThreshold.toString())
                  formData.append('return_annotated', 'false')
                  formData.append('model_key', settings.modelKey)
                  formData.append('suppress_overlay', 'true')
                  const endpoint = '/api/vision/detect/base64'
                  const response = await fetch(`${API_URL}${endpoint}`, { method: 'POST', body: formData })
                  if (!response.ok) {
                    if (!firstError) {
                      try {
                        const errJson = await response.json()
                        firstError = errJson?.detail || errJson?.error || response.statusText
                      } catch {
                        firstError = response.statusText
                      }
                    }
                    continue
                  }
                  const data = await response.json()
                  resultsList.push({ ...data, source: img.source, original_image_url: img.base64 })
                }
                if (resultsList.length === 0) {
                  message.error(firstError ? `视频关键帧识别失败：${firstError}` : '视频关键帧识别失败')
                  return
                }
                const totalDetections = resultsList.reduce((sum, r) => sum + (r.total_detections || 0), 0)
                const totalAnomalies = resultsList.reduce((sum, r) => sum + (r.anomaly_count || 0), 0)
                setResults({
                  ...resultsList[0],
                  total_detections: totalDetections,
                  anomaly_count: totalAnomalies,
                  batch_results: resultsList,
                  source: 'video',
                })
                setResultsSource('video')
                message.success(`视频关键帧识别完成！共处理 ${resultsList.length} 帧`)
              } catch (e) {
                console.error('视频关键帧识别失败:', e)
                message.error('视频关键帧识别失败')
              } finally {
                setLoading(false)
              }
            }}
            disabled={loading}
          />
        </Card>
      )
    }
  ]), [handleImageUpload, handleDetect, loading, handleCameraCapture, setVideoFrames, settings, activeTab]);

  useLayoutEffect(() => {
    const el = tabsWrapRef.current
    if (!el) return

    const compute = () => {
      const nav = el.querySelector('.ant-tabs-nav')
      const h = nav ? nav.getBoundingClientRect().height : 0
      setTabsOffset(Math.max(0, Math.round(h)))
    }

    compute()

    let ro
    try {
      ro = new ResizeObserver(() => compute())
      ro.observe(el)
    } catch {
      window.addEventListener('resize', compute)
    }

    return () => {
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', compute)
    }
  }, [])

  return (
    <Layout className="vision-detect-page">
      <Content>
        <div className="vision-detect-shell">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <Button icon={<SyncOutlined />} onClick={handleReset} disabled={loading}>重置</Button>
          </div>

          {visibleResult?.anomaly_count > 0 && (
            <Alert
              message="检测到异常"
              description={`发现 ${visibleResult.anomaly_count} 个异常部位，建议生成故障树进行深入分析`}
              type="warning"
              showIcon
              action={<Button type="primary" icon={<RocketOutlined />} onClick={handleGenerateFaultTree} danger>生成故障树</Button>}
              style={{ marginBottom: 16 }}
            />
          )}

          <Row gutter={24}>
            <Col span={activeTab === 'camera' ? 14 : 10}>
              <div ref={tabsWrapRef}>
                <Tabs activeKey={activeTab} onChange={setActiveTab} size="small" items={tabItems} />
              </div>

              <Card size="small" style={{ marginTop: 16 }}>
                <div className="source-stats">
                  <div><span>图片上传:</span> <span>{sourceStats.upload} 张</span></div>
                  <div><span>摄像头:</span> <span>{sourceStats.camera} 张</span></div>
                  <div><span>视频帧:</span> <span>{sourceStats.video} 张</span></div>
                  <Divider style={{ margin: '8px 0' }} />
                  <div><span>总计:</span> <span>{sourceStats.total} 张</span></div>
                </div>
              </Card>

              <Card size="small" style={{ marginTop: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Divider>检测任务</Divider>
                  <Select
                    value={settings.modelKey}
                    onChange={(v) => setSettings((prev) => ({ ...prev, modelKey: v }))}
                    options={[
                      { value: 'wire_break_seg', label: '电线断裂检测（分割）（默认）' },
                      { value: 'mvtec_fastener_det', label: '紧固件缺陷检测' },
                      { value: 'yolo11m', label: '通用目标检测（yolo11m）' },
                    ]}
                  />
                  {String(settings.modelKey || '').toLowerCase() === 'wire_break_seg' && (
                    <Alert
                      type="info"
                      showIcon
                      message="电线断裂检测说明"
                      description="绿色区域为电线分割结果，红框为疑似断裂位置；未出现红框表示未检测到断裂。"
                    />
                  )}
                  <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleDetect} loading={loading} size="large" block disabled={allImages.length === 0}>
                    {primaryActionLabel}
                  </Button>
                  
                  {allImages.length > 1 && (
                    <Button icon={<ThunderboltOutlined />} onClick={handleBatchDetect} loading={loading} size="large" block>
                      批量处理所有图片 ({allImages.length}张)
                    </Button>
                  )}
                </Space>
              </Card>
            </Col>

            <Col span={activeTab === 'camera' ? 10 : 14} style={{ paddingTop: tabsOffset }}>
              {activeTab === 'camera' && (
                <Card size="small" style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <Space size={8} wrap>
                      <div style={{ fontWeight: 600 }}>摄像头截图</div>
                      <Tag color="blue">{cameraShots.length}</Tag>
                    </Space>
                    <Button size="small" onClick={() => setCameraShots([])} disabled={cameraShots.length === 0}>清空</Button>
                  </div>
                  {cameraShots.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无截图" />
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      {cameraShots.slice(0, 8).map((s) => (
                        <div key={s.id} style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                          <div style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#000' }}>
                            <img src={s.image} alt="shot" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
                          </div>
                          <div style={{ padding: 8 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <Tag>{`摄像头${s.cameraIndex || '-'}`}</Tag>
                              <span style={{ fontSize: 12, color: '#999' }}>{new Date(s.ts).toLocaleTimeString('zh-CN')}</span>
                            </div>
                            <div style={{ fontSize: 12, color: s.type === 'anomaly' ? '#fa8c16' : s.type === 'manual' ? '#1677ff' : '#ff4d4f', marginTop: 4 }}>
                              {String(s.message || '')}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}
              <DetectionResult result={visibleResult} loading={loading} onGenerateFaultTree={handleGenerateFaultTree} hideImage={activeTab === 'camera'} />
            </Col>
          </Row>
        </div>
      </Content>
    </Layout>
  );
}
