/**
 * 视觉识别主页面
 * 整合图片上传、识别、结果展示、故障树生成等功能
 */

import React, { useState, useCallback } from 'react';
import { Layout, Row, Col, Card, Button, message, Divider, Space, Modal, Input, Select, Alert } from 'antd';
import { ThunderboltOutlined, RocketOutlined, SyncOutlined, SettingOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import ImageUploader from '../components/vision/ImageUploader';
import DetectionResult from '../components/vision/DetectionResult';
import './VisionDetect.css';

const { Content } = Layout;
const { TextArea } = Input;
const { Option } = Select;

/**
 * VisionDetect 页面
 */
export default function VisionDetect() {
  // 状态
  const [images, setImages] = useState([]);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [faultTreeModalVisible, setFaultTreeModalVisible] = useState(false);
  const [faultDescription, setFaultDescription] = useState('');
  const [equipmentType, setEquipmentType] = useState('motor');
  
  // 识别设置
  const [settings, setSettings] = useState({
    confThreshold: 0.25,
    iouThreshold: 0.45,
    device: 'cuda',
    returnAnnotated: true,
  });

  // 处理图片上传
  const handleImageUpload = useCallback((fileList) => {
    setImages(fileList);
  }, []);

  // 执行识别
  const handleDetect = useCallback(async () => {
    if (images.length === 0) {
      message.warning('请先上传图片');
      return;
    }

    setLoading(true);
    setResults(null);

    try {
      // 构建 FormData
      const formData = new FormData();
      
      // 添加第一张图片进行测试（简化处理）
      if (images.length > 0) {
        const firstImage = images[0];
        const file = firstImage.originFileObj || firstImage;
        
        // 如果 file 还没有 uid，使用 images[0]
        if (!file.name) {
          file.name = firstImage.name || 'image.jpg';
        }
        if (!file.type) {
          file.type = 'image/jpeg';
        }
        
        formData.append('file', file);
        formData.append('conf_threshold', settings.confThreshold.toString());
        formData.append('iou_threshold', settings.iouThreshold.toString());
        formData.append('return_annotated', settings.returnAnnotated.toString());
        formData.append('device', settings.device);
      }

      // 调用 API
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const response = await fetch(`${API_URL}/api/vision/detect/image`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`识别失败: ${response.statusText}`);
      }

      const data = await response.json();
      setResults(data);
      message.success(`识别完成！检测到 ${data.total_detections} 个目标，其中 ${data.anomaly_count} 个异常`);

    } catch (error) {
      console.error('识别错误:', error);
      message.error('识别失败: ' + error.message);
      
      // 模拟结果用于测试
      setResults(createMockResult());
    } finally {
      setLoading(false);
    }
  }, [images, settings]);

  // 生成故障树
  const handleGenerateFaultTree = useCallback(() => {
    if (!results) {
      message.warning('请先进行识别');
      return;
    }
    
    // 构建故障描述
    const detections = results.detections || [];
    const anomalyDetections = detections.filter(d => d.is_anomaly);
    
    if (anomalyDetections.length === 0) {
      message.info('未检测到异常，无法生成故障树');
      return;
    }
    
    // 跳转到生成页面，携带识别结果
    const faultInfo = {
      vision_result: JSON.stringify(results),
      fault_description: anomalyDetections.map(d => `${d.class_name}（置信度${(d.confidence * 100).toFixed(1)}%）`).join('；'),
      equipment_type: equipmentType
    };
    
    // 构建 URL 参数
    const params = new URLSearchParams(faultInfo);
    window.location.href = `/generate?${params.toString()}`;
  }, [results, equipmentType]);

  // 模拟结果（用于测试）
  const createMockResult = () => {
    return {
      detection_id: 'mock-' + Date.now(),
      image_width: 640,
      image_height: 480,
      process_time_ms: 150,
      model_name: 'yolo11m',
      device: 'cuda',
      total_detections: 3,
      anomaly_count: 1,
      overall_status: 'warning',
      detections: [
        {
          class_id: 0,
          class_name: 'motor_normal',
          confidence: 0.95,
          bbox: [100, 100, 300, 250],
          area_ratio: 0.25,
          is_anomaly: false,
          description: '电机外观正常，无明显异常'
        },
        {
          class_id: 3,
          class_name: 'bearing_wear',
          confidence: 0.87,
          bbox: [350, 200, 500, 350],
          area_ratio: 0.12,
          is_anomaly: true,
          description: '检测到轴承磨损，建议检查润滑系统'
        },
        {
          class_id: 5,
          class_name: 'pipe_corrosion',
          confidence: 0.72,
          bbox: [50, 300, 200, 420],
          area_ratio: 0.15,
          is_anomaly: true,
          description: '检测到管道腐蚀，需要进行防腐处理'
        }
      ],
      annotated_image: null
    };
  };

  return (
    <Layout className="vision-detect-page">
      <Content>
        {/* 页面标题 */}
        <div className="page-header">
          <h1>
            <ThunderboltOutlined /> 设备视觉识别
          </h1>
          <Space>
            <Button 
              icon={<SettingOutlined />}
              onClick={() => setSettingsVisible(true)}
            >
              设置
            </Button>
            <Button 
              icon={<QuestionCircleOutlined />}
              onClick={() => message.info('帮助信息：上传设备图片，系统将自动识别设备状态')}
            >
              帮助
            </Button>
          </Space>
        </div>

        {/* 警告信息 */}
        {results?.anomaly_count > 0 && (
          <Alert
            message="检测到异常"
            description={`发现 ${results.anomaly_count} 个异常部位，建议生成故障树进行深入分析`}
            type="warning"
            showIcon
            action={
              <Button 
                type="primary" 
                icon={<RocketOutlined />}
                onClick={handleGenerateFaultTree}
                danger
              >
                生成故障树
              </Button>
            }
            style={{ marginBottom: 16 }}
          />
        )}

        {/* 主内容区 */}
        <Row gutter={24}>
          {/* 左侧：上传区域 */}
          <Col span={8}>
            <Card 
              title="图片上传" 
              className="upload-card"
              extra={
                <Button 
                  type="text" 
                  icon={<SyncOutlined spin={loading} />}
                  onClick={() => {
                    setImages([]);
                    setResults(null);
                  }}
                  disabled={images.length === 0}
                >
                  重置
                </Button>
              }
            >
              <ImageUploader
                onUpload={handleImageUpload}
                onDetect={handleDetect}
                loading={loading}
                maxCount={9}
              />
            </Card>

            {/* 识别设置 */}
            <Card size="small" title="识别设置" style={{ marginTop: 16 }} className="settings-card">
              <Space direction="vertical" style={{ width: '100%' }}>
                <div>
                  <span>置信度阈值: {settings.confThreshold}</span>
                </div>
                <div>
                  <span>设备: {settings.device === 'cuda' ? 'GPU (CUDA)' : 'CPU'}</span>
                </div>
                <Button 
                  type="link" 
                  onClick={() => setSettingsVisible(true)}
                  icon={<SettingOutlined />}
                >
                  详细设置
                </Button>
              </Space>
            </Card>
          </Col>

          {/* 右侧：结果展示 */}
          <Col span={16}>
            <DetectionResult 
              result={results}
              loading={loading}
              onGenerateFaultTree={handleGenerateFaultTree}
            />
          </Col>
        </Row>
      </Content>

      {/* 设置弹窗 */}
      <Modal
        title="识别设置"
        open={settingsVisible}
        onCancel={() => setSettingsVisible(false)}
        footer={[
          <Button key="cancel" onClick={() => setSettingsVisible(false)}>
            取消
          </Button>,
          <Button key="save" type="primary" onClick={() => setSettingsVisible(false)}>
            保存
          </Button>
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <label>置信度阈值: {settings.confThreshold}</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.confThreshold}
              onChange={(e) => setSettings({...settings, confThreshold: parseFloat(e.target.value)})}
              style={{ width: '100%' }}
            />
            <small>低于此置信度的检测结果将被过滤</small>
          </div>
          
          <div>
            <label>IOU 阈值: {settings.iouThreshold}</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.iouThreshold}
              onChange={(e) => setSettings({...settings, iouThreshold: parseFloat(e.target.value)})}
              style={{ width: '100%' }}
            />
            <small>用于非极大值抑制(NMS)的IOU阈值</small>
          </div>
          
          <div>
            <label>计算设备</label>
            <Select 
              value={settings.device} 
              onChange={(value) => setSettings({...settings, device: value})}
              style={{ width: '100%' }}
            >
              <Option value="cuda">GPU (CUDA)</Option>
              <Option value="cpu">CPU</Option>
            </Select>
            <small>推荐使用GPU以获得更快的识别速度</small>
          </div>
          
          <div>
            <label>
              <input
                type="checkbox"
                checked={settings.returnAnnotated}
                onChange={(e) => setSettings({...settings, returnAnnotated: e.target.checked})}
              />
              {' '}返回标注图片
            </label>
            <small>启用后返回的图片会标注检测结果</small>
          </div>
        </Space>
      </Modal>

      {/* 故障树生成弹窗 */}
      <Modal
        title="生成故障树"
        open={faultTreeModalVisible}
        onCancel={() => setFaultTreeModalVisible(false)}
        onOk={() => {
          setFaultTreeModalVisible(false);
          handleGenerateFaultTree();
        }}
        okText="生成故障树"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <label>设备类型</label>
            <Select 
              value={equipmentType}
              onChange={setEquipmentType}
              style={{ width: '100%' }}
            >
              <Option value="motor">电机</Option>
              <Option value="pump">泵</Option>
              <Option value="valve">阀门</Option>
              <Option value="pipe">管道</Option>
              <Option value="bearing">轴承</Option>
              <Option value="other">其他</Option>
            </Select>
          </div>
          
          <div>
            <label>补充描述（可选）</label>
            <TextArea
              rows={4}
              value={faultDescription}
              onChange={(e) => setFaultDescription(e.target.value)}
              placeholder="补充更多故障信息..."
            />
          </div>
        </Space>
      </Modal>
    </Layout>
  );
}
