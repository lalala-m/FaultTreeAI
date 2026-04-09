import React, { useState, useEffect } from 'react'
import {
  Card, Upload, Table, Button, Space, Tag, Typography, message, Progress, Empty, Popconfirm, Steps, Alert, Input, Modal, Form, Select
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
  const [weightSubmitting, setWeightSubmitting] = useState({})
  const [uploadPipeline, setUploadPipeline] = useState('流水线1')
  const [pipelines, setPipelines] = useState(['流水线1'])

  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsPipeline, setItemsPipeline] = useState('流水线1')
  const [itemModalOpen, setItemModalOpen] = useState(false)
  const [itemSubmitting, setItemSubmitting] = useState(false)
  const [itemWeightSubmitting, setItemWeightSubmitting] = useState({})
  const [itemForm] = Form.useForm()

  const loadDocs = async () => {
    try {
      const data = await api.listDocuments()
      setDocs(Array.isArray(data) ? data : [])
    } catch {
      setDocs([])
    }
    setLoading(false)
  }

  useEffect(() => { loadDocs() }, [])
  useEffect(() => {
    const load = async () => {
      try {
        const list = await api.listPipelines()
        const p = Array.from(new Set(['流水线1', ...(list || []).filter(Boolean)]))
        setPipelines(p)
        if (!p.includes(uploadPipeline)) setUploadPipeline(p[0] || '流水线1')
        if (!p.includes(itemsPipeline)) setItemsPipeline(p[0] || '流水线1')
      } catch {
        setPipelines(['流水线1'])
      }
    }
    load()
  }, [])

  const loadItems = async (pipelineValue = itemsPipeline) => {
    setItemsLoading(true)
    try {
      const data = await api.listKnowledgeItems({ pipeline: pipelineValue, status: 'active', limit: 100 })
      setItems(Array.isArray(data) ? data : [])
    } catch (e) {
      setItems([])
      message.error(e.response?.data?.detail || e.message || '加载结构化知识失败')
    }
    setItemsLoading(false)
  }

  useEffect(() => { loadItems(itemsPipeline) }, [itemsPipeline])

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
      
      await api.uploadDocument(file, setProgress, uploadPipeline)
      
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

  const handleFeedbackWeight = async (docId, feedbackType) => {
    const key = `${docId}:${feedbackType}`
    setWeightSubmitting(prev => ({ ...prev, [key]: true }))
    try {
      await api.feedbackKnowledgeWeight({
        doc_id: docId,
        feedback_type: feedbackType,
        amount: 1,
      })
      message.success('已反馈')
      await loadDocs()
    } catch (err) {
      message.error(err.response?.data?.detail || '反馈失败')
    }
    setWeightSubmitting(prev => ({ ...prev, [key]: false }))
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
      render: (v, row) => {
        const weight = Number(v)
        const pct = Math.round((Number.isFinite(weight) ? weight : 0.5) * 100)
        return (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Progress percent={pct} size="small" showInfo={false} />
            <Space size={6} wrap>
              <Tag color={pct >= 70 ? 'green' : pct >= 50 ? 'blue' : 'orange'}>{pct}%</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                反馈 {Number(row.feedback_count || 0)}
              </Text>
            </Space>
          </Space>
        )
      },
    },
    {
      title: '有效/误导',
      key: 'weight_counts',
      width: 140,
      render: (_, row) => (
        <Space size={8}>
          <Tag color="green">{Number(row.helpful_weight || 0)}</Tag>
          <Tag color="red">{Number(row.misleading_weight || 0)}</Tag>
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
        <Space size={8}>
          <Button
            size="small"
            onClick={() => handleFeedbackWeight(row.doc_id, 'helpful')}
            loading={!!weightSubmitting[`${row.doc_id}:helpful`]}
          >
            有效 +1
          </Button>
          <Button
            size="small"
            danger
            onClick={() => handleFeedbackWeight(row.doc_id, 'misleading')}
            loading={!!weightSubmitting[`${row.doc_id}:misleading`]}
          >
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

  const itemColumns = [
    { title: '机械类别', dataIndex: 'machine_category', key: 'machine_category', width: 120, render: (v) => <Text>{v || '-'}</Text> },
    { title: '机械', dataIndex: 'machine', key: 'machine', width: 140, render: (v) => <Text>{v || '-'}</Text> },
    { title: '问题类别', dataIndex: 'problem_category', key: 'problem_category', width: 120, render: (v) => <Text>{v || '-'}</Text> },
    { title: '问题', dataIndex: 'problem', key: 'problem', render: (v) => <Text style={{ color: '#1a1a1a' }}>{v}</Text> },
    { title: '导致原因', dataIndex: 'root_cause', key: 'root_cause', render: (v) => <Text type="secondary">{v || '-'}</Text> },
    { title: '解决方法', dataIndex: 'solution', key: 'solution', render: (v) => <Text type="secondary">{v || '-'}</Text> },
    {
      title: '权重',
      dataIndex: 'current_weight',
      key: 'current_weight',
      width: 120,
      render: (v) => {
        const weight = Number(v)
        const pct = Math.round((Number.isFinite(weight) ? weight : 0.5) * 100)
        return <Tag color={pct >= 70 ? 'green' : pct >= 50 ? 'blue' : 'orange'}>{pct}%</Tag>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, row) => (
        <Space size={8}>
          <Button
            size="small"
            onClick={async () => {
              const key = `${row.item_id}:helpful`
              setItemWeightSubmitting(prev => ({ ...prev, [key]: true }))
              try {
                await api.feedbackKnowledgeItemWeight({ item_id: row.item_id, feedback_type: 'helpful', amount: 1 })
                await loadItems()
                message.success('已反馈')
              } catch (e) {
                message.error(e.response?.data?.detail || e.message || '反馈失败')
              }
              setItemWeightSubmitting(prev => ({ ...prev, [key]: false }))
            }}
            loading={!!itemWeightSubmitting[`${row.item_id}:helpful`]}
          >
            有效 +1
          </Button>
          <Button
            size="small"
            danger
            onClick={async () => {
              const key = `${row.item_id}:misleading`
              setItemWeightSubmitting(prev => ({ ...prev, [key]: true }))
              try {
                await api.feedbackKnowledgeItemWeight({ item_id: row.item_id, feedback_type: 'misleading', amount: 1 })
                await loadItems()
                message.success('已反馈')
              } catch (e) {
                message.error(e.response?.data?.detail || e.message || '反馈失败')
              }
              setItemWeightSubmitting(prev => ({ ...prev, [key]: false }))
            }}
            loading={!!itemWeightSubmitting[`${row.item_id}:misleading`]}
          >
            误导 +1
          </Button>
          <Popconfirm
            title="确认删除此条结构化知识？"
            onConfirm={async () => {
              try {
                await api.deleteKnowledgeItem(row.item_id)
                await loadItems()
                message.success('已删除')
              } catch (e) {
                message.error(e.response?.data?.detail || e.message || '删除失败')
              }
            }}
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
            </ul>
          </div>
        </Space>
      </Card>

      {/* 上传区域 */}
      <Card className="glass-card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <Text strong>流水线</Text>
          <Select
            style={{ width: 220 }}
            value={uploadPipeline}
            onChange={setUploadPipeline}
            options={pipelines.map(p => ({ value: p, label: p }))}
          />
          <Input
            style={{ width: 260 }}
            value={uploadPipeline}
            onChange={(e) => setUploadPipeline(e.target.value)}
            placeholder="可输入新流水线名称"
          />
        </div>
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

      <Card className="glass-card" style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Space>
            <Text strong style={{ fontSize: 15, color: '#1a1a1a' }}>结构化知识（流水线→机械类别→机械→问题类别→问题→原因）</Text>
            <Select
              style={{ width: 220 }}
              value={itemsPipeline}
              onChange={setItemsPipeline}
              options={pipelines.map(p => ({ value: p, label: p }))}
            />
          </Space>
          <Space>
            <Button onClick={() => loadItems(itemsPipeline)} loading={itemsLoading}>刷新</Button>
            <Button type="primary" onClick={() => {
              itemForm.resetFields()
              itemForm.setFieldsValue({ pipeline: itemsPipeline })
              setItemModalOpen(true)
            }}>新增结构化知识</Button>
          </Space>
        </div>

        <Table
          columns={itemColumns}
          dataSource={items}
          rowKey="item_id"
          loading={itemsLoading}
          pagination={{ pageSize: 8 }}
          locale={{ emptyText: <Empty description="暂无结构化知识，请新增" /> }}
        />
      </Card>

      <Modal
        open={itemModalOpen}
        title="新增结构化知识"
        onCancel={() => setItemModalOpen(false)}
        okText="保存"
        confirmLoading={itemSubmitting}
        onOk={async () => {
          try {
            const values = await itemForm.validateFields()
            setItemSubmitting(true)
            await api.createKnowledgeItem(values)
            setItemModalOpen(false)
            await loadItems(values.pipeline || itemsPipeline)
            message.success('已新增')
          } catch (e) {
            if (e?.errorFields) return
            message.error(e.response?.data?.detail || e.message || '保存失败')
          }
          setItemSubmitting(false)
        }}
      >
        <Form
          form={itemForm}
          layout="vertical"
          initialValues={{ pipeline: itemsPipeline }}
        >
          <Form.Item name="pipeline" label="流水线" rules={[{ required: true, message: '请输入流水线' }]}>
            <Input placeholder="例如：流水线1" />
          </Form.Item>
          <Form.Item name="machine_category" label="机械类别">
            <Input placeholder="例如：变频器" />
          </Form.Item>
          <Form.Item name="machine" label="机械">
            <Input placeholder="例如：1FT7 电机" />
          </Form.Item>
          <Form.Item name="problem_category" label="问题类别">
            <Input placeholder="例如：运行异常" />
          </Form.Item>
          <Form.Item name="problem" label="问题" rules={[{ required: true, message: '请输入问题' }]}>
            <Input.TextArea placeholder="例如：设备运行时出现电弧" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item name="root_cause" label="导致原因">
            <Input.TextArea placeholder="例如：运行时断开插接导致电弧" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item name="solution" label="解决方法">
            <Input.TextArea placeholder="例如：只能在断电时断开连接" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
