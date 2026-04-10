import React, { useState, useEffect } from 'react'
import {
  Card, Upload, Table, Button, Space, Tag, Typography, message, Progress, Empty, Popconfirm, Steps, Alert, Select, AutoComplete
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
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [loading, setLoading] = useState(true)
  const [uploadStep, setUploadStep] = useState(0)
  const [uploadPipeline, setUploadPipeline] = useState('流水线1')
  const [pipelines, setPipelines] = useState(['流水线1'])

  const loadDocs = async () => {
    try {
      const data = await api.listDocuments()
      setDocs(Array.isArray(data) ? data : [])
    } catch {
      setDocs([])
    }
    setLoading(false)
  }

  const loadPipelines = async () => {
    try {
      const vals = await api.listPipelines()
      const uniq = Array.from(new Set(['流水线1', ...vals.filter(Boolean)]))
      setPipelines(uniq)
    } catch {
      setPipelines(['流水线1'])
    }
  }

  useEffect(() => {
    loadDocs()
    loadPipelines()
  }, [])

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
      
      const p = (uploadPipeline || '').trim() || '流水线1'
      await api.uploadDocument(file, setProgress, p)
      
      // 步骤4: 完成
      setUploadStep(4)
      setProgress(100)
      message.success('文档上传并处理完成！')
      await loadDocs()
      await loadPipelines()
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

  const handlePipelineChange = async (docId, pipeline) => {
    try {
      await api.updateDocumentPipeline(docId, pipeline)
      message.success('流水线分组已更新')
      await loadDocs()
      await loadPipelines()
    } catch (err) {
      message.error('更新失败: ' + (err.response?.data?.detail || err.message))
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
      title: '流水线',
      dataIndex: 'pipeline',
      key: 'pipeline',
      render: (p, row) => (
        <Select
          size="small"
          style={{ width: 120 }}
          value={p || '流水线1'}
          onChange={(v) => handlePipelineChange(row.doc_id, v)}
          options={pipelines.map(v => ({ value: v, label: v }))}
        />
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
      width: 100,
      render: (_, row) => (
        <Popconfirm 
          title="确认删除此文档？" 
          description="删除后相关知识将从知识库中移除"
          onConfirm={() => handleDelete(row.doc_id)}
        >
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
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
            </ul>
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

        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong>上传到流水线：</Text>
          <AutoComplete
            style={{ width: 160 }}
            value={uploadPipeline}
            onChange={setUploadPipeline}
            options={pipelines.map(v => ({ value: v }))}
            filterOption={(inputValue, option) => (option?.value || '').toLowerCase().includes(inputValue.toLowerCase())}
            disabled={uploading}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>已上传旧文档自动归为流水线1</Text>
        </div>

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
