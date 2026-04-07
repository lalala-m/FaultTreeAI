/**
 * 摄像头捕获组件
 * 支持本地摄像头实时预览、拍照
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Button, Card, Space, message, Spin, Tag } from 'antd';
import { CameraOutlined, StopOutlined, SaveOutlined, ReloadOutlined } from '@ant-design/icons';

const CAMERA_CONFIG = { width: 640, height: 480, frameRate: { ideal: 30, max: 30 }, facingMode: 'environment' };

export default function CameraCapture({
  active = true,
  onCapture,
  onResult,
  disabled = false,
  modelKey = 'wire_break_seg',
  confThreshold = 0.25,
  iouThreshold = 0.45,
  returnAnnotated = true,
  intervalMs = 900,
}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [capturedImage, setCapturedImage] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [isDetecting, setIsDetecting] = useState(false)
  const [lastInfo, setLastInfo] = useState(null)
  const [pauseDetect, setPauseDetect] = useState(false)
  const [overlayUrl, setOverlayUrl] = useState(null)
  const [lastError, setLastError] = useState(null)
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectTimerRef = useRef(null)
  const inFlightRef = useRef(false)
  const abortRef = useRef(null)

  const startCamera = useCallback(async (options = {}) => {
    const { silent = false } = options || {}
    try {
      setLoading(true);
      setCameraError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: CAMERA_CONFIG.width,
          height: CAMERA_CONFIG.height,
          frameRate: CAMERA_CONFIG.frameRate,
          facingMode: CAMERA_CONFIG.facingMode,
        },
        audio: false
      });
      
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsStreaming(true);
      }
      
      if (!silent) message.success('摄像头已启动');
    } catch (error) {
      console.error('摄像头启动失败:', error);
      let errorMsg = '无法访问摄像头';
      if (error.name === 'NotAllowedError') errorMsg = '请允许浏览器访问摄像头';
      else if (error.name === 'NotFoundError') errorMsg = '未找到摄像头设备';
      setCameraError(errorMsg);
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  }, []);

  const stopCamera = useCallback((options = {}) => {
    const { silent = false } = options || {}
    try {
      if (detectTimerRef.current) {
        clearInterval(detectTimerRef.current)
        detectTimerRef.current = null
      }
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
      inFlightRef.current = false
      setIsDetecting(false)
    } catch {
    }
    setOverlayUrl(null)
    setLastError(null)
    const hadStream = !!streamRef.current
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsStreaming(false);
    if (!silent && hadStream) message.info('摄像头已关闭');
  }, []);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    
    const imageData = canvas.toDataURL('image/jpeg', 0.85);
    setCapturedImage(imageData);
    setShowPreview(true);
    
    if (onCapture) onCapture(imageData);
    message.success('已拍照');
  }, [onCapture]);

  const retake = useCallback(() => {
    setCapturedImage(null);
    setShowPreview(false);
  }, []);

  const saveImage = useCallback(() => {
    if (!capturedImage) return;
    const link = document.createElement('a');
    link.href = capturedImage;
    link.download = `capture_${Date.now()}.jpg`;
    link.click();
    message.success('图片已保存');
  }, [capturedImage]);

  const doDetectOnce = useCallback(async () => {
    if (disabled) return
    if (pauseDetect) return
    if (!isStreaming) return
    if (!videoRef.current || !canvasRef.current) return
    const video = videoRef.current
    if (!video.videoWidth || !video.videoHeight) return
    if (inFlightRef.current) return

    const canvas = canvasRef.current
    const vw = video.videoWidth
    const vh = video.videoHeight
    const maxSide = 640
    const scale = Math.min(1, maxSide / Math.max(vw, vh))
    const tw = Math.max(1, Math.round(vw * scale))
    const th = Math.max(1, Math.round(vh * scale))
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, tw, th)
    const frameDataUrl = canvas.toDataURL('image/jpeg', 0.75)
    const base64Data = frameDataUrl.split(',')[1] || frameDataUrl

    const API_URL = import.meta.env.VITE_API_URL || ''
    const formData = new FormData()
    formData.append('image_data', base64Data)
    formData.append('conf_threshold', String(confThreshold))
    formData.append('iou_threshold', String(iouThreshold))
    formData.append('return_annotated', String(returnAnnotated))
    formData.append('model_key', String(modelKey || 'wire_break_seg'))
    formData.append('suppress_overlay', 'true')

    try {
      inFlightRef.current = true
      setIsDetecting(true)
      setLastError(null)
      if (abortRef.current) abortRef.current.abort()
      const ac = new AbortController()
      abortRef.current = ac
      const t0 = performance.now()
      const resp = await fetch(`${API_URL}/api/vision/detect/base64`, { method: 'POST', body: formData, signal: ac.signal })
      const ms = Math.round(performance.now() - t0)
      if (!resp.ok) {
        let detail = resp.statusText
        try {
          const err = await resp.json()
          detail = err?.detail || err?.error || detail
        } catch {
        }
        setLastError(String(detail || '识别失败'))
        return
      }
      const data = await resp.json()
      const result = { ...data, original_image_url: frameDataUrl }
      setLastInfo({ ms, detections: result?.total_detections || 0, anomalies: result?.anomaly_count || 0 })
      if (result?.annotated_image) {
        setOverlayUrl(`data:image/jpeg;base64,${result.annotated_image}`)
      } else {
        setOverlayUrl(null)
      }
      if (typeof onResult === 'function') onResult(result)
    } catch (e) {
      if (e?.name === 'AbortError') return
      setLastError('识别失败')
    } finally {
      inFlightRef.current = false
      setIsDetecting(false)
    }
  }, [disabled, pauseDetect, isStreaming, confThreshold, iouThreshold, returnAnnotated, modelKey, onResult])

  useEffect(() => {
    if (!active) {
      stopCamera({ silent: true })
      return
    }
    return undefined
  }, [active, stopCamera])

  useEffect(() => {
    if (!active) return
    if (!isStreaming) return
    if (pauseDetect) return
    if (disabled) return
    if (detectTimerRef.current) clearInterval(detectTimerRef.current)
    detectTimerRef.current = setInterval(() => {
      doDetectOnce()
    }, Math.max(350, Number(intervalMs) || 900))
    return () => {
      if (detectTimerRef.current) {
        clearInterval(detectTimerRef.current)
        detectTimerRef.current = null
      }
    }
  }, [active, isStreaming, pauseDetect, disabled, intervalMs, doDetectOnce])

  const statusTag = useMemo(() => {
    if (!isStreaming) return null
    if (pauseDetect) return <Tag>已暂停识别</Tag>
    if (isDetecting) return <Tag color="processing">识别中</Tag>
    return <Tag color="green">实时识别</Tag>
  }, [isStreaming, pauseDetect, isDetecting])

  useEffect(() => {
    return () => stopCamera({ silent: true });
  }, [stopCamera]);

  return (
    <Card size="small" title="摄像头实时识别"
      extra={
        <Space>
          {!isStreaming ? (
            <Button type="primary" icon={<CameraOutlined />} onClick={startCamera} loading={loading} disabled={disabled} size="small">
              启动摄像头
            </Button>
          ) : (
            <>
              <Button onClick={() => setPauseDetect(v => !v)} size="small" disabled={disabled}>
                {pauseDetect ? '继续识别' : '暂停识别'}
              </Button>
              <Button danger icon={<StopOutlined />} onClick={stopCamera} size="small">关闭</Button>
            </>
          )}
        </Space>
      }
    >
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      
      <div className="camera-container" style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3', minHeight: 360, background: '#f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.9)' }}>
            <Spin size="large" />
            <p>正在启动摄像头...</p>
          </div>
        )}
        
        {cameraError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#ff4d4f' }}>
            <p>{cameraError}</p>
            <Button icon={<ReloadOutlined />} onClick={startCamera}>重试</Button>
          </div>
        )}
        
        {!isStreaming && !loading && !cameraError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
            <CameraOutlined style={{ fontSize: 48 }} />
            <p>点击"启动摄像头"开始预览</p>
          </div>
        )}
        
        <video ref={videoRef} style={{ display: isStreaming ? 'block' : 'none', position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} playsInline muted />

        {isStreaming && !showPreview && overlayUrl && (
          <img
            src={overlayUrl}
            alt="overlay"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
          />
        )}
        
        {showPreview && capturedImage && (
          <div style={{ position: 'absolute', inset: 0, background: '#000' }}>
            <img src={capturedImage} alt="Preview" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
        )}
      </div>

      {isStreaming && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Space>
            {statusTag}
            {lastInfo && (
              <span style={{ color: '#666' }}>
                {lastInfo.ms}ms / {lastInfo.detections} 结果 / {lastInfo.anomalies} 异常
              </span>
            )}
            {lastError && (
              <Tag color="red">{lastError}</Tag>
            )}
          </Space>
          {!showPreview && (
            <Button icon={<CameraOutlined />} onClick={capturePhoto} size="small" disabled={disabled}>截图</Button>
          )}
        </div>
      )}
      
      {showPreview && capturedImage && (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <Space>
            <Button type="primary" icon={<SaveOutlined />} onClick={saveImage}>保存图片</Button>
            <Button icon={<ReloadOutlined />} onClick={retake}>重拍</Button>
          </Space>
        </div>
      )}
      
      <div style={{ marginTop: 12 }}>
        <small style={{ color: '#999' }}>提示：实时识别会定时上传当前帧进行推理；点击“截图”可保存当前画面</small>
      </div>
    </Card>
  );
}
