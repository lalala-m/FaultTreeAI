/**
 * 视觉识别主页面
 * 整合图片上传、视频识别、摄像头捕获、识别、结果展示、故障树生成等功能
 */

import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Layout, Row, Col, Card, Button, message, Divider, Space, Tabs, Alert, Select, Tag, Empty, Input, Modal, Tooltip } from 'antd';
import { ThunderboltOutlined, RocketOutlined, SyncOutlined, CameraOutlined, VideoCameraOutlined, PictureOutlined, PhoneOutlined, LeftOutlined, AudioOutlined } from '@ant-design/icons';
import BytePlusRTC, { MirrorType, RoomProfileType, StreamIndex } from '@byteplus/rtc';
import ImageUploader from '../../components/vision/ImageUploader';
import CameraCapture from '../../components/vision/CameraCapture';
import VideoUploader from '../../components/vision/VideoUploader';
import DetectionResult from '../../components/vision/DetectionResult';
import RtcCallAssistant from '../../components/vision/RtcCallAssistant';
import { createRealtimeService, transcribeAudio } from '../../services/realtime.js';
import { useSpeech } from '../../hooks/useSpeech.js';
import { useAudioRecorder } from '../../hooks/useAudioRecorder.js';
import { getAuthToken } from '../../services/api.js';
import './VisionDetect.css';

const { Content } = Layout;

// 获取 API 基础 URL：如果环境变量协议与当前页面不一致（常见是配成了 https 但服务是 http），
// 则回退到相对路径，避免 ERR_ALPN_NEGOTIATION_FAILED / 混合内容等浏览器报错。
const getApiBaseUrl = () => {
  const envUrl = import.meta.env.VITE_API_URL || ''
  if (!envUrl) return ''
  try {
    const env = new URL(envUrl, window.location.href)
    if (env.protocol !== window.location.protocol) return ''
    return envUrl
  } catch {
    return envUrl
  }
}

