/**
 * 检测结果展示组件
 * 展示识别结果、标注图片、统计信息
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  onGenerateFaultTree,
  hideImage = false,
  style,
  className,
}) {
  const [showConfidence, setShowConfidence] = useState(0.3);
  const [selectedTab, setSelectedTab] = useState('annotated'); // annotated | original | list
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0)
  const [canvasDim, setCanvasDim] = useState({ w: 0, h: 0 })
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  const isBatch = Array.isArray(result?.batch_results) && result.batch_results.length > 0
  const activeResult = isBatch ? (result.batch_results[selectedFrameIndex] || result.batch_results[0]) : result

  useEffect(() => {
    setSelectedFrameIndex(0)
  }, [isBatch])

  useEffect(() => {
    if (selectedTab !== 'annotated') return
    if (!activeResult) return
    if (activeResult.annotated_image) return
    if (!activeResult.original_image_url) return
    const canvas = canvasRef.current
    if (!canvas) return

    const img = new Image()
    img.onload = () => {
      canvas.width = img.naturalWidth || img.width || 0
      canvas.height = img.naturalHeight || img.height || 0
      setCanvasDim({ w: canvas.width || 0, h: canvas.height || 0 })
      const ctx = canvas.getContext('2d')
      if (!ctx || !canvas.width || !canvas.height) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      const dets = Array.isArray(activeResult.detections) ? activeResult.detections : []
      dets.filter(d => (d.confidence || 0) >= showConfidence).forEach((d) => {
        const box = Array.isArray(d.bbox) ? d.bbox : null
        if (!box || box.length !== 4) return
        const [x1, y1, x2, y2] = box.map(n => Number(n) || 0)
        if (x2 <= x1 || y2 <= y1) return
        const w = Math.max(1, x2 - x1)
        const h = Math.max(1, y2 - y1)
        const isAnomaly = !!d.is_anomaly
        ctx.strokeStyle = isAnomaly ? '#ff4d4f' : '#52c41a'
        ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400))
        ctx.strokeRect(x1, y1, w, h)

        const label = `${d.class_name || ''} ${(d.confidence != null ? d.confidence : 0) * 100.0}`.trim()
        if (!label) return
        ctx.font = `${Math.max(12, Math.round(canvas.width / 60))}px sans-serif`
        const pad = 4
        const text = label.endsWith('%') ? label : `${d.class_name || ''} ${(Math.round(((d.confidence || 0) * 1000)) / 10).toFixed(1)}%`
        const metrics = ctx.measureText(text)
        const tw = metrics.width + pad * 2
        const th = Math.max(14, Math.round(canvas.width / 55)) + pad * 2
        const tx = Math.max(0, x1)
        const ty = Math.max(0, y1 - th)
        ctx.fillStyle = isAnomaly ? 'rgba(255,77,79,0.85)' : 'rgba(82,196,26,0.85)'
        ctx.fillRect(tx, ty, tw, th)
        ctx.fillStyle = '#fff'
        ctx.fillText(text, tx + pad, ty + th - pad)
      })
    }
    img.src = activeResult.original_image_url
  }, [activeResult, selectedTab, showConfidence])

  // 过滤检测结果
  const filteredDetections = useMemo(() => {
    if (!activeResult?.detections) return [];
    return activeResult.detections.filter(d => d.confidence >= showConfidence);
  }, [activeResult, showConfidence]);

  // 统计信息
  const stats = useMemo(() => {
    if (!activeResult) return null;
    
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
      processTime: activeResult.process_time_ms
    };
  }, [activeResult, filteredDetections]);

  const hasAnomaly = useMemo(() => {
    const ac = Number(activeResult?.anomaly_count || 0)
    if (ac > 0) return true
    return filteredDetections.some(d => d.is_anomaly)
  }, [activeResult, filteredDetections])

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
  if (!activeResult) {
    return (
      <Card className={`detection-result${className ? ` ${className}` : ''}`} style={style}>
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
      className={`detection-result${className ? ` ${className}` : ''}`}
      style={style}
      loading={loading}
      title={
        <Space>
          {getStatusIcon(activeResult.overall_status)}
          <span>识别结果 - {activeResult.overall_status === 'normal' ? '正常' : activeResult.overall_status === 'warning' ? '警告' : '危险'}</span>
          {activeResult?.model_name && (
            <Tag color="geekblue">{String(activeResult.model_name)}</Tag>
          )}
        </Space>
      }
    >
      {(!activeResult.detections || activeResult.detections.length === 0) && (
        <div style={{ marginBottom: 12 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="已完成识别，但未检测到目标（0 个框）" />
        </div>
      )}
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

      {!hideImage ? (
        <Row gutter={16}>
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
              <div className={`image-container ${hasAnomaly ? 'anomaly' : 'normal'}`}>
                {selectedTab === 'original' ? (
                  activeResult?.original_image_url ? (
                    <img
                      src={activeResult.original_image_url}
                      alt="原图"
                      className="result-image"
                      ref={imgRef}
                    />
                  ) : (
                    <Empty description="暂无原图" />
                  )
                ) : (
                  activeResult?.annotated_image ? (
                    <img
                      src={`data:image/jpeg;base64,${activeResult.annotated_image}`}
                      alt="标注图"
                      className="result-image"
                    />
                  ) : activeResult?.original_image_url ? (
                    <canvas
                      ref={canvasRef}
                      className="result-image"
                      style={{
                        width: '100%',
                        height: 'auto',
                        maxHeight: '62vh',
                        display: 'block',
                        borderRadius: 6,
                        aspectRatio: canvasDim.w > 0 && canvasDim.h > 0 ? `${canvasDim.w} / ${canvasDim.h}` : undefined,
                      }}
                    />
                  ) : (
                    <Empty description="暂无标注图片" />
                  )
                )}
              </div>
            </Card>
          </Col>
          <Col span={10}>
            <Card size="small" title="检测详情" className="detail-card">
              <Table
                columns={columns}
                dataSource={filteredDetections}
                rowKey={(record) => {
                  const box = Array.isArray(record.bbox) ? record.bbox.join(',') : ''
                  const conf = typeof record.confidence === 'number' ? record.confidence.toFixed(6) : String(record.confidence || '')
                  return `${record.class_id || record.class_name || 'cls'}-${box}-${conf}`
                }}
                size="small"
                pagination={{ pageSize: 5, size: 'small' }}
                scroll={{ y: 300 }}
                rowClassName={(record) => record.is_anomaly ? 'anomaly-row' : ''}
              />
            </Card>
          </Col>
        </Row>
      ) : (
        <Card size="small" title="检测详情" className="detail-card">
          <Table
            columns={columns}
            dataSource={filteredDetections}
            rowKey={(record) => {
              const box = Array.isArray(record.bbox) ? record.bbox.join(',') : ''
              const conf = typeof record.confidence === 'number' ? record.confidence.toFixed(6) : String(record.confidence || '')
              return `${record.class_id || record.class_name || 'cls'}-${box}-${conf}`
            }}
            size="small"
            pagination={{ pageSize: 5, size: 'small' }}
            scroll={{ y: 360 }}
            rowClassName={(record) => record.is_anomaly ? 'anomaly-row' : ''}
          />
        </Card>
      )}

      {isBatch && (
        <>
          <Divider />
          <Card size="small" title="视频帧" className="detail-card">
            <div style={{ display: 'flex', gap: 8, overflow: 'auto' }}>
              {result.batch_results.map((r, idx) => (
                <Button
                  key={idx}
                  size="small"
                  type={idx === selectedFrameIndex ? 'primary' : 'default'}
                  onClick={() => setSelectedFrameIndex(idx)}
                >
                  帧 {idx + 1}
                </Button>
              ))}
            </div>
          </Card>
        </>
      )}

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
