import React, { useState, useEffect } from 'react'
import {
  Card, Upload, Table, Button, Space, Tag, Typography, message, Progress, Empty, Popconfirm, Steps, Alert
} from 'antd'
import { 
  UploadOutlined, 
  DeleteOutlined, 
  FileTextOutlined, 
  CheckCircleOutlined,
  InboxOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  RocketOutlined,
  BookOutlined
} from '@ant-design/icons'
import api from '../services/api.js'

const { Title, Text, Paragraph } = Typography
const { Dragger } = Upload

export default function KnowledgeBase() {
  const [docs, setDocs] = useState([])
  const [stats, setStats] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [loading, setLoading] = useState(true)
  const [uploadStep, setUploadStep] = useState(0)

  const loadDocs = async () => {
    try {
      const [data, statsData] = await Promise.all([
        api.listDocuments(),
        api.getKnowledgeStats(),
      ])
      setDocs(Array.isArray(data) ? data : [])
      setStats(statsData || null)
    } catch {
      setDocs([])
      setStats(null)
    }
    setLoading(false)
  }

  useEffect(() => { loadDocs() }, [])

  const handleUpload = async ({ file }) => {
    setUploading(true)
    setProgress(0)
    setUploadStep(1)
    
    try {
      // 步骤1: 上传中
      setUploadStep(1)
      await new Promise(r => setTimeout(r, 500))
      
      // 步骤2: 解析中
      setUploadStep(2)
      setProgress(30)
      await new Promise(r => setTimeout(r, 500))
      
      // 步骤3: 向量化
      setUploadStep(3)
      setProgress(60)
      
      await api.uploadDocument(file, setProgress)
      
      // 步骤4: 完成
      setUploadStep(4)
      setProgress(100)
      message.success('文档上传并处理完成！')
      await loadDocs()
    } catch (err) {
      message.error('上传失败: ' + (err.response?.data?.detail || err.message))
      setUploadStep(0)
    }
    setUploading(false)
    setProgress(0)
    setTimeout(() => setUploadStep(0), 2000)
  }

  const handleDelete = async (docId) => {
    try {
      await api.deleteDocument(docId)
      message.success('已删除')
      await loadDocs()
    } catch (err) {
      message.error('删除失败')
    }
  }

  const handleWeightFeedback = async (docId, feedbackType) => {
    try {
      await api.feedbackKnowledgeWeight({
        doc_id: docId,
        feedback_type: feedbackType,
        amount: 1,
      })
      message.success(feedbackType === 'helpful' ? '已提升知识权重' : '已记录误导反馈')
      await loadDocs()
    } catch (err) {
      message.error(err.response?.data?.detail || '权重反馈失败')
    }
  }

  // 获取文件图标 - 使用 FileTextOutlined 代替不存在的 FileTxtOutlined
  const getFileIcon = (type) => {
    if (type === 'pdf') return <FilePdfOutlined style={{ color: '#ff4d4f' }} />
    if (type === 'docx' || type === 'doc') return <FileWordOutlined style={{ color: '#1890ff' }} />
    return <FileTextOutlined style={{ color: '#52c41a' }} />
  }

  const columns = [
    {
      title: '文件名', 
      dataIndex: 'filename', 
      key: 'filename',
      render: (name, row) => (
        <Space>
          {getFileIcon(row.file_type)}
          <Text style={{ color: '#1a1a1a' }}>{name}</Text>
        </Space>
      ),
    },
    {
      title: '大小', 
      dataIndex: 'file_size', 
      key: 'file_size',
      render: (s) => s ? <Text type="secondary">{`${(s / 1024 / 1024).toFixed(2)} MB`}</Text> : '-',
    },
    {
      title: '状态', 
      dataIndex: 'status', 
      key: 'status',
      render: (s) => (
        <Tag color={s === 'active' ? 'success' : 'default'}>
          {s === 'active' ? '已处理' : '处理中'}
        </Tag>
      ),
    },
    {
      title: '知识权重',
      dataIndex: 'current_weight',
      key: 'current_weight',
      width: 180,
      render: (_, row) => {
        const percent = Math.round((Number(row.current_weight || 0.5)) * 100)
        const color = percent >= 70 ? '#52c41a' : percent >= 50 ? '#1890ff' : '#faad14'
        return (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Progress percent={percent} size="small" strokeColor={color} showInfo={false} />
            <Space size={6} wrap>
              <Tag color={percent >= 70 ? 'success' : percent >= 50 ? 'processing' : 'warning'}>{percent}%</Tag>
              <Text type="secondary">正向 {Number(row.helpful_weight || 0)}</Text>
              <Text type="secondary">误导 {Number(row.misleading_weight || 0)}</Text>
            </Space>
          </Space>
        )
      },
    },
    {
      title: '分块/反馈',
      key: 'weight_meta',
      width: 140,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Text type="secondary">{row.chunk_count || 0} 个分块</Text>
          <Text type="secondary">{row.feedback_count || 0} 次反馈</Text>
        </Space>
      ),
    },
    {
      title: '上传时间', 
      dataIndex: 'upload_time', 
      key: 'upload_time',
      render: (t) => t ? <Text type="secondary">{new Date(t).toLocaleString('zh-CN')}</Text> : '-',
    },
    {
      title: '操作', 
      key: 'action',
      width: 220,
      render: (_, row) => (
        <Space wrap>
          <Button size="small" onClick={() => handleWeightFeedback(row.doc_id, 'helpful')}>
            有效 +1
          </Button>
          <Button size="small" danger onClick={() => handleWeightFeedback(row.doc_id, 'misleading')}>
            误导 +1
          </Button>
          <Popconfirm 
            title="确认删除此文档？" 
            description="删除后相关知识将从知识库中移除"
            onConfirm={() => handleDelete(row.doc_id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // 上传步骤
  const uploadSteps = [
    { title: '上传文件', icon: <UploadOutlined /> },
    { title: '解析文本', icon: <FileTextOutlined /> },
    { title: '生成向量', icon: <InboxOutlined /> },
    { title: '完成', icon: <CheckCircleOutlined /> },
  ]

  return (
    <div className="page-container">
      {/* 页面标题 */}
      <div style={{ marginBottom: 24 }}>
        <Title level={3} className="page-title">
          <BookOutlined style={{ marginRight: 12, color: '#1890ff' }} />
          知识库管理
        </Title>
        <Text type="secondary" style={{ fontSize: 15 }}>
          上传设备手册、维修记录等文档，构建专属知识库
        </Text>
      </div>

      {/* 使用说明 */}
      <Card className="glass-card" style={{ marginBottom: 24 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text strong style={{ fontSize: 15, color: '#1a1a1a', display: 'block', marginBottom: 8 }}>
              <RocketOutlined style={{ marginRight: 8 }} />
              为什么要上传文档？
            </Text>
            <Text type="secondary" style={{ fontSize: 13, lineHeight: 1.8 }}>
              上传设备手册、维修记录等文档后，系统会：
            </Text>
            <ul style={{ margin: '8px 0 0 20px', color: '#595959', fontSize: 13, lineHeight: 1.8 }}>
              <li>自动解析文档中的故障信息</li>
              <li>将知识向量化存储到知识库</li>
              <li>生成故障树时自动检索相关知识</li>
              <li>提高故障树生成的准确性</li>
              <li>根据排障反馈持续调整知识权重</li>
            </ul>
          </div>
        </Space>
      </Card>

      <Card className="glass-card" style={{ marginBottom: 24 }}>
        <Space size={24} wrap>
          <div>
            <Text type="secondary">文档总数</Text>
            <div>
              <Text strong style={{ fontSize: 24 }}>{stats?.total_docs || 0}</Text>
            </div>
          </div>
          <div>
            <Text type="secondary">分块总数</Text>
            <div>
              <Text strong style={{ fontSize: 24 }}>{stats?.total_chunks || 0}</Text>
            </div>
          </div>
          <div>
            <Text type="secondary">平均知识权重</Text>
            <div>
              <Text strong style={{ fontSize: 24 }}>{Math.round(((stats?.avg_doc_weight ?? 0.5) * 100))}%</Text>
            </div>
          </div>
          <div>
            <Text type="secondary">累计反馈</Text>
            <div>
              <Text strong style={{ fontSize: 24 }}>{stats?.feedback_count || 0}</Text>
            </div>
          </div>
        </Space>
      </Card>

      {/* 上传区域 */}
      <Card className="glass-card" style={{ marginBottom: 24 }}>
        {/* 上传进度步骤条 */}
        {uploading && (
          <div style={{ marginBottom: 24 }}>
            <Steps 
              current={uploadStep} 
              size="small" 
              status="process"
              items={uploadSteps}
            />
          </div>
        )}

        {/* 上传进度条 */}
        {uploading && (
          <div style={{ marginBottom: 24 }}>
            <div className="flex-between" style={{ marginBottom: 8 }}>
              <Text>正在处理文档...</Text>
              <Text>{progress}%</Text>
            </div>
            <Progress percent={progress} status="active" strokeColor="#1890ff" />
          </div>
        )}

        {/* 上传组件 */}
        <Dragger
          accept=".pdf,.docx,.doc,.txt"
          showUploadList={false}
          beforeUpload={() => false}
          onChange={handleUpload}
          disabled={uploading}
          className="upload-dragger"
          style={{ 
            background: 'rgba(24,144,255,0.05)', 
            border: uploading ? '1px solid #1890ff' : '2px dashed rgba(24,144,255,0.3)',
            borderRadius: 12,
            padding: '24px 0'
          }}
        >
          <div style={{ padding: '16px 0' }}>
            <p style={{ fontSize: 48, marginBottom: 16, color: '#1890ff' }}>
              <InboxOutlined />
            </p>
            <p style={{ fontSize: 16, color: '#1a1a1a', marginBottom: 8 }}>
              点击或拖拽文件到此处上传
            </p>
            <p style={{ color: '#8c8c8c', fontSize: 13 }}>
              支持 PDF、Word (.docx/.doc)、TXT 格式
            </p>
            <p style={{ color: '#8c8c8c', fontSize: 12, marginTop: 16 }}>
              文件大小限制：50MB以内
            </p>
          </div>
        </Dragger>
      </Card>

      {/* 文档列表 */}
      <Card className="glass-card">
        <div className="flex-between" style={{ marginBottom: 16 }}>
          <Text strong style={{ fontSize: 15 }}>已上传文档 ({docs.length})</Text>
          <Button icon={<CheckCircleOutlined />} onClick={loadDocs} className="btn-secondary">
            刷新列表
          </Button>
        </div>

        <Table
          rowKey="doc_id"
          columns={columns}
          dataSource={docs}
          loading={loading}
          locale={{ 
            emptyText: (
              <div style={{ textAlign: 'center', padding: '48px 0' }}>
                <FileTextOutlined style={{ fontSize: 48, color: '#8c8c8c', marginBottom: 16 }} />
                <div>
                  <Text type="secondary">还没有上传文档</Text>
                </div>
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    上方上传设备手册后，即可开始生成故障树
                  </Text>
                </div>
              </div>
            ) 
          }}
          pagination={{ 
            pageSize: 10,
            showTotal: (total) => `共 ${total} 个文档`
          }}
        />
      </Card>
    </div>
  )
}