export default function VisionDetect({ onNavigate }) {
  const [images, setImages] = useState([]);
  const [cameraImage, setCameraImage] = useState(null);
  const [videoFrames, setVideoFrames] = useState([]);
  const [allImages, setAllImages] = useState([]);
  const [results, setResults] = useState(null);
  const [resultsSource, setResultsSource] = useState(null)
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('image');
  const [rtcUserId, setRtcUserId] = useState('');
  const [rtcJoined, setRtcJoined] = useState(false);
  const [rtcLoading, setRtcLoading] = useState(false);
  const [rtcSessionId, setRtcSessionId] = useState('')
  const [rtcAiUserId, setRtcAiUserId] = useState('')
  const [rtcAiStatus, setRtcAiStatus] = useState('offline')
  const [rtcAiDisplayName, setRtcAiDisplayName] = useState('故障检修系统')
  const [rtcRemoteUsers, setRtcRemoteUsers] = useState([]);
  const [rtcCameraIds, setRtcCameraIds] = useState([])
  const [rtcCameraIndex, setRtcCameraIndex] = useState(0)
  const [rtcCameraFacing, setRtcCameraFacing] = useState('environment')
  const [rtcShotSource, setRtcShotSource] = useState('local')
  const [rtcLastShot, setRtcLastShot] = useState('')
  const [assistantMessages, setAssistantMessages] = useState([
    { role: 'assistant', content: '我已准备好。在视频通话中你可以让我抓取画面进行故障识别，也可以直接文字提问。' }
  ])
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantLoading, setAssistantLoading] = useState(false)
  const [assistantAuto, setAssistantAuto] = useState(false)
  const [assistantAutoSec, setAssistantAutoSec] = useState(8)
  const [assistantVoiceEnabled, setAssistantVoiceEnabled] = useState(true)
  const [callAssistantOpen, setCallAssistantOpen] = useState(false)
  const [isNarrow, setIsNarrow] = useState(false)
  const rtcEngineRef = useRef(null);
  const realtimeServiceRef = useRef(null);
  const sendAssistantPromptRef = useRef(null);
  const captureAndSendFrameRef = useRef(null);
  const tabsWrapRef = useRef(null)
  const rowRef = useRef(null)
  const leftColRef = useRef(null)
  const leftBottomCardRef = useRef(null)
  const imagePanelRef = useRef(null)
  const cameraPanelRef = useRef(null)
  const videoPanelRef = useRef(null)
  const rightResultWrapRef = useRef(null)
  const [tabsOffset, setTabsOffset] = useState(0)
  const [rightTopOffset, setRightTopOffset] = useState(0)
  const [cameraPanelHeight, setCameraPanelHeight] = useState(0)
  const [activeLeftPanelHeight, setActiveLeftPanelHeight] = useState(0)
  const [rightResultHeight, setRightResultHeight] = useState(0)
  const [cameraDevices, setCameraDevices] = useState([])
  const [cameraSlots, setCameraSlots] = useState([null, null, null, null])
  const [cameraShots, setCameraShots] = useState([])
  
  const [settings, setSettings] = useState({
    confThreshold: 0.25,
    iouThreshold: 0.45,
    returnAnnotated: true,
    modelKey: 'wire_break_seg',
  });

  const isMobileRtcDevice = useMemo(() => {
    try {
      const ua = String(window.navigator?.userAgent || '').toLowerCase()
      return /android|iphone|ipad|ipod|mobile/.test(ua)
    } catch {
      return false
    }
  }, [])

  const isEmbeddedBrowser = useMemo(() => {
    // 飞书/微信/钉钉等内置浏览器通常不支持 getUserMedia / WebRTC / Web Speech API
    try {
      const ua = String(window.navigator?.userAgent || '')
      return /Lark|Feishu|飞书|MicroMessenger|WeChat|DingTalk/i.test(ua)
    } catch {
      return false
    }
  }, [])

  const applyLocalPreviewMirror = useCallback((engine, facing) => {
    if (!isMobileRtcDevice || !engine?.setLocalVideoMirrorType) return
    const mirrorType = facing === 'environment'
      ? MirrorType.MIRROR_TYPE_NONE
      : MirrorType.MIRROR_TYPE_RENDER
    try {
      engine.setLocalVideoMirrorType(mirrorType)
    } catch (err) {
      console.warn('设置本地预览镜像失败:', err)
    }
  }, [isMobileRtcDevice])

  useEffect(() => {
    const handler = (e) => {
      const tab = String(e?.detail?.tab || '').trim()
      if (!tab) return
      if (tab === 'image' || tab === 'video' || tab === 'camera' || tab === 'call') {
        setActiveTab(tab)
      }
    }
    window.addEventListener('vision-open', handler)
    return () => window.removeEventListener('vision-open', handler)
  }, [])

  useEffect(() => {
    let tab = ''
    try {
      tab = String(window.__visionOpenTab || window.sessionStorage?.getItem?.('vision-open-tab') || '').trim()
      if (tab) {
        window.__visionOpenTab = ''
        window.sessionStorage?.removeItem?.('vision-open-tab')
      }
    } catch {
    }
    if (tab === 'image' || tab === 'video' || tab === 'camera' || tab === 'call') {
      setActiveTab(tab)
    }
  }, [])

  useEffect(() => {
    const allowed = new Set(['auto', 'wire_break_seg', 'mvtec_fastener_det', 'yolo11m'])
    setSettings((prev) => {
      const mk = String(prev.modelKey || '').toLowerCase()
      if (!allowed.has(mk)) return { ...prev, modelKey: 'wire_break_seg' }
      return prev
    })
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const apply = () => setIsNarrow(!!mq.matches)
    apply()
    try {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    } catch {
      mq.addListener(apply)
      return () => mq.removeListener(apply)
    }
  }, [])

  const API_URL = getApiBaseUrl()
  const { supported: speechSupported, listening: speechListening, startListening, stopListening, speak: speakAssistantText, cancel: cancelAssistantSpeech } = useSpeech({
    lang: 'zh-CN',
    rate: 1,
    pitch: 1,
    backendTtsUrl: `${API_URL}/api/realtime/tts`,
    onResult: (text) => {
      setAssistantInput('');
      sendAssistantPromptRef.current?.(text);
    },
    onError: (err) => {
      message.warning(String(err?.message || '语音识别失败'));
    },
  });

  const { supported: audioRecorderSupported, recording: audioRecording, start: startAudioRecording, stop: stopAudioRecording, lastRms: recorderLastRms } = useAudioRecorder({
    sampleRate: 16000,
    maxDurationMs: 30000,
  });

  const voiceSupported = speechSupported || audioRecorderSupported;
  const voiceActive = speechListening || audioRecording;

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

  const extractValidBase64 = useCallback((dataUrl) => {
    const raw = String(dataUrl || '').trim()
    if (!raw) return ''
    const pure = raw.includes(',') ? raw.split(',')[1] : raw
    if (!pure || pure.length < 50) return ''
    return pure
  }, []);

  const startRtcSession = useCallback(async ({ roomId, userId }) => {
    const API_URL = getApiBaseUrl();
    const token = getAuthToken();
    const resp = await fetch(`${API_URL}/api/vision/rtc/session/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        room_id: roomId || undefined,
        user_id: userId || undefined,
      }),
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        const errJson = await resp.json();
        detail = errJson?.detail || errJson?.error || detail;
      } catch {
      }
      throw new Error(`创建 AI 通话失败: ${detail}`);
    }
    return await resp.json();
  }, []);

  const pushAssistantMessage = useCallback((msg) => {
    const role = String(msg?.role || 'assistant')
    const content = String(msg?.content || '')
    console.log('[AssistantMessage] role=%s speak=%s voiceEnabled=%s rtcJoined=%s content=%s',
      role, String(msg?.speak), String(assistantVoiceEnabled), String(rtcJoined), content.slice(0, 60))
    setAssistantMessages((prev) => {
      const arr = Array.isArray(prev) ? prev : []
      return [...arr, { ...msg, role, content }].slice(-80)
    })
    if (role === 'assistant' && rtcJoined && assistantVoiceEnabled && msg?.speak !== false) {
      console.log('[AssistantMessage] triggering TTS')
      speakAssistantText(content)
    } else {
      console.log('[AssistantMessage] skip TTS: role=%s rtcJoined=%s voiceEnabled=%s speak=%s',
        role, String(rtcJoined), String(assistantVoiceEnabled), String(msg?.speak))
    }
  }, [rtcJoined, assistantVoiceEnabled, speakAssistantText])

  const callVisionLLM = useCallback(async ({ prompt, images, source }) => {
    const API_URL = getApiBaseUrl()
    const token = getAuthToken()
    const resp = await fetch(`${API_URL}/api/vision/vl/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        prompt: String(prompt || ''),
        images: Array.isArray(images) ? images.filter(Boolean) : [],
        session_id: rtcSessionId || undefined,
        source: String(source || 'local'),
      }),
    })
    if (!resp.ok) {
      let detail = resp.statusText
      try {
        const errJson = await resp.json()
        detail = errJson?.detail || errJson?.error || detail
      } catch {
      }
      throw new Error(`AI 调用失败: ${detail}`)
    }
    return await resp.json()
  }, [rtcSessionId])

  const callDetector = useCallback(async ({ dataUrl }) => {
    const API_URL = getApiBaseUrl()
    const base64Data = extractValidBase64(dataUrl)
    if (!base64Data) throw new Error('图片数据为空或损坏，请重新上传或提取帧')
    const formData = new FormData()
    formData.append('image_data', base64Data)
    formData.append('conf_threshold', String(settings.confThreshold ?? 0.25))
    formData.append('iou_threshold', String(settings.iouThreshold ?? 0.45))
    formData.append('return_annotated', 'false')
    formData.append('model_key', String(settings.modelKey || 'auto'))
    formData.append('suppress_overlay', 'true')
    const resp = await fetch(`${API_URL}/api/vision/detect/base64`, { method: 'POST', body: formData })
    if (!resp.ok) {
      let detail = resp.statusText
      try {
        const errJson = await resp.json()
        detail = errJson?.detail || errJson?.error || detail
      } catch {
      }
      throw new Error(`视觉识别失败: ${detail}`)
    }
    return await resp.json()
  }, [settings.confThreshold, settings.iouThreshold, settings.modelKey, extractValidBase64])

  const captureDomFrame = useCallback((domId) => {
    const root = document.getElementById(domId)
    if (!root) throw new Error('未找到视频容器')

    const canvasEl = root.querySelector('canvas')
    if (canvasEl && typeof canvasEl.toDataURL === 'function') {
      try {
        const url = canvasEl.toDataURL('image/jpeg', 0.85)
        if (url && url.startsWith('data:image/')) return url
      } catch {
      }
    }

    const videoEl = root.querySelector('video')
    if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      const c = document.createElement('canvas')
      c.width = videoEl.videoWidth
      c.height = videoEl.videoHeight
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('截图失败')
      ctx.drawImage(videoEl, 0, 0, c.width, c.height)
      const url = c.toDataURL('image/jpeg', 0.85)
      if (url && url.startsWith('data:image/')) return url
    }

    throw new Error('当前没有可截图的画面（可能尚未发布/订阅视频）')
  }, [])

  const buildDetectionText = useCallback((det) => {
    const total = Number(det?.total_detections || 0)
    const anomalies = Number(det?.anomaly_count || 0)
    const items = Array.isArray(det?.detections) ? det.detections : []
    const top = items
      .slice()
      .sort((a, b) => Number(b?.confidence || 0) - Number(a?.confidence || 0))
      .slice(0, 8)
      .map((d) => {
        const name = String(d?.class_name || '')
        const conf = Number(d?.confidence || 0)
        const an = d?.is_anomaly ? '异常' : '正常'
        return `${name}（${an}，${conf.toFixed(2)}）`
      })
    return `检测结果：总目标 ${total}，异常 ${anomalies}。${top.length ? `Top: ${top.join('；')}` : ''}`
  }, [])

  const sendAssistantPrompt = useCallback(async (rawText) => {
    if (assistantLoading) return
    const text = String(rawText || '').trim()
    if (!text) {
      message.warning('请输入内容')
      return
    }
    pushAssistantMessage({ role: 'user', content: text })
    setAssistantLoading(true)
    setRtcAiStatus('analyzing')
    console.log('[Voice] send assistant prompt:', text)
    try {
      const service = realtimeServiceRef.current
      if (service && rtcJoined) {
        // 通过 WebSocket 发送问题，并立即抓取当前画面帧触发分析
        service.ask(text, 'text')
        await captureAndSendFrameRef.current?.({ mode: rtcShotSource })
      } else {
        // 未在通话中：回退到旧的 HTTP 接口
        const resp = await callVisionLLM({ prompt: text, images: [], source: 'local' })
        pushAssistantMessage({ role: 'assistant', content: String(resp?.content || '') || '（无输出）' })
        setRtcAiStatus('ready')
        setAssistantLoading(false)
      }
    } catch (e) {
      message.error(String(e?.message || 'AI 调用失败'))
      pushAssistantMessage({ role: 'assistant', content: `调用失败：${String(e?.message || '未知错误')}` })
      setRtcAiStatus('error')
      setAssistantLoading(false)
    }
  }, [assistantLoading, callVisionLLM, pushAssistantMessage, rtcJoined])

  const captureAndSendFrame = useCallback(async ({ mode, forcedPrompt } = {}) => {
    if (!rtcJoined) return false
    const src = mode || rtcShotSource
    const domId = src === 'local' ? 'rtc-local-player' : `rtc-remote-${src}`
    let shot = ''
    try {
      shot = captureDomFrame(domId)
    } catch (e) {
      console.warn('[Realtime] capture frame failed:', e)
      return false
    }
    setRtcLastShot(shot)
    const service = realtimeServiceRef.current
    if (!service) {
      message.warning('实时 AI 通道未连接')
      return false
    }
    if (forcedPrompt) {
      service.ask(forcedPrompt, 'text')
    }
    service.sendFrame(shot, Date.now())
    return true
  }, [rtcJoined, rtcShotSource, captureDomFrame])

  // 让 useSpeech 的 onResult 始终能调用到最新的 sendAssistantPrompt
  useEffect(() => {
    sendAssistantPromptRef.current = sendAssistantPrompt
  }, [sendAssistantPrompt])

  // 让 sendAssistantPrompt 始终能调用到最新的 captureAndSendFrame
  useEffect(() => {
    captureAndSendFrameRef.current = captureAndSendFrame
  }, [captureAndSendFrame])

  const assistantSendText = useCallback(async () => {
    const text = String(assistantInput || '').trim()
    if (!text) {
      message.warning('请输入内容')
      return
    }
    setAssistantInput('')
    await sendAssistantPrompt(text)
  }, [assistantInput, sendAssistantPrompt])

  const assistantAnalyzeFrame = useCallback(async ({ mode }) => {
    if (assistantLoading) return
    if (!rtcJoined) {
      message.warning('请先加入通话')
      return
    }
    const userText = String(assistantInput || '').trim()
    if (userText) {
      setAssistantInput('')
      pushAssistantMessage({ role: 'user', content: userText })
    }
    setAssistantLoading(true)
    setRtcAiStatus('analyzing')
    const prompt = userText || '请结合当前画面，判断是否存在故障/异常，并给出依据、可能原因和处理建议。'
    const ok = await captureAndSendFrame({ mode, forcedPrompt: prompt })
    if (!ok) {
      setAssistantLoading(false)
      setRtcAiStatus('error')
    }
  }, [
    assistantLoading,
    rtcJoined,
    assistantInput,
    pushAssistantMessage,
    captureAndSendFrame,
  ])

  const handleRtcJoin = useCallback(async () => {
    if (rtcLoading || rtcJoined) return;
    if (isEmbeddedBrowser) {
      message.error('飞书/微信/钉钉内置浏览器不支持视频通话和麦克风，请使用 Chrome/Edge/Safari 或 Android App');
      return;
    }
    if (!navigator?.mediaDevices?.getUserMedia) {
      message.error('当前环境不支持麦克风/摄像头调用（需要 HTTPS 或 localhost 访问）')
      return
    }
    setRtcLoading(true);
    try {
      const userId = String(rtcUserId || '').trim();
      const tk = await startRtcSession({ userId });
      const appId = String(tk?.app_id || '').trim();
      const token = String(tk?.token || '').trim();
      const finalRoomId = String(tk?.room_id || '').trim();
      const finalUserId = String(tk?.user_id || '').trim();
      const sessionId = String(tk?.session_id || '').trim();
      const aiUserId = String(tk?.ai_user_id || '').trim();
      const aiDisplayName = String(tk?.ai_display_name || '').trim() || '故障检修系统';
      const welcomeMessage = String(tk?.welcome_message || '').trim();
      if (!appId || !token || !finalRoomId || !finalUserId) {
        throw new Error('RTC 参数不完整');
      }

      const engine = BytePlusRTC.createEngine(appId);
      rtcEngineRef.current = engine;

      engine.on(BytePlusRTC.events.onUserPublishStream, (e) => {
        const uid = String(e?.userId || '').trim();
        if (!uid) return;
        setRtcRemoteUsers((prev) => {
          const arr = Array.isArray(prev) ? prev : [];
          if (arr.includes(uid)) return arr;
          return [...arr, uid];
        });
      });
      engine.on(BytePlusRTC.events.onUserUnpublishStream, (e) => {
        const uid = String(e?.userId || '').trim();
        if (!uid) return;
        setRtcRemoteUsers((prev) => (Array.isArray(prev) ? prev.filter((x) => x !== uid) : []));
      });
      engine.on(BytePlusRTC.events.onUserLeave, (e) => {
        const uid = String(e?.userId || '').trim();
        if (!uid) return;
        setRtcRemoteUsers((prev) => (Array.isArray(prev) ? prev.filter((x) => x !== uid) : []));
      });

      await engine.joinRoom(
        token,
        finalRoomId,
        { userId: finalUserId },
        {
          isAutoPublish: true,
          isAutoSubscribeAudio: true,
          isAutoSubscribeVideo: true,
          roomProfileType: RoomProfileType.communication,
        }
      );

      // 提高视频通话画质：默认 SDK 只发 640×480@15fps/600kbps，这里提升到 1280×720@20fps/2Mbps
      try {
        const isMobile = isMobileRtcDevice
        await engine.setVideoEncoderConfig({
          width: isMobile ? 960 : 1280,
          height: isMobile ? 540 : 720,
          frameRate: isMobile ? 15 : 20,
          maxKbps: isMobile ? 1200 : 2000,
          contentHint: 'detail',
        })
        console.log('[RTC] video encoder config set:', isMobile ? '960×540' : '1280×720')
      } catch (e) {
        console.warn('[RTC] setVideoEncoderConfig failed:', e)
      }

      await engine.startAudioCapture();
      const initialCamera = isMobileRtcDevice ? 'environment' : undefined
      await engine.startVideoCapture(initialCamera);
      engine.setLocalVideoPlayer(StreamIndex.STREAM_INDEX_MAIN, { renderDom: 'rtc-local-player' });
      applyLocalPreviewMirror(engine, isMobileRtcDevice ? 'environment' : 'user')

      setRtcUserId(finalUserId);
      setRtcSessionId(sessionId);
      setRtcAiUserId(aiUserId);
      setRtcAiDisplayName(aiDisplayName);
      setRtcAiStatus('ready');
      setRtcRemoteUsers([]);
      setRtcCameraFacing(isMobileRtcDevice ? 'environment' : 'user');
      setRtcShotSource('local');
      setRtcLastShot('');
      setAssistantMessages(welcomeMessage ? [{ role: 'assistant', content: welcomeMessage }] : [
        { role: 'assistant', content: `${aiDisplayName} 已接通，你可以直接提问或让我分析当前画面。` }
      ]);
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        const cams = (Array.isArray(list) ? list : []).filter(d => d?.kind === 'videoinput' && d?.deviceId).map(d => d.deviceId)
        setRtcCameraIds(cams)
        if (cams.length > 0) setRtcCameraIndex(0)
      } catch {
      }
      setRtcJoined(true);

      // 建立实时 AI WebSocket 通道
      try {
        const service = createRealtimeService(sessionId, { autoReconnect: true });
        realtimeServiceRef.current = service;
        service.on('open', () => {
          console.log('[Realtime] websocket connected');
        });
        service.on('result', (payload) => {
          console.log('[Realtime] result:', payload)
          if (payload?.content) {
            pushAssistantMessage({
              role: 'assistant',
              content: String(payload.content),
              speak: payload.speak !== false,
            });
          }
          setRtcAiStatus(payload?.overall_status === 'critical' ? 'error' : 'ready');
          setAssistantLoading(false);
        });
        service.on('status', (payload) => {
          const status = payload?.ai_status || 'observing';
          if (status !== 'analyzing') {
            setRtcAiStatus(status);
          }
        });
        service.on('error', (payload) => {
          console.error('[Realtime] error:', payload);
          pushAssistantMessage({ role: 'assistant', content: String(payload?.content || '实时通道异常'), speak: false });
          setAssistantLoading(false);
        });
        service.on('close', () => {
          console.log('[Realtime] websocket closed');
        });
        service.connect();
      } catch (e) {
        console.error('[Realtime] failed to create service:', e);
      }

      if (welcomeMessage) speakAssistantText(welcomeMessage);
      message.success('AI 已接通');
    } catch (e) {
      console.error(e);
      message.error(String(e?.message || '加入通话失败'));
      try {
        const eng = rtcEngineRef.current;
        rtcEngineRef.current = null;
        if (eng) await eng.leaveRoom();
      } catch {
      }
      setRtcSessionId('');
      setRtcAiUserId('');
      setRtcAiStatus('offline');
    } finally {
      setRtcLoading(false);
    }
  }, [applyLocalPreviewMirror, isEmbeddedBrowser, isMobileRtcDevice, rtcLoading, rtcJoined, rtcUserId, speakAssistantText, startRtcSession]);

  const handleSwitchCamera = useCallback(async () => {
    if (!rtcJoined) {
      message.warning('请先加入通话')
      return
    }
    const eng = rtcEngineRef.current
    if (!eng) return
    if (isMobileRtcDevice) {
      const nextFacing = rtcCameraFacing === 'environment' ? 'user' : 'environment'
      try {
        const mgr = eng.getVideoDeviceManager?.()
        if (mgr?.setVideoCaptureDevice) {
          await mgr.setVideoCaptureDevice(nextFacing)
        } else {
          try { await eng.stopVideoCapture() } catch { }
          await eng.startVideoCapture(nextFacing)
        }
        applyLocalPreviewMirror(eng, nextFacing)
        setRtcCameraFacing(nextFacing)
        message.success(nextFacing === 'environment' ? '已切换到后置摄像头' : '已切换到前置摄像头')
      } catch (e) {
        console.error(e)
        message.error('切换摄像头失败')
      }
      return
    }
    const ids = Array.isArray(rtcCameraIds) ? rtcCameraIds.filter(Boolean) : []
    if (ids.length < 2) {
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        const cams = (Array.isArray(list) ? list : []).filter(d => d?.kind === 'videoinput' && d?.deviceId).map(d => d.deviceId)
        setRtcCameraIds(cams)
        if (cams.length < 2) {
          message.warning('未检测到可切换的摄像头')
          return
        }
      } catch {
        message.warning('未检测到可切换的摄像头')
        return
      }
    }

    const nextIndex = (Number(rtcCameraIndex || 0) + 1) % (Array.isArray(rtcCameraIds) ? rtcCameraIds.length : 1)
    const nextId = (Array.isArray(rtcCameraIds) ? rtcCameraIds : [])[nextIndex]
    if (!nextId) return

    try {
      const mgr = eng.getVideoDeviceManager?.()
      if (mgr?.setVideoCaptureDevice) {
        await mgr.setVideoCaptureDevice(nextId)
      } else {
        try { await eng.stopVideoCapture() } catch { }
        try {
          const mgr2 = eng.getVideoDeviceManager?.()
          if (mgr2?.setVideoCaptureDevice) await mgr2.setVideoCaptureDevice(nextId)
        } catch { }
        try { await eng.startVideoCapture() } catch { }
      }
      setRtcCameraIndex(nextIndex)
      message.success('已切换摄像头')
    } catch (e) {
      console.error(e)
      message.error('切换摄像头失败')
    }
  }, [applyLocalPreviewMirror, isMobileRtcDevice, rtcJoined, rtcCameraFacing, rtcCameraIds, rtcCameraIndex])

  const handleRtcLeave = useCallback(async () => {
    if (rtcLoading) return;
    setRtcLoading(true);
    try {
      cancelAssistantSpeech();
      try {
        realtimeServiceRef.current?.close();
      } catch { }
      realtimeServiceRef.current = null;
      const eng = rtcEngineRef.current;
      rtcEngineRef.current = null;
      if (eng) {
        try { await eng.stopVideoCapture(); } catch { }
        try { await eng.stopAudioCapture(); } catch { }
        try { await eng.leaveRoom(); } catch { }
      }
      if (rtcSessionId) {
        try {
          const API_URL = getApiBaseUrl();
          const token = getAuthToken();
          await fetch(`${API_URL}/api/vision/rtc/session/${rtcSessionId}/end`, {
            method: 'POST',
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          });
        } catch {
        }
      }
      setRtcJoined(false);
      setRtcSessionId('');
      setRtcAiUserId('');
      setRtcAiStatus('offline');
      setRtcRemoteUsers([]);
      setAssistantAuto(false);
      setRtcLastShot('');
      message.success('已结束 AI 通话');
    } finally {
      setRtcLoading(false);
    }
  }, [rtcLoading, rtcSessionId]);

  // 按住说话：按下时打断 AI 并开始识别，松开时结束识别
  const handleVoiceStart = useCallback(() => {
    if (!voiceSupported) {
      console.warn('[Voice] not supported. speechSupported=', speechSupported, 'audioRecorderSupported=', audioRecorderSupported)
      message.warning('当前环境不支持语音输入，请使用 Chrome/Edge 或允许麦克风权限')
      return
    }
    cancelAssistantSpeech()
    if (speechSupported) {
      console.log('[Voice] start browser SpeechRecognition')
      startListening()
    } else if (audioRecorderSupported) {
      console.log('[Voice] start audio recording fallback')
      startAudioRecording().catch((err) => {
        console.error('[Voice] recorder start failed:', err)
        message.warning(String(err?.message || '麦克风启动失败'));
      })
    }
  }, [voiceSupported, speechSupported, audioRecorderSupported, startListening, startAudioRecording, cancelAssistantSpeech])

  const handleVoiceEnd = useCallback(async () => {
    if (speechListening) {
      console.log('[Voice] stop browser SpeechRecognition')
      stopListening()
      return
    }
    if (audioRecording) {
      console.log('[Voice] stop audio recording, transcribing...')
      message.loading({ content: '语音识别中...', key: 'asr' })
      try {
        const blob = await stopAudioRecording()
        if (!blob) {
          message.warning('录音失败，请检查麦克风权限或重试')
          return
        }
        console.log('[Voice] recorded rms:', recorderLastRms)
        if (recorderLastRms < 0.001) {
          message.warning('未检测到声音，请确认麦克风权限已开启并靠近麦克风说话')
          return
        }
        const text = await transcribeAudio(blob)
        console.log('[Voice] transcribed:', text)
        if (text) {
          setAssistantInput('')
          sendAssistantPromptRef.current?.(text)
        } else {
          message.warning('未识别到语音')
        }
      } catch (err) {
        console.error('[Voice] transcribe failed:', err)
        message.warning(String(err?.message || '语音识别失败'))
      } finally {
        message.destroy('asr')
      }
    }
  }, [speechListening, audioRecording, stopListening, stopAudioRecording, setAssistantInput])

  // 移动端 touch 事件会触发对应的 mouse 事件，避免重复触发录音启停
  const voiceTouchHandledRef = useRef(false)
  const onVoiceStartEvent = useCallback((e) => {
    try { e?.preventDefault?.() } catch {}
    if (e?.type === 'touchstart') {
      voiceTouchHandledRef.current = true
    } else if (e?.type === 'mousedown' && voiceTouchHandledRef.current) {
      return
    }
    handleVoiceStart()
  }, [handleVoiceStart])
  const onVoiceEndEvent = useCallback((e) => {
    try { e?.preventDefault?.() } catch {}
    if (e?.type === 'touchend') {
      voiceTouchHandledRef.current = false
    } else if (e?.type === 'mouseup' && voiceTouchHandledRef.current) {
      return
    } else if (e?.type === 'mouseleave' && !voiceTouchHandledRef.current) {
      return
    }
    handleVoiceEnd()
  }, [handleVoiceEnd])

  useEffect(() => {
    if (!rtcJoined) return;
    const eng = rtcEngineRef.current;
    if (!eng) return;
    const users = Array.isArray(rtcRemoteUsers) ? rtcRemoteUsers : [];
    let cancelled = false;
    const run = async () => {
      for (const uid of users) {
        if (cancelled) return;
        const id = `rtc-remote-${uid}`;
        const el = document.getElementById(id);
        if (!el) continue;
        try {
          await eng.setRemoteVideoPlayer(StreamIndex.STREAM_INDEX_MAIN, {
            userId: uid,
            renderDom: id,
          });
        } catch {
        }
      }
    };
    const t = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [rtcJoined, rtcRemoteUsers]);

  useEffect(() => {
    if (!rtcJoined || !assistantAuto || assistantLoading) return
    const sec = Math.max(3, Math.min(60, Number(assistantAutoSec || 8)))
    const t = window.setInterval(() => {
      // 自动观察：只发送画面帧，不强制提问，由后端根据异常状态决定是否主动提醒
      captureAndSendFrame({ mode: 'local' })
    }, sec * 1000)
    return () => window.clearInterval(t)
  }, [rtcJoined, assistantAuto, assistantAutoSec, assistantLoading, captureAndSendFrame])

  useEffect(() => {
    return () => {
      try {
        const eng = rtcEngineRef.current;
        rtcEngineRef.current = null;
        if (eng) eng.leaveRoom();
      } catch {
      }
      try {
        realtimeServiceRef.current?.close();
      } catch {
      }
      realtimeServiceRef.current = null;
      cancelAssistantSpeech();
    };
  }, [cancelAssistantSpeech]);

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
        const base64Data = extractValidBase64(firstImage.base64);
        if (!base64Data) {
          message.error('图片数据为空或损坏，请重新上传或提取帧');
          return;
        }
        formData.append('image_data', base64Data);
      }
      
      formData.append('conf_threshold', settings.confThreshold.toString());
      formData.append('iou_threshold', settings.iouThreshold.toString());
      formData.append('return_annotated', settings.returnAnnotated.toString());
      formData.append('model_key', settings.modelKey);
      if (String(settings.modelKey || '').toLowerCase() === 'wire_break_seg') {
        formData.append('suppress_overlay', 'true')
      }

      const API_URL = getApiBaseUrl();
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
  }, [allImages, settings, extractValidBase64]);

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
      const API_URL = getApiBaseUrl()
      const resultsList = []

      for (const img of imagesList) {
        try {
          const formData = new FormData()
          if (img.source === 'upload' && img.file) {
            formData.append('file', img.file)
          } else {
            const base64Data = extractValidBase64(img.base64)
            if (!base64Data) continue
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
  }, [allImages, settings, activeTab, extractValidBase64]);

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
        <div ref={imagePanelRef}>
          <Card size="small">
            <ImageUploader onUpload={handleImageUpload} onDetect={handleDetect} loading={loading} maxCount={9} />
          </Card>
        </div>
      )
    },
    {
      key: 'camera',
      label: <span><CameraOutlined /> 摄像头</span>,
      children: (
        <div ref={cameraPanelRef}>
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
        </div>
      )
    },
    {
      key: 'video',
      label: <span><VideoCameraOutlined /> 视频</span>,
      children: (
        <div ref={videoPanelRef}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Card size="small">
              <VideoUploader
                onFrameCapture={(frame) => setVideoFrames(prev => [...prev, { id: frame.id, image: frame.image, time: frame.time }])}
                onDetect={async (frames) => {
                  setVideoFrames(frames.map(f => ({ id: f.id, image: f.image, time: f.time })))
                  setLoading(true)
                  try {
                    const imgs = frames.map(f => ({ id: `video-${f.id}`, source: 'video', base64: f.image })).filter(img => extractValidBase64(img.base64))
                    if (imgs.length === 0) {
                      message.error('没有有效的视频帧可识别')
                      return
                    }
                    const API_URL = getApiBaseUrl()
                    const resultsList = []
                    let firstError = null

                    // 限制并发为 4，避免一次请求过多把后端压死
                    const concurrency = 4
                    const runOne = async (img) => {
                      const formData = new FormData()
                      formData.append('image_data', extractValidBase64(img.base64))
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
                        return null
                      }
                      const data = await response.json()
                      return { ...data, source: img.source, original_image_url: img.base64 }
                    }

                    for (let i = 0; i < imgs.length; i += concurrency) {
                      const chunk = imgs.slice(i, i + concurrency)
                      const chunkResults = await Promise.all(chunk.map(runOne))
                      chunkResults.filter(Boolean).forEach(r => resultsList.push(r))
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
          </Space>
        </div>
      )
    },
    {
      key: 'call',
      label: <span><VideoCameraOutlined /> 视频通话</span>,
      children: isNarrow ? (
        <div>
          <div style={{ position: 'relative', width: '100%', height: '100dvh', background: '#000', borderRadius: 0, overflow: 'hidden' }}>
            {Array.isArray(rtcRemoteUsers) && rtcRemoteUsers.length > 0 ? (
              <div id={`rtc-remote-${rtcRemoteUsers[0]}`} style={{ position: 'absolute', inset: 0 }} />
            ) : null}

            <div style={{ position: 'absolute', top: 10, left: 8, right: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 5 }}>
              <Button
                type="text"
                icon={<LeftOutlined style={{ color: '#fff', fontSize: 20 }} />}
                onClick={() => onNavigate?.('dashboard')}
                style={{ width: 40, height: 40 }}
              />
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 14, textAlign: 'center', flex: 1 }}>
                {rtcJoined ? `${rtcAiDisplayName} 通话中` : 'AI 视频通话'}
              </div>
              <Button
                type="text"
                icon={<SyncOutlined style={{ color: '#fff', fontSize: 20 }} />}
                onClick={handleSwitchCamera}
                style={{ width: 40, height: 40 }}
              />
            </div>

            <div
              id="rtc-local-player"
              style={
                Array.isArray(rtcRemoteUsers) && rtcRemoteUsers.length > 0
                  ? { position: 'absolute', top: 56, right: 12, width: 120, height: 168, background: '#000', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.25)', zIndex: 4 }
                  : { position: 'absolute', inset: 0, background: '#000' }
              }
            />

            {!rtcJoined && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', opacity: 0.92, padding: 24, textAlign: 'center', zIndex: 3, pointerEvents: 'none' }}>
                点击下方电话按钮接通 AI
              </div>
            )}

            {rtcJoined && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: 56, display: 'flex', justifyContent: 'center', color: '#fff', opacity: 0.88, fontSize: 13, zIndex: 3 }}>
                {rtcAiStatus === 'analyzing' ? `${rtcAiDisplayName} 正在分析画面…` : `${rtcAiDisplayName} 已在线，可直接提问`}
              </div>
            )}

            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 18, display: 'flex', justifyContent: 'center', gap: 14, zIndex: 10 }}>
              <Button shape="circle" onClick={() => setCallAssistantOpen(true)} style={{ width: 54, height: 54 }}>
                AI
              </Button>
              {rtcJoined && (
                <Button
                  shape="circle"
                  type={voiceActive ? 'primary' : 'default'}
                  danger={voiceActive}
                  icon={<AudioOutlined />}
                  disabled={!voiceSupported}
                  onTouchStart={onVoiceStartEvent}
                  onTouchEnd={onVoiceEndEvent}
                  onMouseDown={onVoiceStartEvent}
                  onMouseUp={onVoiceEndEvent}
                  onMouseLeave={onVoiceEndEvent}
                  style={{ width: 54, height: 54, userSelect: 'none', WebkitUserSelect: 'none' }}
                />
              )}
              {!rtcJoined ? (
                <Button type="primary" shape="circle" loading={rtcLoading} onClick={handleRtcJoin} style={{ width: 54, height: 54 }}>
                  <PhoneOutlined />
                </Button>
              ) : (
                <Button danger shape="circle" loading={rtcLoading} onClick={handleRtcLeave} style={{ width: 54, height: 54 }}>
                  <PhoneOutlined />
                </Button>
              )}
            </div>
          </div>

          <Modal
            open={callAssistantOpen}
            onCancel={() => setCallAssistantOpen(false)}
            footer={null}
            width="100%"
            style={{ top: 12 }}
          >
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <RtcCallAssistant
                aiStatus={rtcAiStatus}
                messages={assistantMessages}
                inputValue={assistantInput}
                onInputChange={setAssistantInput}
                onSendText={assistantSendText}
                onAnalyzeFrame={() => assistantAnalyzeFrame({ mode: rtcShotSource })}
                autoAnalyze={assistantAuto}
                onAutoAnalyzeChange={setAssistantAuto}
                autoSec={assistantAutoSec}
                onAutoSecChange={setAssistantAutoSec}
                loading={assistantLoading}
                assistantVoiceEnabled={assistantVoiceEnabled}
                onVoiceEnabledChange={setAssistantVoiceEnabled}
              />

              <Card size="small" title="最新截图">
                {rtcLastShot ? (
                  <div style={{ width: '100%' }}>
                    <img
                      src={rtcLastShot}
                      alt="last-shot"
                      style={{ width: '100%', maxHeight: 420, objectFit: 'contain', background: '#000', borderRadius: 8 }}
                    />
                  </div>
                ) : (
                  <Empty description="尚未截图" />
                )}
              </Card>
            </Space>
          </Modal>
        </div>
      ) : (
        <div>
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {isEmbeddedBrowser ? (
              <Alert
                type="warning"
                showIcon
                message="飞书/微信/钉钉内置浏览器不支持视频通话"
                description="内置浏览器通常禁止 getUserMedia、WebRTC 和 Web Speech API，因此无法使用麦克风录音和实时视频通话。请使用 Chrome/Edge/Safari 浏览器，或下载 Android App。"
              />
            ) : (
              <Alert
                type="info"
                showIcon
                message="提示"
                description="浏览器需要摄像头/麦克风权限；如果用 IP 访问非 localhost，可能需要 HTTPS 才能正常采集音视频。"
              />
            )}
            <Card size="small" title="AI 实时通话">
              <Row gutter={[12, 12]}>
                <Col xs={24} sm={12}>
                  <Input
                    value={rtcUserId}
                    onChange={(e) => setRtcUserId(e.target.value)}
                    placeholder="用户标识（可留空，系统自动生成）"
                    disabled={rtcJoined || rtcLoading}
                  />
                </Col>
                <Col xs={24} sm={12}>
                  <Alert
                    type="info"
                    showIcon
                    message="无需房间号"
                    description="系统会按当前登录用户自动创建独立视频通话会话。"
                  />
                </Col>
                <Col xs={24}>
                  <Space>
                    <Button type="primary" onClick={handleRtcJoin} loading={rtcLoading} disabled={rtcJoined}>
                      接通 AI
                    </Button>
                    <Button danger onClick={handleRtcLeave} loading={rtcLoading} disabled={!rtcJoined}>
                      结束通话
                    </Button>
                    {rtcJoined && (
                      <Tooltip title={!voiceSupported ? '当前环境不支持语音输入（请用 Chrome/Edge 或允许麦克风）' : voiceActive ? '松开结束' : '按住说话（可打断 AI）'}>
                        <Button
                          type={voiceActive ? 'primary' : 'default'}
                          danger={voiceActive}
                          icon={<AudioOutlined />}
                          disabled={!voiceSupported}
                          onMouseDown={onVoiceStartEvent}
                          onMouseUp={onVoiceEndEvent}
                          onMouseLeave={onVoiceEndEvent}
                          onTouchStart={onVoiceStartEvent}
                          onTouchEnd={onVoiceEndEvent}
                        >
                          {voiceActive ? '松开结束' : '按住说话'}
                        </Button>
                      </Tooltip>
                    )}
                    {rtcJoined && <Tag color="green">{rtcAiDisplayName} 已在线</Tag>}
                    {!rtcJoined && <Tag>未连接</Tag>}
                  </Space>
                </Col>
              </Row>
            </Card>

            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <Card size="small" title="本地画面">
                  <div
                    id="rtc-local-player"
                    style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 6, overflow: 'hidden' }}
                  />
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title={`${rtcAiDisplayName} 状态`}>
                  {Array.isArray(rtcRemoteUsers) && rtcRemoteUsers.length > 0 ? (
                    <Space direction="vertical" style={{ width: '100%' }} size={10}>
                      {rtcRemoteUsers.map((uid) => (
                        <div key={uid}>
                          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)', marginBottom: 6 }}>{uid}</div>
                          <div
                            id={`rtc-remote-${uid}`}
                            style={{ width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: 6, overflow: 'hidden' }}
                          />
                        </div>
                      ))}
                    </Space>
                  ) : (
                    <Space direction="vertical" size={8}>
                      <Tag color={rtcJoined ? (rtcAiStatus === 'analyzing' ? 'blue' : 'green') : 'default'}>
                        {rtcJoined ? (rtcAiStatus === 'analyzing' ? '分析中' : '在线') : '未接通'}
                      </Tag>
                      <div style={{ color: 'rgba(0,0,0,0.65)' }}>会话ID：{rtcSessionId || '未创建'}</div>
                      <div style={{ color: 'rgba(0,0,0,0.65)' }}>AI用户：{rtcAiUserId || '未分配'}</div>
                      <div style={{ color: 'rgba(0,0,0,0.65)' }}>
                        说明：当前版本先用本地语音输入/播报和后端视觉问答形成 AI 通话闭环，服务端 RTC Bot 骨架已预留。
                      </div>
                    </Space>
                  )}
                </Card>
              </Col>
            </Row>

            <Row gutter={[12, 12]}>
              <Col xs={24} lg={10}>
                <RtcCallAssistant
                  aiStatus={rtcAiStatus}
                  messages={assistantMessages}
                  inputValue={assistantInput}
                  onInputChange={setAssistantInput}
                  onSendText={assistantSendText}
                  onAnalyzeFrame={() => assistantAnalyzeFrame({ mode: rtcShotSource })}
                  autoAnalyze={assistantAuto}
                  onAutoAnalyzeChange={setAssistantAuto}
                  autoSec={assistantAutoSec}
                  onAutoSecChange={setAssistantAutoSec}
                  loading={assistantLoading}
                  assistantVoiceEnabled={assistantVoiceEnabled}
                  onVoiceEnabledChange={setAssistantVoiceEnabled}
                />
              </Col>

              <Col xs={24} lg={14}>
                <Card size="small" title="最新截图">
                  {rtcLastShot ? (
                    <div style={{ width: '100%' }}>
                      <img
                        src={rtcLastShot}
                        alt="last-shot"
                        style={{ width: '100%', maxHeight: 420, objectFit: 'contain', background: '#000', borderRadius: 8 }}
                      />
                    </div>
                  ) : (
                    <Empty description="尚未截图" />
                  )}
                </Card>
              </Col>
            </Row>
          </Space>
        </div>
      )
    }
  ]), [
    handleImageUpload,
    handleDetect,
    loading,
    handleCameraCapture,
    setVideoFrames,
    settings,
    activeTab,
    videoFrames.length,
    rtcUserId,
    rtcJoined,
    rtcLoading,
    rtcSessionId,
    rtcAiUserId,
    rtcAiStatus,
    rtcAiDisplayName,
    rtcRemoteUsers,
    handleRtcJoin,
    handleRtcLeave,
    handleSwitchCamera,
    assistantLoading,
    assistantMessages,
    assistantInput,
    assistantSendText,
    assistantAnalyzeFrame,
    rtcShotSource,
    assistantAuto,
    assistantAutoSec,
    assistantVoiceEnabled,
    voiceSupported,
    voiceActive,
    handleVoiceStart,
    handleVoiceEnd,
    rtcLastShot,
    isNarrow,
    callAssistantOpen,
    onNavigate,
  ]);

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

  useLayoutEffect(() => {
    if (activeTab !== 'camera') return
    const el = cameraPanelRef.current
    if (!el) return

    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height || 0)
      if (h > 0) setCameraPanelHeight(h)
    }

    apply()

    let ro
    try {
      ro = new ResizeObserver(() => apply())
      ro.observe(el)
    } catch {
      window.addEventListener('resize', apply)
    }

    return () => {
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', apply)
    }
  }, [activeTab, cameraSlots, loading, tabsOffset])

  useLayoutEffect(() => {
    const rowEl = rowRef.current
    if (!rowEl) return

    const apply = () => {
      const panelEl = activeTab === 'camera'
        ? cameraPanelRef.current
        : activeTab === 'video'
          ? videoPanelRef.current
          : imagePanelRef.current
      if (!panelEl) {
        setRightTopOffset(Math.max(0, tabsOffset))
        return
      }
      const rowTop = rowEl.getBoundingClientRect().top || 0
      const panelTop = panelEl.getBoundingClientRect().top || 0
      const panelHeight = Math.round(panelEl.getBoundingClientRect().height || 0)
      const offset = Math.max(0, Math.round(panelTop - rowTop))
      setRightTopOffset(offset)
      if (panelHeight > 0) setActiveLeftPanelHeight(panelHeight)

      const leftRect = leftBottomCardRef.current?.getBoundingClientRect?.() || leftColRef.current?.getBoundingClientRect?.()
      const leftBottom = Math.round(leftRect?.bottom || 0)
      const resultTop = Math.round(rightResultWrapRef.current?.getBoundingClientRect?.().top || (rowTop + offset))
      const targetH = Math.max(120, leftBottom - resultTop)
      setRightResultHeight(targetH)
    }

    apply()

    let ro
    try {
      ro = new ResizeObserver(() => apply())
      ro.observe(rowEl)
      if (leftColRef.current) ro.observe(leftColRef.current)
      if (leftBottomCardRef.current) ro.observe(leftBottomCardRef.current)
      if (imagePanelRef.current) ro.observe(imagePanelRef.current)
      if (cameraPanelRef.current) ro.observe(cameraPanelRef.current)
      if (videoPanelRef.current) ro.observe(videoPanelRef.current)
      if (rightResultWrapRef.current) ro.observe(rightResultWrapRef.current)
    } catch {
      window.addEventListener('resize', apply)
    }
    return () => {
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', apply)
    }
  }, [activeTab, tabsOffset, cameraPanelHeight])

  return (
    <Layout className="vision-detect-page">
      {visibleResult?.anomaly_count > 0 && (
        <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, width: '90%', maxWidth: 800, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', borderRadius: 8 }}>
          <Alert
            message="检测到异常"
            description={`发现 ${visibleResult.anomaly_count} 个异常部位，建议生成故障树进行深入分析`}
            type="warning"
            showIcon
            action={<Button type="primary" icon={<RocketOutlined />} onClick={handleGenerateFaultTree} danger>生成故障树</Button>}
          />
        </div>
      )}
      <Content>
        {isNarrow && activeTab === 'call' ? (
          <div style={{ padding: 0 }}>
            {tabItems.find((t) => t.key === 'call')?.children}
          </div>
        ) : (
          <div className="vision-detect-shell">
            <Row ref={rowRef} gutter={24} align="stretch">
              <Col ref={leftColRef} span={activeTab === 'camera' ? 14 : 10} style={{ display: 'flex', flexDirection: 'column' }}>
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

              <Card ref={leftBottomCardRef} size="small" style={{ marginTop: 16 }}>
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

            <Col
              span={activeTab === 'camera' ? 10 : 14}
              style={{
                paddingTop: rightTopOffset,
                display: 'flex',
                flexDirection: 'column',
                position: 'sticky',
                top: 12,
                alignSelf: 'flex-start',
              }}
            >
              {activeTab === 'camera' && (
                <Card
                  size="small"
                  style={{ marginBottom: 12, height: cameraPanelHeight ? cameraPanelHeight : undefined }}
                  styles={{ body: { height: '100%', display: 'flex', flexDirection: 'column' } }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flex: '0 0 auto' }}>
                    <Space size={8} wrap>
                      <div style={{ fontWeight: 600 }}>摄像头截图</div>
                      <Tag color="blue">{cameraShots.length}</Tag>
                    </Space>
                    <Button size="small" onClick={() => setCameraShots([])} disabled={cameraShots.length === 0}>清空</Button>
                  </div>
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    {cameraShots.length === 0 ? (
                      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无截图" />
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        {cameraShots.slice(0, 40).map((s) => (
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
                  </div>
                </Card>
              )}
              <div ref={rightResultWrapRef} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <DetectionResult
                  result={visibleResult}
                  loading={loading}
                  onGenerateFaultTree={handleGenerateFaultTree}
                  hideImage={activeTab === 'camera'}
                  hideEmptyUploadAction={activeTab === 'camera'}
                  style={{
                    height: rightResultHeight || undefined,
                    minHeight: rightResultHeight || undefined,
                  }}
                />
              </div>
            </Col>
            </Row>
          </div>
        )}
      </Content>
    </Layout>
  );
}
