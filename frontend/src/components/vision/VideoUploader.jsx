/**
 * 视频识别组件
 * 支持视频文件上传、逐帧识别
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button, Card, Space, Slider, message, List } from 'antd';
import { VideoCameraOutlined, PlayCircleOutlined, PauseCircleOutlined, StepForwardOutlined, DeleteOutlined, ThunderboltOutlined, CloudUploadOutlined } from '@ant-design/icons';

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

export default function VideoUploader({ onFrameCapture, onDetect, disabled = false, autoExtract = true }) {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [frames, setFrames] = useState([]);
  const [extracting, setExtracting] = useState(false);
  
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const autoExtractedRef = useRef(false);
  const extractRef = useRef(null);

  const handleFileSelect = useCallback((event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('video/')) {
      message.error('请选择视频文件');
      return;
    }
    
    if (file.size > 100 * 1024 * 1024) {
      message.error('视频文件不能超过 100MB');
      return;
    }
    
    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setFrames([]);
    setCurrentTime(0);
    setIsPlaying(false);
    autoExtractedRef.current = false;
    message.success('视频已加载');
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    if (!videoRef.current) return
    const d = Number(videoRef.current.duration)
    if (Number.isFinite(d) && d > 0) {
      setDuration(d)
    }
  }, []);

  const handleLoadedData = useCallback(() => {
    if (!videoRef.current) return
    const d = Number(videoRef.current.duration)
    if (Number.isFinite(d) && d > 0) {
      setDuration(d)
    }
    if (autoExtract && !autoExtractedRef.current && !extracting) {
      autoExtractedRef.current = true
      // 稍延迟一点，让浏览器有机会完成首帧解码
      window.setTimeout(() => extractRef.current?.(), 600)
    }
  }, [autoExtract, extracting]);

  const handleDurationChange = useCallback(() => {
    if (!videoRef.current) return
    const d = Number(videoRef.current.duration)
    if (Number.isFinite(d) && d > 0) setDuration(d)
  }, [])

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (isPlaying) videoRef.current.pause();
    else videoRef.current.play();
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  const seekTo = useCallback((time) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = time;
    setCurrentTime(time);
  }, []);

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  }, []);

  const captureFrame = useCallback(() => {
    if (!videoRef.current) return;
    
    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
      message.error('视频尚未准备好，请等待加载完成');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    
    const imageData = canvas.toDataURL('image/jpeg', 0.85);
    if (!imageData || imageData.length < 100 || imageData === 'data:,' || imageData === 'data:image/jpeg;base64,') {
      message.error('当前帧画面为空，请等待视频加载完成后再捕获');
      return
    }

    const newFrame = { id: Date.now(), time: video.currentTime, image: imageData };
    setFrames(prev => [...prev, newFrame]);

    if (onFrameCapture) onFrameCapture(newFrame);
    message.success(`已捕获第 ${frames.length + 1} 帧`);
  }, [frames.length, onFrameCapture]);

  const _seekTo = useCallback((video, t) => {
    return new Promise((resolve) => {
      let done = false
      let timer = null
      const onSeeked = () => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        video.removeEventListener('seeked', onSeeked)
        resolve()
      }
      video.addEventListener('seeked', onSeeked)
      video.currentTime = t
      timer = setTimeout(() => onSeeked(), 220)
    })
  }, [])

  const _waitReady = useCallback((video) => {
    return new Promise((resolve) => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        resolve()
        return
      }
      const onLoaded = () => {
        video.removeEventListener('loadeddata', onLoaded)
        video.removeEventListener('loadedmetadata', onLoaded)
        resolve()
      }
      video.addEventListener('loadeddata', onLoaded)
      video.addEventListener('loadedmetadata', onLoaded)
      setTimeout(() => onLoaded(), 1500)
    })
  }, [])

  // 等待视频画面尺寸就绪；某些浏览器/编码下需要触发播放才能拿到 videoWidth
  const _waitVideoDimensions = useCallback(async (video) => {
    const maxWaitMs = 4000
    const start = Date.now()
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    let triedPlay = false
    while (Date.now() - start < maxWaitMs) {
      const vw = Number(video.videoWidth || 0)
      const vh = Number(video.videoHeight || 0)
      if (vw > 0 && vh > 0) return { width: vw, height: vh }
      // 如果尺寸还没出来，尝试触发一次解码（静音播放再暂停）
      if (!triedPlay && video.paused && video.muted === false) {
        try { video.muted = true } catch {}
      }
      if (!triedPlay && video.paused) {
        try {
          const playPromise = video.play()
          if (playPromise && typeof playPromise.then === 'function') {
            playPromise.then(() => {
              setTimeout(() => { try { video.pause() } catch {} }, 80)
            }).catch(() => {})
          }
        } catch {}
        triedPlay = true
      }
      await sleep(200)
    }
    return { width: Number(video.videoWidth || 0), height: Number(video.videoHeight || 0) }
  }, [])

  const _extractFramesViaBackend = useCallback(async (file) => {
    if (!file) return
    const API_URL = getApiBaseUrl()
    const endpoint = API_URL ? `${API_URL}/api/vision/video/extract-frames` : '/api/vision/video/extract-frames'
    setExtracting(true)
    try {
      const formData = new FormData()
      formData.append('video', file)
      formData.append('max_seconds', '10')
      formData.append('max_frames', '24')
      const resp = await fetch(endpoint, {
        method: 'POST',
        body: formData,
      })
      if (!resp.ok) {
        let detail = ''
        try {
          const errJson = await resp.json()
          detail = errJson?.detail || errJson?.message || errJson?.error || ''
        } catch {
          detail = resp.statusText
        }
        message.error(`服务器抽帧失败: ${detail || resp.statusText}`)
        return
      }
      const data = await resp.json()
      const backendFrames = (data.frames || []).filter(f => f.image)
      if (backendFrames.length === 0) {
        message.error('服务器未能从视频中抽取有效帧')
        return
      }
      const mapped = backendFrames.map((f, idx) => ({
        id: Date.now() + idx,
        time: f.time,
        image: f.image,
      }))
      setFrames(mapped)
      mapped.forEach(f => onFrameCapture?.(f))
      message.success(`服务器已抽取 ${mapped.length} 帧并开始识别`)
      onDetect?.(mapped)
    } catch (e) {
      console.error('服务器抽帧失败:', e)
      message.error('服务器抽帧失败，请检查网络或后端 ffmpeg')
    } finally {
      setExtracting(false)
    }
  }, [onFrameCapture, onDetect])

  const _isValidFrameImage = useCallback((dataUrl) => {
    const s = String(dataUrl || '')
    return s.length > 100 && s.startsWith('data:image/') && s.includes(',') && s.split(',')[1].length > 50
  }, [])

  const extractKeyFramesAndDetect = useCallback(async () => {
    if (!videoRef.current) {
      message.warning('请先加载视频')
      return
    }
    if (!(Number.isFinite(duration) && duration > 0)) {
      await _waitReady(videoRef.current)
      const d = Number(videoRef.current.duration)
      if (!(Number.isFinite(d) && d > 0)) {
        // 浏览器连时长都读不到，说明编码不支持，直接走服务器抽帧
        if (videoFile) {
          return await _extractFramesViaBackend(videoFile)
        }
        message.error('视频元信息未加载或不支持该视频编码，请尝试 MP4/H.264 格式')
        return
      }
      setDuration(d)
    }
    setExtracting(true);

    try {
      const maxSeconds = 10
      const maxFrames = 24
      const newFrames = [];
      const video = videoRef.current
      const wasPlaying = !video.paused
      const prevPlaybackRate = Number(video.playbackRate || 1)
      try { video.pause() } catch {}
      await _waitReady(video)

      const { width: vw, height: vh } = await _waitVideoDimensions(video)
      if (!vw || !vh) {
        // 前端读不到尺寸时，尝试由后端 ffmpeg 抽帧
        if (videoFile) {
          return await _extractFramesViaBackend(videoFile)
        }
        message.error('无法读取视频画面尺寸，可能是当前浏览器不支持该视频编码（如 H.265/HEVC/AV1），请尝试转换为 MP4/H.264 后重试')
        return
      }

      const canvas = document.createElement('canvas');
      const maxSide = 768
      const scale = Math.min(1, maxSide / Math.max(vw, vh))
      canvas.width = Math.max(1, Math.round(vw * scale))
      canvas.height = Math.max(1, Math.round(vh * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建 Canvas 上下文')

      let lastCommitLen = 0
      const commitFrames = (force = false) => {
        if (!force && (newFrames.length - lastCommitLen) < 4) return
        lastCommitLen = newFrames.length
        setFrames([...newFrames])
      }
      setFrames([])

      const segment = Math.min(duration, maxSeconds)
      // 均匀抽取：把 segment 分成 maxFrames 段，每段取中间一帧
      const count = Math.max(1, Math.min(maxFrames, Math.floor(segment * 3)))
      const step = segment / count

      for (let i = 0; i < count; i += 1) {
        const t = Math.min(segment - 0.001, Math.max(0, (i + 0.5) * step))
        await _seekTo(video, t)
        await _waitReady(video)
        if (video.paused === false) {
          try { video.pause() } catch {}
        }
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const imageData = canvas.toDataURL('image/jpeg', 0.75)
          if (_isValidFrameImage(imageData)) {
            const frame = { id: Date.now() + i, time: t, image: imageData }
            newFrames.push(frame)
            onFrameCapture?.(frame)
            commitFrames(false)
          }
        } catch {
        }
        if (newFrames.length >= maxFrames) break
      }

      commitFrames(true)
      if (newFrames.length === 0) {
        message.error('未能从视频中抽取有效画面（可能是编码不支持或视频全黑）')
        return
      }
      if (duration > maxSeconds) {
        message.success(`已自动抽取前 ${maxSeconds}s 的 ${newFrames.length} 帧并开始识别`)
      } else {
        message.success(`已自动抽取 ${newFrames.length} 帧并开始识别`)
      }
      onDetect?.(newFrames)

      try { video.currentTime = 0 } catch {}
      try { video.playbackRate = prevPlaybackRate } catch {}
      if (wasPlaying) {
        try { video.play() } catch {}
      }
    } catch (error) {
      console.error('帧提取失败:', error);
      message.error('帧提取失败');
    } finally {
      setExtracting(false);
    }
  }, [duration, onFrameCapture, onDetect, _seekTo, _waitReady, _waitVideoDimensions, _extractFramesViaBackend, _isValidFrameImage]);

  const removeFrame = useCallback((frameId) => {
    setFrames(prev => prev.filter(f => f.id !== frameId));
  }, []);

  const clearFrames = useCallback(() => setFrames([]), []);

  const clearVideo = useCallback(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoFile(null);
    setVideoUrl(null);
    setFrames([]);
    setCurrentTime(0);
    autoExtractedRef.current = false;
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [videoUrl]);

  const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

  useEffect(() => {
    extractRef.current = extractKeyFramesAndDetect
  }, [extractKeyFramesAndDetect])

  return (
    <Card size="small" title="视频识别"
      extra={videoFile && (
        <Button type="text" danger icon={<DeleteOutlined />} onClick={clearVideo}>清除</Button>
      )}
    >
      {!videoFile && (
        <div style={{ textAlign: 'center', padding: 20 }}>
          <input ref={fileInputRef} type="file" accept="video/*" onChange={handleFileSelect} style={{ display: 'none' }} />
          <Button icon={<VideoCameraOutlined />} onClick={() => fileInputRef.current?.click()} disabled={disabled} size="large">
            选择视频文件
          </Button>
          <p style={{ color: '#999', marginTop: 8 }}>支持 mp4, avi, mov 等格式，最大 100MB</p>
        </div>
      )}
      
      {videoUrl && (
        <>
          <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
            <video
              ref={videoRef}
              src={videoUrl}
              preload="auto"
              playsInline
              webkit-playsinline="true"
              onLoadedMetadata={handleLoadedMetadata}
              onLoadedData={handleLoadedData}
              onDurationChange={handleDurationChange}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
              style={{ width: '100%', display: 'block' }}
            />
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ minWidth: 40 }}>{formatTime(currentTime)}</span>
            <Slider min={0} max={duration} value={currentTime} onChange={seekTo} style={{ flex: 1 }} />
            <span style={{ minWidth: 40 }}>{formatTime(duration)}</span>
          </div>
          
          <div style={{ marginTop: 8, textAlign: 'center' }}>
            <Space>
              <Button icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />} onClick={togglePlay}>
                {isPlaying ? '暂停' : '播放'}
              </Button>
              <Button icon={<StepForwardOutlined />} onClick={captureFrame}>捕获当前帧</Button>
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={extractKeyFramesAndDetect} loading={extracting} disabled={disabled || extracting || !(Number.isFinite(duration) && duration > 0)}>
                自动抽取关键帧并识别
              </Button>
              <Button icon={<CloudUploadOutlined />} onClick={() => _extractFramesViaBackend(videoFile)} loading={extracting} disabled={disabled || extracting || !videoFile}>
                服务器抽帧
              </Button>
            </Space>
          </div>
        </>
      )}
      
      {frames.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span>已捕获 {frames.length} 帧</span>
            <Button size="small" onClick={clearFrames}>清空</Button>
          </div>
          <List size="small" dataSource={frames} style={{ maxHeight: 200, overflow: 'auto' }}
            renderItem={(frame) => (
              <List.Item actions={[<Button key="remove" type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => removeFrame(frame.id)} />]}>
                <List.Item.Meta avatar={<img src={frame.image} alt="frame" style={{ width: 60, height: 45, objectFit: 'cover' }} />}
                  title={`帧 ${frames.indexOf(frame) + 1}`} description={`时间: ${formatTime(frame.time)}`} />
              </List.Item>
            )} />
        </div>
      )}
    </Card>
  );
}
