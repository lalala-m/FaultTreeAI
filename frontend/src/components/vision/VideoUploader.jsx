/**
 * 视频识别组件
 * 支持视频文件上传、逐帧识别
 */

import React, { useState, useRef, useCallback } from 'react';
import { Button, Card, Space, Slider, message, List } from 'antd';
import { VideoCameraOutlined, PlayCircleOutlined, PauseCircleOutlined, StepForwardOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';

export default function VideoUploader({ onFrameCapture, onDetect, disabled = false }) {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [frames, setFrames] = useState([]);
  const [extracting, setExtracting] = useState(false);
  
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);

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
    message.success('视频已加载');
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    if (!videoRef.current) return
    const d = Number(videoRef.current.duration)
    if (Number.isFinite(d) && d > 0) setDuration(d)
  }, []);

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
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    
    const imageData = canvas.toDataURL('image/jpeg', 0.85);
    
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

  const _waitFrame = useCallback((video) => {
    return new Promise((resolve) => {
      const cb = () => resolve()
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => cb())
        setTimeout(cb, 800)
        return
      }
      setTimeout(cb, 120)
    })
  }, [])

  const _isMostlyBlack = useCallback((ctx, w, h) => {
    const sw = Math.max(16, Math.min(64, Math.floor(w / 10)))
    const sh = Math.max(16, Math.min(48, Math.floor(h / 10)))
    const x = Math.max(0, Math.floor((w - sw) / 2))
    const y = Math.max(0, Math.floor((h - sh) / 2))
    try {
      const data = ctx.getImageData(x, y, sw, sh).data
      let sum = 0
      for (let i = 0; i < data.length; i += 16) {
        sum += data[i] + data[i + 1] + data[i + 2]
      }
      const samples = Math.floor(data.length / 16)
      const avg = sum / (samples * 3)
      return avg < 8
    } catch {
      return false
    }
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
        message.error('视频元信息未加载或不支持该视频编码')
        return
      }
      setDuration(d)
    }
    setExtracting(true);
    
    try {
      const maxSeconds = 10
      const maxFrames = 150
      const newFrames = [];
      const video = videoRef.current
      const wasPlaying = !video.paused
      const prevPlaybackRate = Number(video.playbackRate || 1)
      try { video.pause() } catch {}
      await _waitReady(video)
      const canvas = document.createElement('canvas');
      const vw = Number(video.videoWidth || 1280)
      const vh = Number(video.videoHeight || 720)
      const maxSide = 768
      const scale = Math.min(1, maxSide / Math.max(vw, vh))
      canvas.width = Math.max(1, Math.round(vw * scale))
      canvas.height = Math.max(1, Math.round(vh * scale))
      let ctx = null
      try {
        ctx = canvas.getContext('2d', { willReadFrequently: true })
      } catch {
        ctx = canvas.getContext('2d')
      }
      if (!ctx) throw new Error('无法创建 Canvas 上下文')

      let lastCommitLen = 0
      const commitFrames = (force = false) => {
        if (!force && (newFrames.length - lastCommitLen) < 8) return
        lastCommitLen = newFrames.length
        setFrames([...newFrames])
      }
      setFrames([])
      
      const segment = Math.min(duration, maxSeconds)

      const startTime = 0
      await _seekTo(video, startTime)
      await _waitFrame(video)

      const useRVFC = typeof video.requestVideoFrameCallback === 'function'
      if (useRVFC) {
        let stop = false
        let take = true
        let rafId = null

        const finish = async () => {
          if (stop) return
          stop = true
          try { video.pause() } catch {}
          if (rafId != null) {
            try { video.cancelVideoFrameCallback?.(rafId) } catch {}
          }
        }

        await new Promise((resolve) => {
          const onFrame = (_now, metadata) => {
            if (stop) {
              resolve()
              return
            }
            const t = Number(metadata?.mediaTime ?? video.currentTime ?? 0)
            if (t >= segment || newFrames.length >= maxFrames) {
              finish().finally(resolve)
              return
            }

            if (take) {
              try {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                const frame = { id: Date.now() + newFrames.length, time: t, image: canvas.toDataURL('image/jpeg', 0.75) }
                newFrames.push(frame)
                onFrameCapture?.(frame)
                commitFrames(false)
              } catch {
              }
            }
            take = !take
            rafId = video.requestVideoFrameCallback(onFrame)
          }

          try {
            try {
              video.muted = true
              video.playbackRate = 8
            } catch {
            }
            video.play().then(() => {
              rafId = video.requestVideoFrameCallback(onFrame)
            }).catch(() => {
              stop = true
              resolve()
            })
          } catch {
            stop = true
            resolve()
          }
        })
      } else {
        const stepSeconds = 2 / 30
        let t = 0
        let guard = 0
        while (t < segment && newFrames.length < maxFrames && guard < 500) {
          guard += 1
          await _seekTo(video, t)
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            if (!_isMostlyBlack(ctx, canvas.width, canvas.height)) {
              const frame = { id: Date.now() + newFrames.length, time: t, image: canvas.toDataURL('image/jpeg', 0.75) }
              newFrames.push(frame)
              onFrameCapture?.(frame)
              commitFrames(false)
            }
          } catch {
          }
          t += stepSeconds
        }
      }
      
      commitFrames(true)
      if (newFrames.length === 0) {
        message.error('未能从视频中抽取有效画面（可能是编码不支持或视频全黑）')
        return
      }
      if (duration > maxSeconds) {
        message.success(`已抽取前 ${maxSeconds}s 的 ${newFrames.length} 帧（隔帧抽取）并开始识别`)
      } else {
        message.success(`已抽取 ${newFrames.length} 帧（隔帧抽取）并开始识别`)
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
  }, [duration, onFrameCapture, onDetect, _seekTo, _waitReady, _waitFrame, _isMostlyBlack]);

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
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [videoUrl]);

  const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

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
            <video ref={videoRef} src={videoUrl} onLoadedMetadata={handleLoadedMetadata} onDurationChange={handleDurationChange} onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)}
              style={{ width: '100%', display: 'block' }} />
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
              <Button icon={<ThunderboltOutlined />} onClick={extractKeyFramesAndDetect} loading={extracting} disabled={disabled || extracting || !(Number.isFinite(duration) && duration > 0)}>
                隔一帧抽一帧并识别
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
