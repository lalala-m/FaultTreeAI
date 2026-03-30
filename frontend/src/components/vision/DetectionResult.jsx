/**
 * 检测结果展示组件
 * 展示识别结果、标注图片、统计信息
 */

import React, { useState, useMemo } from 'react';
import { Card, Row, Col, Table, Tag, Button, Slider, Space, Divider, Empty, Tooltip, Progress } from 'antd';
import { 
  DownloadOutlined, 
  RocketOutlined, 
  ThunderboltOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import './DetectionResult.css';

/**
 * 检测结果展示组件
 * 
 * @param {Object} result - 检测结果
 * @param {boolean} loading - 是否正在加载
 * @param {Function} onGenerateFaultTree - 生成故障树回调
 */
export default function DetectionResult({ 
  result, 
  loading = false, 
  onGenerateFaultTree 
}) {
  const [showConfidence, setShowConfidence] = useState(0.3);
  const [selectedTab, setSelectedTab] = useState('annotated'); // annotated | original | list

  // 过滤检测结果
  const filteredDetections = useMemo(() => {
    if (!result?.detections) return [];
    return result.detections.filter(d => d.confidence >= showConfidence);
  }, [result, showConfidence]);

  // 统计信息
  const stats = useMemo(() => {
    if (!result) return null;
    
    const normalCount = filteredDetections.filter(d => !d.is_anomaly).length;
    const anomalyCount = filteredDetections.filter(d => d.is_anomaly).length;
    const avgConfidence = filteredDetections.length > 0 
      ? filteredDetections.reduce((sum, d) => sum + d.confidence, 0) / filteredDetections.length 
      : 0;
    
    return {
      total: filteredDetections.length,
      normal: normalCount,
      anomaly: anomalyCount,
      avgConfidence: avgConfidence,
      processTime: result.process_time_ms
    };
  }, [result, filteredDetections]);

  // 获取状态图标
  const getStatusIcon = (status) => {
    switch (status) {
      case 'normal':
        return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
      case 'warning':
        return <WarningOutlined style={{ color: '#faad14' }} />;
      case 'critical':
        return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
      default:
        return <InfoCircleOutlined style={{ color: '#1890ff' }} />;
    }
  };

  // 获取状态颜色
  const getStatusColor = (status) => {
    switch (status) {
      case 'normal':
        return '#52c41a';
      case 'warning':
        return '#faad14';
      case 'critical':
        return '#ff4d4f';
      default:
        return '#1890ff';
    }
  };

  // 表格列定义
  const columns = [
    {
      title: '类别',
      dataIndex: 'class_name',
      key: 'class_name',
      width: 150,
      render: (text, record) => (
        <Tag color={record.is_anomaly ? 'red' : 'green'}>
          {text}
        </Tag>
      ),
    },
    {
      title: '置信度',
      dataIndex: 'confidence',
      key: 'confidence',
      width: 100,
      render: (value) => (
        <Progress 
          percent={Math.round(value * 100)} 
          size="small"
          strokeColor={value > 0.7 ? '#52c41a' : value > 0.5 ? '#faad14' : '#ff4d4f'}
          format={(p) => `${p}%`}
        />
      ),
      sorter: (a, b) => a.confidence - b.confidence,
    },
    {
      title: '位置',
      dataIndex: 'bbox',
      key: 'bbox',
      width: 150,
      render: ([x1, y1, x2, y2]) => `[${x1}, ${y1}, ${x2}, ${y2}]`,
    },
    {
      title: '面积占比',
      dataIndex: 'area_ratio',
      key: 'area_ratio',
      width: 100,
      render: (v) => `${(v * 100).toFixed(1)}%`,
      sorter: (a, b) => a.area_ratio - b.area_ratio,
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (text, record) => (
        <Tooltip title={text}>
          <span>{text}</span>
        </Tooltip>
      ),
    },
  ];

  // 无结果时显示空状态
  if (!result || !result.detections || result.detections.length === 0) {
    return (
      <Card className="detection-result">
        <Empty 
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无识别结果"
        >
          <Button type="primary" icon={<ThunderboltOutlined />}>
            上传图片开始识别
          </Button>
        </Empty>
      </Card>
    );
  }

  return (
    <Card 
      className="detection-result"
      loading={loading}
      title={
        <Space>
          {getStatusIcon(result.overall_status)}
          <span>识别结果 - {result.overall_status === 'normal' ? '正常' : result.overall_status === 'warning' ? '警告' : '危险'}</span>
        </Space>
      }
    >
      {/* 统计概览 */}
      <Row gutter={16} className="stats-row">
        <Col span={6}>
          <Card size="small" className="stat-card">
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">检测数量</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" className="stat-card normal">
            <div className="stat-value" style={{ color: '#52c41a' }}>{stats.normal}</div>
            <div className="stat-label">正常</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" className="stat-card anomaly">
            <div className="stat-value" style={{ color: '#ff4d4f' }}>{stats.anomaly}</div>
            <div className="stat-label">异常</div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" className="stat-card">
            <div className="stat-value">{stats.processTime.toFixed(0)}ms</div>
            <div className="stat-label">处理时间</div>
          </Card>
        </Col>
      </Row>

      {/* 置信度筛选 */}
      <div className="confidence-filter">
        <span>显示置信度 ≥ </span>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={showConfidence}
          onChange={setShowConfidence}
          style={{ width: 200, display: 'inline-block', margin: '0 10px' }}
          tooltip={{ formatter: (v) => `${(v * 100).toFixed(0)}%` }}
        />
        <Tag color="blue">{(showConfidence * 100).toFixed(0)}%</Tag>
        <span style={{ marginLeft: 10 }}>共 {filteredDetections.length} 个结果</span>
      </div>

      <Divider />

      {/* 图片展示区 */}
      <Row gutter={16}>
        {/* 左侧：图片 */}
        <Col span={14}>
          <Card 
            size="small" 
            title="标注图片" 
            className="image-card"
            tabList={[
              { key: 'annotated', tab: '标注图' },
              { key: 'original', tab: '原图' },
            ]}
            activeTabKey={selectedTab}
            onTabChange={setSelectedTab}
          >
            <div className="image-container">
              {result.annotated_image ? (
                <img 
                  src={`data:image/jpeg;base64,${selectedTab === 'annotated' ? result.annotated_image : ''}`}
                  alt="检测结果"
                  className="result-image"
                  onError={(e) => {
                    // 如果标注图片加载失败，尝试使用原图
                    if (selectedTab === 'annotated') {
                      e.target.src = result.annotated_image ? `data:image/jpeg;base64,${result.annotated_image}` : '';
                    }
                  }}
                />
              ) : (
                <Empty description="暂无标注图片" />
              )}
            </div>
          </Card>
        </Col>

        {/* 右侧：详情 */}
        <Col span={10}>
          <Card size="small" title="检测详情" className="detail-card">
            <Table
              columns={columns}
              dataSource={filteredDetections}
              rowKey={(record, index) => `${record.class_id}-${index}`}
              size="small"
              pagination={{ pageSize: 5, size: 'small' }}
              scroll={{ y: 300 }}
              rowClassName={(record) => record.is_anomaly ? 'anomaly-row' : ''}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* 操作按钮 */}
      <div className="result-actions">
        <Space>
          <Button 
            icon={<DownloadOutlined />}
            onClick={() => {
              // TODO: 下载结果
              console.log('Download result');
            }}
          >
            下载结果
          </Button>
          <Button 
            type="primary"
            icon={<RocketOutlined />}
            onClick={onGenerateFaultTree}
            disabled={stats.anomaly === 0}
            danger={stats.anomaly > 0}
          >
            基于识别结果生成故障树
          </Button>
        </Space>
        
        {stats.anomaly > 0 && (
          <Tag color="red" icon={<WarningOutlined />} style={{ marginLeft: 10 }}>
            检测到 {stats.anomaly} 个异常，建议生成故障树进行深入分析
          </Tag>
        )}
      </div>
    </Card>
  );
}
