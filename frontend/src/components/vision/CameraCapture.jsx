/**
 * 摄像头捕获组件
 * 支持本地摄像头实时预览、拍照
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Button, Card, Space, message, Spin, Tag } from 'antd';
import { CameraOutlined, StopOutlined, SaveOutlined, ReloadOutlined } from '@ant-design/icons';

const CAMERA_CONFIG = { width: 640, height: 480, frameRate: { ideal: 60, max: 60 }, facingMode: 'environment' };

export default function CameraCapture({
  title = '摄像头实时识别',
  active = true,
  autoStart = false,
  initialDeviceId = null,
  onCapture,
  onResult,
  onErrorRecord,
  onRecord,
  disabled = false,
  modelKey = 'wire_break_seg',
  confThreshold = 0.25,
  iouThreshold = 0.45,
  returnAnnotated = true,
  intervalMs = 900,
  hideRecords = false,
  externalCapture = false,
  cameraIndex = null,
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
  const [deviceCandidates, setDeviceCandidates] = useState([])
  const [multiCamActive, setMultiCamActive] = useState(false)
  const [errorRecords, setErrorRecords] = useState([])
  const [detectIntervalMs, setDetectIntervalMs] = useState(() => Math.max(160, Number(intervalMs) || 260))
  const [showOverlay, setShowOverlay] = useState(false)
  const [showBoxes, setShowBoxes] = useState(true)
  const [streamInfo, setStreamInfo] = useState(null)
  const [lastDetections, setLastDetections] = useState([])
  const [lastFrameSize, setLastFrameSize] = useState(null)
  const [showAllRecords, setShowAllRecords] = useState(false)
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayCanvasRef = useRef(null)
  const containerRef = useRef(null)
  const streamRef = useRef(null);
  const detectTimerRef = useRef(null)
  const inFlightRef = useRef(false)
  const abortRef = useRef(null)
  const multiVideoRefs = useRef([])
  const multiStreamsRef = useRef([])
  const selectedDeviceIdRef = useRef(null)
  const detectIntervalRef = useRef(Math.max(160, Number(intervalMs) || 260))
  const consecutiveErrorRef = useRef(0)
  const lastErrorRecordAtRef = useRef(0)
  const lastFaultRecordAtRef = useRef(0)
  const lastFaultSignatureRef = useRef('')
  const recordLimiterRef = useRef(new Map())
  const lastLimitToastAtRef = useRef(0)
  const manualStoppedRef = useRef(false)

  const allowRecord = useCallback((deviceId) => {
    const key = String(deviceId || cameraIndex || 'default')
    const now = Date.now()
    const winMs = 60_000
    const limit = 10
    const m = recordLimiterRef.current
    const prev = m.get(key)
    const arr = Array.isArray(prev) ? prev.filter(t => now - Number(t || 0) < winMs) : []
    if (arr.length >= limit) return false
    arr.push(now)
    m.set(key, arr)
    return true
  }, [])

  const toastLimit = useCallback(() => {
    const now = Date.now()
    if (now - (lastLimitToastAtRef.current || 0) < 3000) return
    lastLimitToastAtRef.current = now
    message.info('该摄像头 1 分钟内故障记录已达 10 条上限')
  }, [])

  const drawDetectionsOnCanvas = useCallback((canvas, detections, srcSize) => {
    const ctx = canvas?.getContext?.('2d')
    if (!ctx) return
    const dets = Array.isArray(detections) ? detections : []
    if (dets.length === 0) return
    const cw = Number(canvas.width || 0)
    const ch = Number(canvas.height || 0)
    if (!cw || !ch) return
    const srcW = Number(srcSize?.width || cw)
    const srcH = Number(srcSize?.height || ch)
    const sx = srcW ? (cw / srcW) : 1
    const sy = srcH ? (ch / srcH) : 1

    ctx.lineWidth = Math.max(2, Math.round(cw / 320))
    ctx.font = `${Math.max(12, Math.round(cw / 42))}px sans-serif`

    for (const det of dets) {
      const box = Array.isArray(det?.bbox) ? det.bbox : null
      if (!box || box.length !== 4) continue
      const [x1, y1, x2, y2] = box.map(v => Number(v) || 0)
      if (x2 <= x1 || y2 <= y1) continue
      const isAnomaly = !!det?.is_anomaly
      const color = isAnomaly ? '#ff4d4f' : '#52c41a'
      const rx = x1 * sx
      const ry = y1 * sy
      const rw2 = (x2 - x1) * sx
      const rh2 = (y2 - y1) * sy
      ctx.strokeStyle = color
      ctx.strokeRect(rx, ry, rw2, rh2)

      const name = String(det?.class_name || '').trim()
      const conf = Number(det?.confidence)
      const label = name ? `${name}${Number.isFinite(conf) ? ` ${(Math.round(conf * 1000) / 10).toFixed(1)}%` : ''}` : ''
      if (!label) continue
      const pad = 4
      const metrics = ctx.measureText(label)
      const tw = metrics.width + pad * 2
      const th = Math.max(14, Math.round(cw / 44)) + pad * 2
      const tx = Math.max(0, Math.min(cw - tw, rx))
      const ty = Math.max(0, ry - th)
      ctx.fillStyle = isAnomaly ? 'rgba(255,77,79,0.85)' : 'rgba(82,196,26,0.85)'
      ctx.fillRect(tx, ty, tw, th)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, tx + pad, ty + th - pad)
    }
  }, [])

  const stopMultiCam = useCallback(() => {
    try {
      const streams = Array.isArray(multiStreamsRef.current) ? multiStreamsRef.current : []
      streams.forEach((s) => {
        try { s?.getTracks?.().forEach(t => t.stop()) } catch {}
      })
      multiStreamsRef.current = []
      multiVideoRefs.current.forEach((v) => { try { if (v) v.srcObject = null } catch {} })
    } catch {
    }
    setMultiCamActive(false)
  }, [])

  const startMultiCam = useCallback(async () => {
    try {
      setLoading(true)
      setMultiCamActive(true)
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoInputs = (Array.isArray(devices) ? devices : []).filter((d) => d?.kind === 'videoinput')
      const picked = videoInputs.slice(0, 4).map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `摄像头${idx + 1}`,
      }))
      setDeviceCandidates(picked)
      const streams = []
      for (let i = 0; i < picked.length; i += 1) {
        const item = picked[i]
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: item.deviceId ? { exact: item.deviceId } : undefined,
              width: CAMERA_CONFIG.width,
              height: CAMERA_CONFIG.height,
              frameRate: CAMERA_CONFIG.frameRate,
            },
            audio: false
          })
          streams[i] = stream
          const v = multiVideoRefs.current[i]
          if (v) {
            v.srcObject = stream
            await v.play()
          }
        } catch {
          streams[i] = null
        }
      }
      multiStreamsRef.current = streams
    } catch {
      setDeviceCandidates([])
    } finally {
      setLoading(false)
    }
  }, [])

  const startCamera = useCallback(async (options = {}) => {
    const { silent = false, deviceId = null } = options || {}
    try {
      setLoading(true);
      setCameraError(null);
      stopMultiCam()
      manualStoppedRef.current = false
      selectedDeviceIdRef.current = deviceId || selectedDeviceIdRef.current || null
      
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
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
      try {
        const track = stream?.getVideoTracks?.()?.[0]
        const settings = track?.getSettings?.() || {}
        const fps = Number(settings.frameRate)
        const w = Number(settings.width)
        const h = Number(settings.height)
        setStreamInfo({
          frameRate: Number.isFinite(fps) ? fps : null,
          width: Number.isFinite(w) ? w : null,
          height: Number.isFinite(h) ? h : null,
        })
      } catch {
        setStreamInfo(null)
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
  }, [startMultiCam, stopMultiCam]);

  const stopCamera = useCallback((options = {}) => {
    const { silent = false } = options || {}
    try {
      if (detectTimerRef.current) {
        clearTimeout(detectTimerRef.current)
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
    setLastDetections([])
    setLastFrameSize(null)
    setShowAllRecords(false)
    lastFaultRecordAtRef.current = 0
    lastFaultSignatureRef.current = ''
    if (!silent) manualStoppedRef.current = true
    try { recordLimiterRef.current = new Map() } catch {}
    const hadStream = !!streamRef.current
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsStreaming(false);
    setStreamInfo(null)
    stopMultiCam()
    selectedDeviceIdRef.current = null
    if (!silent && hadStream) message.info('摄像头已关闭');
  }, [stopMultiCam]);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    let imageData = canvas.toDataURL('image/jpeg', 0.85)
    if (showBoxes && Array.isArray(lastDetections) && lastDetections.length > 0) {
      drawDetectionsOnCanvas(canvas, lastDetections, lastFrameSize || { width: video.videoWidth, height: video.videoHeight })
      imageData = canvas.toDataURL('image/jpeg', 0.85)
    }
    if (!externalCapture) {
      setCapturedImage(imageData);
      setShowPreview(true);
    }
    
    if (onCapture) onCapture(imageData);
    if (typeof onRecord === 'function') {
      const now = Date.now()
      onRecord({ id: `evt_${now}_${Math.random().toString(16).slice(2, 8)}`, ts: now, image: imageData, message: '手动截图', deviceId: selectedDeviceIdRef.current, status: 200, type: 'manual', cameraIndex })
    }
    message.success('已拍照');
  }, [externalCapture, onCapture, onRecord, cameraIndex, showBoxes, lastDetections, lastFrameSize, drawDetectionsOnCanvas]);

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
    formData.append('return_annotated', String(!!(returnAnnotated && showOverlay)))
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
        const status = Number(resp.status || 0)
        const msg = status === 503
          ? '服务不可用，已自动降频'
          : String(detail || '识别失败')
        setLastError(msg)
        consecutiveErrorRef.current = Math.min(999, (consecutiveErrorRef.current || 0) + 1)
        const now = Date.now()
        if (now - (lastErrorRecordAtRef.current || 0) >= 1200) {
          lastErrorRecordAtRef.current = now
          if (allowRecord(selectedDeviceIdRef.current)) {
            const record = { id: `evt_${now}_${Math.random().toString(16).slice(2, 8)}`, ts: now, image: frameDataUrl, message: msg, deviceId: selectedDeviceIdRef.current, status, type: 'error' }
            setErrorRecords(prev => [record, ...prev].slice(0, 20))
            if (typeof onErrorRecord === 'function') onErrorRecord(record)
            if (typeof onRecord === 'function') onRecord({ ...record, cameraIndex })
          } else {
            toastLimit()
          }
        }
        const cur = Math.max(160, Number(detectIntervalRef.current) || 260)
        const next = Math.min(5000, Math.max(260, Math.round(cur * 1.8)))
        detectIntervalRef.current = next
        setDetectIntervalMs(next)
        if (status === 503 && consecutiveErrorRef.current >= 3) {
          setPauseDetect(true)
          message.warning('视觉识别服务暂不可用，已暂停识别；可点击“继续识别”重试')
        }
        return { ok: false, ms, status }
      }
      const data = await resp.json()
      const result = { ...data, original_image_url: frameDataUrl }
      consecutiveErrorRef.current = 0
      setLastInfo({ ms, detections: result?.total_detections || 0, anomalies: result?.anomaly_count || 0 })
      setLastDetections(Array.isArray(result?.detections) ? result.detections : [])
      setLastFrameSize({ width: Number(result?.image_width || tw), height: Number(result?.image_height || th) })

      try {
        const dets = Array.isArray(result?.detections) ? result.detections : []
        const anomalies = dets.filter(d => !!d?.is_anomaly)
        if (anomalies.length > 0) {
          const top = anomalies
            .slice()
            .sort((a, b) => Number(b?.confidence || 0) - Number(a?.confidence || 0))[0]
          const cls = String(top?.class_name || '').trim() || '异常'
          const conf = Number(top?.confidence)
          const msg = Number.isFinite(conf)
            ? `检测到异常：${cls} ${(Math.round(conf * 1000) / 10).toFixed(1)}%`
            : `检测到异常：${cls}`
          const signature = anomalies
            .slice()
            .sort((a, b) => String(a?.class_name || '').localeCompare(String(b?.class_name || '')))
            .map(d => `${String(d?.class_name || '')}:${Math.round(Number(d?.confidence || 0) * 100)}`)
            .join('|')
          const now = Date.now()
          const lastAt = Number(lastFaultRecordAtRef.current || 0)
          const lastSig = String(lastFaultSignatureRef.current || '')
          const shouldRecord = (now - lastAt >= 1600) && (signature !== lastSig || now - lastAt >= 6000)
          if (shouldRecord) {
            if (allowRecord(selectedDeviceIdRef.current)) {
              lastFaultRecordAtRef.current = now
              lastFaultSignatureRef.current = signature
              let recordImage = frameDataUrl
              try {
                drawDetectionsOnCanvas(canvas, dets, { width: Number(result?.image_width || tw), height: Number(result?.image_height || th) })
                recordImage = canvas.toDataURL('image/jpeg', 0.85)
              } catch {
              }
              const record = { id: `evt_${now}_${Math.random().toString(16).slice(2, 8)}`, ts: now, image: recordImage, message: msg, deviceId: selectedDeviceIdRef.current, status: 200, type: 'anomaly' }
              setErrorRecords(prev => [record, ...prev].slice(0, 20))
              if (typeof onRecord === 'function') onRecord({ ...record, cameraIndex })
            } else {
              toastLimit()
            }
          }
        }
      } catch {
      }

      if (showOverlay && result?.annotated_image) {
        setOverlayUrl(`data:image/jpeg;base64,${result.annotated_image}`)
      } else {
        setOverlayUrl(null)
      }
      if (typeof onResult === 'function') onResult(result)
      const suggested = Math.min(1200, Math.max(160, Math.round(ms * 1.25)))
      const next = Math.max(160, Math.min(suggested, Math.round(Number(intervalMs) || 260)))
      detectIntervalRef.current = next
      setDetectIntervalMs(next)
      return { ok: true, ms, status: 200 }
    } catch (e) {
      if (e?.name === 'AbortError') return
      const msg = '识别失败'
      setLastError(msg)
      consecutiveErrorRef.current = Math.min(999, (consecutiveErrorRef.current || 0) + 1)
      const now = Date.now()
      if (now - (lastErrorRecordAtRef.current || 0) >= 1200) {
        lastErrorRecordAtRef.current = now
        if (allowRecord(selectedDeviceIdRef.current)) {
          const record = { id: `evt_${now}_${Math.random().toString(16).slice(2, 8)}`, ts: now, image: frameDataUrl, message: msg, deviceId: selectedDeviceIdRef.current, status: 0, type: 'error' }
          setErrorRecords(prev => [record, ...prev].slice(0, 20))
          if (typeof onErrorRecord === 'function') onErrorRecord(record)
          if (typeof onRecord === 'function') onRecord({ ...record, cameraIndex })
        } else {
          toastLimit()
        }
      }
      const cur = Math.max(160, Number(detectIntervalRef.current) || 260)
      const next = Math.min(5000, Math.max(260, Math.round(cur * 1.8)))
      detectIntervalRef.current = next
      setDetectIntervalMs(next)
      return { ok: false, ms: null, status: 0 }
    } finally {
      inFlightRef.current = false
      setIsDetecting(false)
    }
  }, [disabled, pauseDetect, isStreaming, confThreshold, iouThreshold, returnAnnotated, modelKey, onResult, onErrorRecord, onRecord, allowRecord, toastLimit, cameraIndex])

  useEffect(() => {
    if (!active) {
      stopCamera({ silent: true })
      return
    }
    return undefined
  }, [active, stopCamera])

  useEffect(() => {
    if (!active) return
    if (!autoStart) return
    if (disabled) return
    if (loading) return
    if (cameraError) return
    if (isStreaming) return
    if (manualStoppedRef.current) return
    const did = (initialDeviceId || '').trim() || null
    startCamera({ silent: true, deviceId: did })
  }, [active, autoStart, disabled, loading, cameraError, isStreaming, startCamera, initialDeviceId])

  useEffect(() => {
    if (!active) return
    if (!isStreaming) return
    if (pauseDetect) return
    if (disabled) return
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current)
    const tick = async () => {
      await doDetectOnce()
      if (!active || !isStreaming || pauseDetect || disabled) return
      detectTimerRef.current = setTimeout(tick, Math.max(160, Number(detectIntervalRef.current) || 260))
    }
    detectTimerRef.current = setTimeout(tick, Math.max(160, Number(detectIntervalRef.current) || 260))
    return () => {
      if (detectTimerRef.current) {
        clearTimeout(detectTimerRef.current)
        detectTimerRef.current = null
      }
    }
  }, [active, isStreaming, pauseDetect, disabled, doDetectOnce])

  useEffect(() => {
    const base = Math.max(160, Number(intervalMs) || 260)
    detectIntervalRef.current = base
    setDetectIntervalMs(base)
  }, [intervalMs])

  const statusTag = useMemo(() => {
    if (!isStreaming) return null
    if (pauseDetect) return <Tag>已暂停识别</Tag>
    if (isDetecting) return <Tag color="processing">识别中</Tag>
    return <Tag color="green">实时识别 {detectIntervalMs}ms</Tag>
  }, [isStreaming, pauseDetect, isDetecting, detectIntervalMs])

  const drawBoxes = useCallback(() => {
    const canvas = overlayCanvasRef.current
    const wrap = containerRef.current
    const video = videoRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cw = wrap.clientWidth || 0
    const ch = wrap.clientHeight || 0
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(cw * dpr))
    canvas.height = Math.max(1, Math.round(ch * dpr))
    canvas.style.width = `${cw}px`
    canvas.style.height = `${ch}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)

    if (!showBoxes) return
    if (!Array.isArray(lastDetections) || lastDetections.length === 0) return

    const srcW = Number(lastFrameSize?.width || video?.videoWidth || 0)
    const srcH = Number(lastFrameSize?.height || video?.videoHeight || 0)
    if (!srcW || !srcH) return

    const scale = Math.min(cw / srcW, ch / srcH)
    const rw = srcW * scale
    const rh = srcH * scale
    const ox = (cw - rw) / 2
    const oy = (ch - rh) / 2

    ctx.lineWidth = Math.max(2, Math.round(cw / 320))
    ctx.font = `${Math.max(12, Math.round(cw / 42))}px sans-serif`

    for (const det of lastDetections) {
      const box = Array.isArray(det?.bbox) ? det.bbox : null
      if (!box || box.length !== 4) continue
      const [x1, y1, x2, y2] = box.map(v => Number(v) || 0)
      if (x2 <= x1 || y2 <= y1) continue
      const isAnomaly = !!det?.is_anomaly
      const color = isAnomaly ? '#ff4d4f' : '#52c41a'
      const rx = ox + x1 * scale
      const ry = oy + y1 * scale
      const rw2 = (x2 - x1) * scale
      const rh2 = (y2 - y1) * scale
      ctx.strokeStyle = color
      ctx.strokeRect(rx, ry, rw2, rh2)

      const name = String(det?.class_name || '').trim()
      const conf = Number(det?.confidence)
      const label = name ? `${name}${Number.isFinite(conf) ? ` ${(Math.round(conf * 1000) / 10).toFixed(1)}%` : ''}` : ''
      if (!label) continue
      const pad = 4
      const metrics = ctx.measureText(label)
      const tw = metrics.width + pad * 2
      const th = Math.max(14, Math.round(cw / 44)) + pad * 2
      const tx = Math.max(0, Math.min(cw - tw, rx))
      const ty = Math.max(0, ry - th)
      ctx.fillStyle = isAnomaly ? 'rgba(255,77,79,0.85)' : 'rgba(82,196,26,0.85)'
      ctx.fillRect(tx, ty, tw, th)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, tx + pad, ty + th - pad)
    }
  }, [showBoxes, lastDetections, lastFrameSize])

  useEffect(() => {
    if (!isStreaming) return
    if (showPreview) return
    drawBoxes()
  }, [isStreaming, showPreview, drawBoxes])

  useEffect(() => {
    if (!isStreaming) return
    const onResize = () => drawBoxes()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isStreaming, drawBoxes])

  useEffect(() => {
    return () => stopCamera({ silent: true });
  }, [stopCamera]);

  useEffect(() => {
    if (!active) return
    if (cameraError) return
    if (!multiCamActive) return
    return () => stopMultiCam()
  }, [active, cameraError, multiCamActive, stopMultiCam])

  const selectDeviceAndStart = useCallback(async (deviceId) => {
    selectedDeviceIdRef.current = deviceId || null
    await startCamera({ silent: true, deviceId })
  }, [startCamera])

  return (
    <Card size="small" title={title}
      extra={
        <Space>
          {!isStreaming ? (
            <Button type="primary" icon={<CameraOutlined />} onClick={() => startCamera({})} loading={loading} disabled={disabled} size="small">
              启动摄像头
            </Button>
          ) : (
            <>
              <Button onClick={() => setPauseDetect(v => !v)} size="small" disabled={disabled}>
                {pauseDetect ? '继续识别' : '暂停识别'}
              </Button>
              <Button onClick={() => setShowBoxes(v => !v)} size="small" disabled={disabled}>
                {showBoxes ? '隐藏识别框' : '显示识别框'}
              </Button>
              <Button onClick={() => setShowOverlay(v => !v)} size="small" disabled={disabled}>
                {showOverlay ? '关闭叠加层' : '显示叠加层'}
              </Button>
              <Button danger icon={<StopOutlined />} onClick={stopCamera} size="small">关闭</Button>
            </>
          )}
        </Space>
      }
    >
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      
      <div ref={containerRef} className="camera-container" style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3', minHeight: 360, background: '#f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.9)' }}>
            <Spin size="large" />
            <p>正在启动摄像头...</p>
          </div>
        )}
        
        {cameraError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
            <div style={{ padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ color: '#ff4d4f', fontWeight: 600 }}>{cameraError}</div>
              <Space>
                <Button type="primary" icon={<CameraOutlined />} onClick={() => startCamera({ deviceId: selectedDeviceIdRef.current })} size="small">重试</Button>
              </Space>
            </div>
            <div style={{ flex: 1, padding: 12, color: '#666', fontSize: 12 }}>
              <div>请确认浏览器权限已允许，并在上方选择正确的摄像头设备。</div>
              <div style={{ marginTop: 8 }}>如果仍失败，可能是设备被其他应用占用或系统权限限制。</div>
            </div>
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

        {isStreaming && !showPreview && (
          <canvas
            ref={overlayCanvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
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
            {streamInfo && (
              <span style={{ color: '#666' }}>
                {streamInfo.frameRate ? `${Math.round(streamInfo.frameRate)}fps` : 'fps未知'}
                {streamInfo.width && streamInfo.height ? ` ${streamInfo.width}×${streamInfo.height}` : ''}
              </span>
            )}
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

      {!hideRecords && isStreaming && errorRecords.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Space size={8} wrap>
              <span style={{ color: '#666' }}>故障截图</span>
              <Tag color="blue">{errorRecords.length}</Tag>
            </Space>
            <Space size={8} wrap>
              <Button size="small" onClick={() => setShowAllRecords(v => !v)}>
                {showAllRecords ? '收起' : '展开'}
              </Button>
              <Button size="small" onClick={() => setErrorRecords([])}>清空</Button>
            </Space>
          </div>
          {(showAllRecords ? errorRecords : errorRecords.slice(0, 1)).map((r) => (
            <div key={r.id} style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden', background: '#fff', marginBottom: showAllRecords ? 10 : 0 }}>
              <div style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#000' }}>
                <img src={r.image} alt="record" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
              </div>
              <div style={{ padding: 8 }}>
                <div style={{ fontSize: 12, color: r.type === 'anomaly' ? '#fa8c16' : '#ff4d4f' }}>{r.message}</div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>{new Date(r.ts).toLocaleString('zh-CN')}</div>
              </div>
            </div>
          ))}
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
