/**
 * 视觉识别主页面
 * 整合图片上传、视频识别、摄像头捕获、识别、结果展示、故障树生成等功能
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Layout, Row, Col, Card, Button, message, Divider, Space, Tabs, Alert } from 'antd';
import { ThunderboltOutlined, RocketOutlined, SyncOutlined, CameraOutlined, VideoCameraOutlined, PictureOutlined } from '@ant-design/icons';
import ImageUploader from '../../components/vision/ImageUploader';
import CameraCapture from '../../components/vision/CameraCapture';
import VideoUploader from '../../components/vision/VideoUploader';
import DetectionResult from '../../components/vision/DetectionResult';

const { Content } = Layout;
const { TabPane } = Tabs;

export default function VisionDetect() {
  const [images, setImages] = useState([]);
  const [cameraImage, setCameraImage] = useState(null);
  const [videoFrames, setVideoFrames] = useState([]);
  const [allImages, setAllImages] = useState([]);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [equipmentType, setEquipmentType] = useState('motor');
  const [activeTab, setActiveTab] = useState('image');
  
  const [settings] = useState({
    confThreshold: 0.25,
    iouThreshold: 0.45,
    device: 'cuda',
    returnAnnotated: true,
  });

  // 收集所有图片
  useEffect(() => {
    const collected = [];
    
    images.forEach((img, idx) => {
      if (img.originFileObj) {
        collected.push({
          id: `img-${idx}`,
          source: 'upload',
          file: img.originFileObj,
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
      formData.append('device', settings.device);

      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const endpoint = (firstImage.source === 'upload' && firstImage.file) 
        ? '/api/vision/detect/image' 
        : '/api/vision/detect/base64';
      
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error(`识别失败: ${response.statusText}`);

      const data = await response.json();
      setResults(data);
      message.success(`识别完成！检测到 ${data.total_detections} 个目标，其中 ${data.anomaly_count} 个异常`);

    } catch (error) {
      console.error('识别错误:', error);
      setResults(createMockResult());
      message.warning('API 调用失败，使用模拟结果');
    } finally {
      setLoading(false);
    }
  }, [allImages, settings]);

  const handleBatchDetect = useCallback(async () => {
    if (allImages.length === 0) {
      message.warning('没有可识别的图片');
      return;
    }

    setLoading(true);
    
    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const resultsList = [];
      
      for (const img of allImages) {
        try {
          const formData = new FormData();
          
          if (img.source === 'upload' && img.file) {
            formData.append('file', img.file);
          } else {
            const base64Data = img.base64.split(',')[1] || img.base64;
            formData.append('image_data', base64Data);
          }
          
          formData.append('conf_threshold', settings.confThreshold.toString());
          formData.append('return_annotated', 'false');
          formData.append('device', settings.device);

          const endpoint = (img.source === 'upload' && img.file) 
            ? '/api/vision/detect/image' 
            : '/api/vision/detect/base64';
          
          const response = await fetch(`${API_URL}${endpoint}`, { method: 'POST', body: formData });
          
          if (response.ok) {
            const data = await response.json();
            resultsList.push({ ...data, source: img.source });
          }
        } catch (e) {
          console.error('单张识别失败:', e);
        }
      }
      
      if (resultsList.length > 0) {
        const totalDetections = resultsList.reduce((sum, r) => sum + r.total_detections, 0);
        const totalAnomalies = resultsList.reduce((sum, r) => sum + r.anomaly_count, 0);
        
        setResults({
          ...resultsList[0],
          total_detections: totalDetections,
          anomaly_count: totalAnomalies,
          batch_results: resultsList
        });
        
        message.success(`批量识别完成！共处理 ${resultsList.length} 张图片`);
      } else {
        message.error('所有图片识别失败');
      }
      
    } catch (error) {
      console.error('批量识别错误:', error);
      message.error('批量识别失败');
    } finally {
      setLoading(false);
    }
  }, [allImages, settings]);

  const handleGenerateFaultTree = useCallback(() => {
    if (!results) {
      message.warning('请先进行识别');
      return;
    }
    
    const detections = results.detections || [];
    const anomalyDetections = detections.filter(d => d.is_anomaly);
    
    if (anomalyDetections.length === 0) {
      message.info('未检测到异常，无法生成故障树');
      return;
    }
    
    const faultInfo = {
      vision_result: JSON.stringify(results),
      fault_description: anomalyDetections.map(d => 
        `${d.class_name}（置信度${(d.confidence * 100).toFixed(1)}%）：${d.description}`
      ).join('；\n'),
      equipment_type: equipmentType,
      source: 'vision'
    };
    
    const params = new URLSearchParams();
    Object.entries(faultInfo).forEach(([key, value]) => {
      params.append(key, value);
    });
    
    window.location.href = `/generate?${params.toString()}`;
  }, [results, equipmentType]);

  const handleReset = useCallback(() => {
    setImages([]);
    setCameraImage(null);
    setVideoFrames([]);
    setAllImages([]);
    setResults(null);
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

  return (
    <Layout className="vision-detect-page">
      <Content>
        <div className="page-header">
          <h1><ThunderboltOutlined /> 设备视觉识别</h1>
          <Button icon={<SyncOutlined />} onClick={handleReset} disabled={loading}>重置</Button>
        </div>

        {results?.anomaly_count > 0 && (
          <Alert
            message="检测到异常"
            description={`发现 ${results.anomaly_count} 个异常部位，建议生成故障树进行深入分析`}
            type="warning"
            showIcon
            action={<Button type="primary" icon={<RocketOutlined />} onClick={handleGenerateFaultTree} danger>生成故障树</Button>}
            style={{ marginBottom: 16 }}
          />
        )}

        <Row gutter={24}>
          <Col span={10}>
            <Tabs activeKey={activeTab} onChange={setActiveTab} size="small">
              <TabPane tab={<span><PictureOutlined /> 图片上传</span>} key="image">
                <Card size="small">
                  <ImageUploader onUpload={handleImageUpload} onDetect={handleDetect} loading={loading} maxCount={9} />
                </Card>
              </TabPane>
              
              <TabPane tab={<span><CameraOutlined /> 摄像头</span>} key="camera">
                <Card size="small">
                  <CameraCapture onCapture={handleCameraCapture} disabled={loading} />
                </Card>
              </TabPane>
              
              <TabPane tab={<span><VideoCameraOutlined /> 视频</span>} key="video">
                <Card size="small">
                  <VideoUploader onFrameCapture={(img) => setVideoFrames(prev => [...prev, { id: Date.now(), image: img, time: 0 }])} disabled={loading} />
                </Card>
              </TabPane>
            </Tabs>

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
                <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleDetect} loading={loading} size="large" block disabled={allImages.length === 0}>
                  识别当前图片
                </Button>
                
                {allImages.length > 1 && (
                  <Button icon={<ThunderboltOutlined />} onClick={handleBatchDetect} loading={loading} size="large" block>
                    批量识别所有图片 ({allImages.length}张)
                  </Button>
                )}
                
                <Divider>设备类型</Divider>
                
                <select value={equipmentType} onChange={(e) => setEquipmentType(e.target.value)} style={{ width: '100%', padding: '8px' }}>
                  <option value="motor">电机</option>
                  <option value="pump">泵</option>
                  <option value="valve">阀门</option>
                  <option value="pipe">管道</option>
                  <option value="bearing">轴承</option>
                  <option value="hydraulic">液压系统</option>
                  <option value="plc">PLC控制器</option>
                  <option value="other">其他</option>
                </select>
              </Space>
            </Card>
          </Col>

          <Col span={14}>
            <DetectionResult result={results} loading={loading} onGenerateFaultTree={handleGenerateFaultTree} />
          </Col>
        </Row>
      </Content>
    </Layout>
  );
}
