/**
 * 摄像头捕获组件
 * 支持本地摄像头实时预览、拍照
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button, Card, Space, message, Spin } from 'antd';
import { CameraOutlined, StopOutlined, SaveOutlined, ReloadOutlined } from '@ant-design/icons';

const CAMERA_CONFIG = { width: 640, height: 480, facingMode: 'environment' };

export default function CameraCapture({ onCapture, disabled = false }) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [capturedImage, setCapturedImage] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const startCamera = useCallback(async () => {
    try {
      setLoading(true);
      setCameraError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: CAMERA_CONFIG.width, height: CAMERA_CONFIG.height, facingMode: CAMERA_CONFIG.facingMode },
        audio: false
      });
      
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsStreaming(true);
      }
      
      message.success('摄像头已启动');
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

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsStreaming(false);
    message.info('摄像头已关闭');
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

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  return (
    <Card size="small" title="摄像头捕获"
      extra={
        <Space>
          {!isStreaming ? (
            <Button type="primary" icon={<CameraOutlined />} onClick={startCamera} loading={loading} disabled={disabled} size="small">
              启动摄像头
            </Button>
          ) : (
            <Button danger icon={<StopOutlined />} onClick={stopCamera} size="small">关闭</Button>
          )}
        </Space>
      }
    >
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      
      <div className="camera-container" style={{ position: 'relative', minHeight: 200, background: '#f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
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
        
        <video ref={videoRef} style={{ display: isStreaming ? 'block' : 'none', width: '100%' }} playsInline muted />
        
        {showPreview && capturedImage && (
          <div style={{ position: 'absolute', inset: 0, background: '#000' }}>
            <img src={capturedImage} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
        )}
      </div>
      
      {isStreaming && !showPreview && (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <Button type="primary" icon={<CameraOutlined />} onClick={capturePhoto} size="large">拍照</Button>
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
        <small style={{ color: '#999' }}>提示：拍照后可上传进行识别，或直接使用图片生成故障树</small>
      </div>
    </Card>
  );
}
