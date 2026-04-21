import React, { useState, useEffect, useRef } from 'react'
import {
  Card, Upload, Table, Button, Space, Tag, Typography, message, Progress, Empty, Popconfirm, Steps, Alert, Select, Input, Modal, Form, Slider, Switch, Tooltip
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
  BookOutlined,
  PlusOutlined
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
  const [uploadAutoExtract, setUploadAutoExtract] = useState(true)
  const [pipelines, setPipelines] = useState([])
  const [newPipelineName, setNewPipelineName] = useState('')
  const [creatingPipeline, setCreatingPipeline] = useState(false)

  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsPipeline, setItemsPipeline] = useState('流水线1')
  const [itemModalOpen, setItemModalOpen] = useState(false)
  const [itemSubmitting, setItemSubmitting] = useState(false)
  const [itemWeightSubmitting, setItemWeightSubmitting] = useState({})
  const [expertWeightModalOpen, setExpertWeightModalOpen] = useState(false)
  const [expertWeightItem, setExpertWeightItem] = useState(null)
  const [expertWeightValue, setExpertWeightValue] = useState(null)
  const [expertWeightSubmitting, setExpertWeightSubmitting] = useState(false)
  const [reextractSubmitting, setReextractSubmitting] = useState(false)
  const [itemForm] = Form.useForm()
  const pollRef = useRef({ token: 0, timer: null })

  const loadDocs = async (force = false) => {
    try {
      if (force) api.invalidateCache?.(['documents'])
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
      const uniq = Array.from(new Set(vals.filter(Boolean)))
      if (uniq.length === 0) uniq.push('流水线1')
      setPipelines(uniq)
      if (!uniq.includes(itemsPipeline)) setItemsPipeline(uniq[0])
      if (!uniq.includes(uploadPipeline)) setUploadPipeline(uniq[0])
    } catch {
      setPipelines(['流水线1'])
    }
  }

  const loadItems = async (pipelineValue = itemsPipeline) => {
    setItemsLoading(true)
    try {
      const data = await api.listKnowledgeItems({ pipeline: pipelineValue, status: 'active', limit: 200 })
      setItems(Array.isArray(data) ? data : [])
    } catch (e) {
      setItems([])
      message.error(e.response?.data?.detail || e.message || '加载结构化知识失败')
    }
    setItemsLoading(false)
  }

  useEffect(() => {
    loadDocs()
    loadPipelines()
    return () => {
      try {
        if (pollRef.current?.timer) clearTimeout(pollRef.current.timer)
      } catch {
      }
      pollRef.current = { token: 0, timer: null }
    }
  }, [])

  useEffect(() => {
    loadItems(itemsPipeline)
  }, [itemsPipeline])

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
      const uploaded = await api.uploadDocument(file, setProgress, p, uploadAutoExtract)
      
      // 步骤4: 完成
      setUploadStep(4)
      setProgress(100)
      message.success(uploadAutoExtract ? '文档上传完成，已触发结构化抽取（后台进行）' : '文档上传并处理完成！')
      await loadDocs()
      await loadPipelines()

      if (uploadAutoExtract && uploaded?.doc_id) {
        try {
          if (pollRef.current?.timer) clearTimeout(pollRef.current.timer)
        } catch {
        }
        const token = Date.now()
        pollRef.current = { token, timer: null }

        const tick = async (attempt = 0) => {
          if (pollRef.current?.token !== token) return
          let list = null
          try {
            api.invalidateCache?.(['documents'])
            list = await api.listDocuments()
          } catch {
          }
          const arr = Array.isArray(list) ? list : null
          if (arr) {
            setDocs(arr)
            const doc = arr.find((d) => String(d?.doc_id || '') === String(uploaded.doc_id || ''))
            const structured = String(doc?.structured_kb || '')
            if (structured && structured !== 'pending') {
              if (String(doc?.pipeline || p) === String(itemsPipeline)) {
                await loadItems(String(doc?.pipeline || p))
              }
              return
            }
          }
          if (attempt >= 240) return
          pollRef.current.timer = setTimeout(() => tick(attempt + 1), 1500)
        }

        tick(0)
      }
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

  const handleCreatePipeline = async () => {
    const p = String(newPipelineName || '').trim()
    if (!p) {
      message.warning('请输入流水线名称')
      return
    }
    try {
      setCreatingPipeline(true)
      const ret = await api.createPipeline(p)
      await loadPipelines()
      const created = ret?.pipeline || p
      setUploadPipeline(created)
      setItemsPipeline(created)
      setNewPipelineName('')
      message.success(`已创建流水线：${created}`)
    } catch (e) {
      message.error(e.response?.data?.detail || e.message || '创建流水线失败')
    }
    setCreatingPipeline(false)
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
      render: (p) => (
        <Tag color="blue">{p || '流水线1'}</Tag>
      ),
    },
    {
      title: '结构化',
      dataIndex: 'structured_kb',
      key: 'structured_kb',
      width: 140,
      render: (s, row) => {
        const v = String(s || '')
        if (!v) return <Text type="secondary">-</Text>
        const tip = String(row?.structured_error || '')
        const withTip = (node) => (tip ? <Tooltip title={tip}>{node}</Tooltip> : node)
        if (v === 'ok') return withTip(<Tag color="green">已抽取</Tag>)
        if (v === 'pending') return <Tag color="blue">抽取中</Tag>
        if (v === 'empty') return withTip(<Tag color="orange">未抽取</Tag>)
        if (v === 'failed') return withTip(<Tag color="red">失败</Tag>)
        return withTip(<Tag>{v}</Tag>)
      },
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

  const itemColumns = [
    { title: '机械类别', dataIndex: 'machine_category', key: 'machine_category', width: 120, render: (v) => <Text>{v || '-'}</Text> },
    { title: '机械', dataIndex: 'machine', key: 'machine', width: 140, render: (v) => <Text>{v || '-'}</Text> },
    { title: '问题类别', dataIndex: 'problem_category', key: 'problem_category', width: 120, render: (v) => <Text>{v || '-'}</Text> },
    {
      title: '问题',
      dataIndex: 'problem',
      key: 'problem',
      width: 320,
      render: (v) => (
        <div style={{ minWidth: 240, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.6, color: '#1a1a1a' }}>
          {v || '-'}
        </div>
      ),
    },
    {
      title: '导致原因',
      dataIndex: 'root_cause',
      key: 'root_cause',
      width: 180,
      render: (v) => (
        <div style={{ minWidth: 140, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.6, color: '#8c8c8c' }}>
          {v || '-'}
        </div>
      ),
    },
    {
      title: '权重',
      dataIndex: 'effective_weight',
      key: 'effective_weight',
      width: 120,
      render: (v, row) => {
        const weight = Number(v)
        const fallback = Number(row?.current_weight ?? 0.5)
        const pct = Math.round((Number.isFinite(weight) ? weight : (Number.isFinite(fallback) ? fallback : 0.5)) * 100)
        const tag = <Tag color={pct >= 70 ? 'green' : pct >= 50 ? 'blue' : 'orange'}>{pct}%</Tag>
        return row?.expert_weight != null ? <Space size={6}>{tag}<Tag>专家</Tag></Space> : tag
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 240,
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
          <Button
            size="small"
            onClick={() => {
              setExpertWeightItem(row)
              const w = row?.expert_weight != null ? Number(row.expert_weight) : (row?.effective_weight != null ? Number(row.effective_weight) : 0.5)
              setExpertWeightValue(Number.isFinite(w) ? Math.round(w * 100) : 50)
              setExpertWeightModalOpen(true)
            }}
          >
            专家权重
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
      <Card className="glass-card kb-upload-card" style={{ marginBottom: 24 }}>
        {/* 上传进度步骤条 */}
        {uploading && (
          <div style={{ marginBottom: 24 }}>
            <Steps 
              className="kb-upload-steps"
              current={uploadStep} 
              size="small" 
              status="process"
              direction="horizontal"
              responsive={false}
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
          <Select
            style={{ width: 160 }}
            value={uploadPipeline}
            onChange={setUploadPipeline}
            options={pipelines.map(v => ({ value: v, label: v }))}
            disabled={uploading}
            showSearch
            optionFilterProp="label"
          />
          <Space size={8}>
            <Text type="secondary">上传后自动抽取结构化知识</Text>
            <Switch checked={uploadAutoExtract} onChange={setUploadAutoExtract} disabled={uploading} />
          </Space>
          <Input
            style={{ width: 180 }}
            placeholder="新流水线名称"
            value={newPipelineName}
            onChange={(e) => setNewPipelineName(e.target.value)}
            disabled={uploading || creatingPipeline}
            onPressEnter={handleCreatePipeline}
          />
          <Button
            icon={<PlusOutlined />}
            onClick={handleCreatePipeline}
            loading={creatingPipeline}
            disabled={uploading}
          >
            新建流水线
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>已上传旧文档自动归为流水线1</Text>
        </div>

        {/* 上传组件 */}
        <Dragger
          accept=".pdf,.docx,.doc,.txt"
          showUploadList={false}
          beforeUpload={() => false}
          onChange={handleUpload}
          disabled={uploading}
          className={`upload-dragger kb-upload-dragger ${uploading ? 'is-uploading' : ''}`}
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
            <Button
              loading={reextractSubmitting}
              disabled={itemsLoading || reextractSubmitting}
              onClick={() => {
                Modal.confirm({
                  title: '整理信息（自动补全空白字段）？',
                  content: '会对当前流水线下结构化知识条目中缺失的信息（如机械类别/问题类别/原因/解决方案等）调用 AI 自动补全，不会删除条目。',
                  okText: '开始补全',
                  cancelText: '取消',
                  onOk: async () => {
                    try {
                      setReextractSubmitting(true)
                      const res = await api.autofillKnowledgeItems(itemsPipeline, { limit: 120, dry_run: false })
                      message.success(`已补全：扫描${res?.scanned ?? 0}条，更新${res?.updated ?? 0}条`)
                      await loadItems(itemsPipeline)
                    } catch (e) {
                      message.error(e.response?.data?.detail || e.message || '整理失败')
                    }
                    setReextractSubmitting(false)
                  }
                })
              }}
            >
              整理信息
            </Button>
            <Button
              disabled={itemsLoading || reextractSubmitting}
              onClick={() => {
                Modal.confirm({
                  title: '清理无用条目并补齐机械类别？',
                  content: '会删除“操作说明/目录/参数表”等非故障条目，并对保留条目补齐机械类别与问题类别（仅保留有导致原因的条目）。',
                  okText: '开始清理',
                  cancelText: '取消',
                  onOk: async () => {
                    try {
                      setReextractSubmitting(true)
                      const res = await api.cleanupKnowledgeItems(itemsPipeline, { delete_unknown_cause: true, delete_noise: true, dry_run: false })
                      message.success(`已清理：删除${res?.deleted ?? 0}条，更新${res?.updated ?? 0}条`)
                      await loadItems(itemsPipeline)
                    } catch (e) {
                      message.error(e.response?.data?.detail || e.message || '清理失败')
                    }
                    setReextractSubmitting(false)
                  }
                })
              }}
            >
              清理无用
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                itemForm.resetFields()
                itemForm.setFieldsValue({ pipeline: itemsPipeline })
                setItemModalOpen(true)
              }}
            >
              新增结构化知识
            </Button>
          </Space>
        </div>

        <Table
          columns={itemColumns}
          dataSource={items}
          rowKey="item_id"
          loading={itemsLoading}
          scroll={{ x: 1280 }}
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
        <Form form={itemForm} layout="vertical" initialValues={{ pipeline: itemsPipeline }}>
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
            <Input.TextArea placeholder="例如：电机有异响" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item name="root_cause" label="导致原因">
            <Input.TextArea placeholder="例如：转子不平衡" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Form.Item name="solution" label="解决方法">
            <Input.TextArea placeholder="例如：重新做动平衡校正" autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={expertWeightModalOpen}
        title="调整专家权重"
        onCancel={() => setExpertWeightModalOpen(false)}
        okText="保存"
        confirmLoading={expertWeightSubmitting}
        onOk={async () => {
          if (!expertWeightItem?.item_id) return
          setExpertWeightSubmitting(true)
          try {
            const v = expertWeightValue
            await api.setKnowledgeItemExpertWeight(expertWeightItem.item_id, v == null ? null : Number(v) / 100)
            await loadItems()
            message.success('已更新专家权重')
            setExpertWeightModalOpen(false)
          } catch (e) {
            message.error(e.response?.data?.detail || e.message || '更新失败')
          }
          setExpertWeightSubmitting(false)
        }}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>问题</Text>
            <Text type="secondary">{expertWeightItem?.problem || '-'}</Text>
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>专家权重</Text>
            <Space style={{ width: '100%' }}>
              <Slider
                style={{ flex: 1 }}
                value={expertWeightValue}
                onChange={setExpertWeightValue}
                min={0}
                max={100}
                step={1}
                marks={{ 0: '0%', 50: '50%', 100: '100%' }}
              />
              <Tag color="geekblue" style={{ minWidth: 48, textAlign: 'center' }}>{expertWeightValue ?? 0}%</Tag>
            </Space>
            <div style={{ marginTop: 10 }}>
              <Button
                size="small"
                danger
                onClick={async () => {
                  if (!expertWeightItem?.item_id) return
                  setExpertWeightSubmitting(true)
                  try {
                    await api.setKnowledgeItemExpertWeight(expertWeightItem.item_id, null)
                    await loadItems()
                    message.success('已清除专家权重')
                    setExpertWeightModalOpen(false)
                  } catch (e) {
                    message.error(e.response?.data?.detail || e.message || '清除失败')
                  }
                  setExpertWeightSubmitting(false)
                }}
              >
                清除专家权重（回到反馈权重）
              </Button>
            </div>
          </div>
        </Space>
      </Modal>
    </div>
  )
}
