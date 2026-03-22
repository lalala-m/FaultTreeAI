import React, { useState, useEffect } from 'react'
import {
  Card, Upload, Table, Button, Space, Tag, Typography, message, Progress, Empty, Popconfirm
} from 'antd'
import { UploadOutlined, DeleteOutlined, FileTextOutlined, CheckCircleOutlined } from '@ant-design/icons'
import api from '../services/api.js'

const { Title } = Typography

export default function KnowledgeBase() {
  const [docs, setDocs] = useState([])
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [loading, setLoading] = useState(true)

  const loadDocs = async () => {
    try {
      const data = await api.get('/knowledge/documents')
      setDocs(Array.isArray(data) ? data : [])
    } catch {
      setDocs([])
    }
    setLoading(false)
  }

  useEffect(() => { loadDocs() }, [])

  const handleUpload = async ({ file }) => {
    setUploading(true)
    setProgress(0)
    try {
      await api.uploadDocument(file, setProgress)
      message.success('文档上传并处理完成！')
      await loadDocs()
    } catch (err) {
      message.error('上传失败: ' + (err.response?.data?.detail || err.message))
    }
    setUploading(false)
    setProgress(0)
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

  const columns = [
    {
      title: '文件名', dataIndex: 'filename', key: 'filename',
      render: (name, row) => (
        <Space>
          <FileTextOutlined />
          {name}
          <Tag color="blue">{row.file_type?.toUpperCase()}</Tag>
        </Space>
      ),
    },
    {
      title: '大小', dataIndex: 'file_size', key: 'file_size',
      render: (s) => s ? `${(s / 1024 / 1024).toFixed(2)} MB` : '-',
    },
    {
      title: '状态', dataIndex: 'status', key: 'status',
      render: (s) => <Tag color={s === 'active' ? 'green' : 'default'}>{s}</Tag>,
    },
    {
      title: '上传时间', dataIndex: 'upload_time', key: 'upload_time',
      render: (t) => t ? new Date(t).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作', key: 'action',
      render: (_, row) => (
        <Popconfirm title="确认删除？" onConfirm={() => handleDelete(row.doc_id)}>
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>知识库管理</Title>
        <Button icon={<CheckCircleOutlined />} onClick={loadDocs}>刷新</Button>
      </div>

      <Card
        style={{ marginBottom: 16 }}
        cover={
          uploading ? (
            <div style={{ padding: '32px 24px' }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <div>正在解析文档并生成向量...</div>
                <Progress percent={progress} status="active" />
              </Space>
            </div>
          ) : undefined
        }
      >
        <Upload.Dragger
          accept=".pdf,.docx,.doc,.txt"
          showUploadList={false}
          beforeUpload={() => false}
          onChange={handleUpload}
          disabled={uploading}
          style={{ marginBottom: 16 }}
        >
          <p style={{ fontSize: 40, marginBottom: 8 }}>
            <UploadOutlined />
          </p>
          <p style={{ fontSize: 16 }}>点击或拖拽上传设备手册（PDF / Word / TXT）</p>
          <p style={{ color: '#999', fontSize: 13 }}>支持多文件，系统将自动解析文本并生成向量嵌入</p>
        </Upload.Dragger>
      </Card>

      <Card>
        <Table
          rowKey="doc_id"
          columns={columns}
          dataSource={docs}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无文档，请先上传设备手册" /> }}
          pagination={{ pageSize: 10 }}
        />
      </Card>
    </div>
  )
}
