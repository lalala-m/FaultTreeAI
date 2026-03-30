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
    if (videoRef.current) setDuration(videoRef.current.duration);
  }, []);

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
    
    if (onFrameCapture) onFrameCapture(imageData);
    message.success(`已捕获第 ${frames.length + 1} 帧`);
  }, [frames.length, onFrameCapture]);

  const extractFrames = useCallback(async () => {
    if (!videoRef.current || duration <= 0) return;
    setExtracting(true);
    
    try {
      const frameCount = Math.min(Math.floor(duration), 10);
      const newFrames = [];
      
      for (let i = 0; i < frameCount; i++) {
        const time = (i / frameCount) * duration;
        videoRef.current.currentTime = time;
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const canvas = document.createElement('canvas');
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoRef.current, 0, 0);
        
        newFrames.push({ id: Date.now() + i, time, image: canvas.toDataURL('image/jpeg', 0.85) });
      }
      
      setFrames(prev => [...prev, ...newFrames]);
      message.success(`已提取 ${newFrames.length} 帧`);
      
      if (videoRef.current) videoRef.current.currentTime = 0;
    } catch (error) {
      console.error('帧提取失败:', error);
      message.error('帧提取失败');
    } finally {
      setExtracting(false);
    }
  }, [duration, onFrameCapture]);

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
            <video ref={videoRef} src={videoUrl} onLoadedMetadata={handleLoadedMetadata} onTimeUpdate={handleTimeUpdate}
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
              <Button icon={<ThunderboltOutlined />} onClick={extractFrames} loading={extracting}>自动提取帧</Button>
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
