import React, { useState, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  Card, Upload, Table, Button, Space, Tag, Typography, message, Progress, Empty, Popconfirm, Alert, Select, Input, Modal, Form, Slider, Tooltip
} from 'antd'
import { 
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
import { uploadStore } from '../services/uploadStore.js'
import { uploadDocument } from '../services/api.js'

const { Title, Text, Paragraph } = Typography
const { Dragger } = Upload

// 可展开单元格：超过指定行数显示“展开”
const ExpandableCell = ({ text, color, rows = 2 }) => {
  const content = text || '-'
  return (
    <div style={{ color, lineHeight: 1.6 }}>
      <Paragraph ellipsis={{ rows, expandable: true, symbol: '展开' }} style={{ margin: 0 }}>
        {content}
      </Paragraph>
    </div>
  )
}

export default function KnowledgeBase() {
  const [docs, setDocs] = useState([])
  const uploadTasks = useSyncExternalStore(
    (callback) => uploadStore.subscribe(callback),
    () => uploadStore.getSnapshot(),
    () => uploadStore.getSnapshot()
  )
  const [loading, setLoading] = useState(true)
  const [uploadPipeline, setUploadPipeline] = useState(() => {
    try {
      return String(window?.localStorage?.getItem('kb_upload_pipeline') || '流水线1') || '流水线1'
    } catch {
      return '流水线1'
    }
  })
  const [pipelines, setPipelines] = useState([])
  const [newPipelineName, setNewPipelineName] = useState('')
  const [creatingPipeline, setCreatingPipeline] = useState(false)

  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsPipeline, setItemsPipeline] = useState(() => {
    try {
      return String(window?.localStorage?.getItem('kb_items_pipeline') || '流水线1') || '流水线1'
    } catch {
      return '流水线1'
    }
  })
  const [itemModalOpen, setItemModalOpen] = useState(false)
  const [itemSubmitting, setItemSubmitting] = useState(false)
  const [itemWeightSubmitting, setItemWeightSubmitting] = useState({})
  const [expertWeightModalOpen, setExpertWeightModalOpen] = useState(false)
  const [expertWeightItem, setExpertWeightItem] = useState(null)
  const [expertWeightValue, setExpertWeightValue] = useState(null)
  const [expertWeightSubmitting, setExpertWeightSubmitting] = useState(false)
  const [itemQuery, setItemQuery] = useState('')
  const [itemTypeFilter, setItemTypeFilter] = useState('all')
  const [docSummaryOpen, setDocSummaryOpen] = useState(false)
  const [docSummaryLoading, setDocSummaryLoading] = useState(false)
  const [docSummaryTitle, setDocSummaryTitle] = useState('')
  const [docSummaryText, setDocSummaryText] = useState('')
  const [itemForm] = Form.useForm()

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
    // 强制刷新，避免看到旧缓存（特别是从别的页面切回来时）
    loadDocs(true)
    loadPipelines()
  }, [])

  useEffect(() => {
    // 有上传任务完成时，刷新文档列表、流水线、结构化知识条目
    if (uploadTasks.some((t) => t.status === 'completed')) {
      loadDocs(true)
      loadPipelines()
      loadItems(itemsPipeline)
    }
  }, [uploadTasks])

  useEffect(() => {
    loadItems(itemsPipeline)
  }, [itemsPipeline])

  useEffect(() => {
    try {
      window?.localStorage?.setItem('kb_items_pipeline', String(itemsPipeline || '流水线1'))
    } catch {
    }
  }, [itemsPipeline])

  useEffect(() => {
    try {
      window?.localStorage?.setItem('kb_upload_pipeline', String(uploadPipeline || '流水线1'))
    } catch {
    }
  }, [uploadPipeline])

  const hasActiveUpload = uploadTasks.some((t) => t.status === 'pending' || t.status === 'uploading' || t.status === 'processing')

  const handleUpload = async ({ file, onSuccess, onError, onProgress }) => {
    const p = (uploadPipeline || '').trim() || '流水线1'
    const task = uploadStore.addTask(file, p, true)
    // 启动实际上传，进度由 store 内部维护；store 会在完成后自动刷新文档列表
    uploadStore.startUpload(task.id, (f, _, pipeline, autoExtract) =>
      uploadDocument(f, onProgress, pipeline, autoExtract)
    )
      .then(() => onSuccess?.())
      .catch((err) => onError?.(err))
  }

  const handleClearCompleted = () => {
    uploadStore.clearCompleted()
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

  const getKnowledgeTypeLabel = (type) => {
    const t = String(type || 'fault')
    if (t === 'maintenance') return { text: '维修类', color: 'orange' }
    if (t === 'fault') return { text: '故障类', color: 'blue' }
    return { text: t, color: 'default' }
  }

  // 获取文件图标 - 使用 FileTextOutlined 代替不存在的 FileTxtOutlined
  const getFileIcon = (type) => {
    if (type === 'pdf') return <FilePdfOutlined style={{ color: '#ff4d4f' }} />
    if (type === 'docx' || type === 'doc') return <FileWordOutlined style={{ color: '#1890ff' }} />
    if (type === 'mp4') return <FileTextOutlined style={{ color: '#722ed1' }} />
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
      title: 'AI总结',
      dataIndex: 'ai_summary_status',
      key: 'ai_summary_status',
      width: 180,
      render: (s, row) => {
        const v = String(s || '')
        const tip = String(row?.ai_summary_error || '')
        const tag =
          v === 'ok' ? <Tag color="green">已生成</Tag>
            : v === 'pending' ? <Tag color="blue">生成中</Tag>
              : v === 'empty' ? <Tag color="orange">为空</Tag>
                : v === 'failed' ? <Tag color="red">失败</Tag>
                  : <Tag>未生成</Tag>
        const tagNode = tip ? <Tooltip title={tip}>{tag}</Tooltip> : tag

        return (
          <Space size={8}>
            <span
              style={{ cursor: 'pointer' }}
              onClick={async () => {
                if (!row?.doc_id) return
                if (String(row.ai_summary_status || '') === 'pending') {
                  message.info('AI 总结正在后台生成中，请稍后刷新')
                  return
                }
                try {
                  setDocSummaryLoading(true)
                  if (String(row.ai_summary_status || '') !== 'ok') {
                    await api.generateDocumentSummary(row.doc_id)
                    await loadDocs(true)
                  }
                  const res = await api.getDocumentSummary(row.doc_id)
                  setDocSummaryTitle((row.filename || 'AI总结') + '（结构化汇总）')
                  setDocSummaryText(String(res?.ai_summary || '').trim())
                  setDocSummaryOpen(true)
                } catch (e) {
                  message.error(e.response?.data?.detail || e.message || '获取 AI 总结失败')
                }
                setDocSummaryLoading(false)
              }}
            >
              {tagNode}
            </span>
          </Space>
        )
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

  const itemColumns = (() => {
    const baseColumns = [
      { title: '机械类别', dataIndex: 'machine_category', key: 'machine_category', width: 120, render: (v) => <Text>{v || '-'}</Text> },
      { title: '机械', dataIndex: 'machine', key: 'machine', width: 140, render: (v) => <Text>{v || '-'}</Text> },
    ]

    const faultColumns = [
      { title: '问题类别', dataIndex: 'problem_category', key: 'problem_category', width: 120, render: (v) => <Text>{v || '-'}</Text> },
      {
        title: '问题',
        dataIndex: 'problem',
        key: 'problem',
        width: 320,
        render: (v) => <ExpandableCell text={v} color="#1a1a1a" rows={2} />,
      },
      {
        title: '导致原因',
        dataIndex: 'root_cause',
        key: 'root_cause',
        width: 180,
        render: (v) => <ExpandableCell text={v} color="#8c8c8c" rows={2} />,
      },
      {
        title: '解决方法',
        dataIndex: 'solution',
        key: 'solution',
        width: 180,
        render: (v) => <ExpandableCell text={v} color="#389e0d" rows={2} />,
      },
    ]

    const maintenanceColumns = [
      { title: '操作类别', dataIndex: 'operation_category', key: 'operation_category', width: 120, render: (v) => <Text>{v || '-'}</Text> },
      {
        title: '操作项目',
        dataIndex: 'operation_item',
        key: 'operation_item',
        width: 280,
        render: (v) => <ExpandableCell text={v} color="#1a1a1a" rows={2} />,
      },
      {
        title: '操作步骤',
        dataIndex: 'operation_steps',
        key: 'operation_steps',
        width: 220,
        render: (v) => <ExpandableCell text={v} color="#595959" rows={2} />,
      },
      {
        title: '检查标准',
        dataIndex: 'check_standard',
        key: 'check_standard',
        width: 180,
        render: (v) => <ExpandableCell text={v} color="#1890ff" rows={2} />,
      },
      {
        title: '注意事项',
        dataIndex: 'precautions',
        key: 'precautions',
        width: 180,
        render: (v) => <ExpandableCell text={v} color="#fa8c16" rows={2} />,
      },
    ]

    const combinedColumns = [
      {
        title: '知识类型',
        dataIndex: 'knowledge_type',
        key: 'knowledge_type',
        width: 100,
        render: (v) => {
          const { text, color } = getKnowledgeTypeLabel(v)
          return <Tag color={color}>{text}</Tag>
        },
      },
      ...baseColumns,
      {
        title: '问题类别/操作类别',
        key: 'category',
        width: 140,
        render: (_, row) => (
          <Text>{String(row?.knowledge_type || 'fault') === 'maintenance' ? (row?.operation_category || '-') : (row?.problem_category || '-')}</Text>
        ),
      },
      {
        title: '问题/操作项目',
        key: 'subject',
        width: 280,
        render: (_, row) => {
          const text = String(row?.knowledge_type || 'fault') === 'maintenance' ? (row?.operation_item || '-') : (row?.problem || '-')
          return <ExpandableCell text={text} color="#1a1a1a" rows={2} />
        },
      },
      {
        title: '导致原因/检查标准',
        key: 'cause_standard',
        width: 180,
        render: (_, row) => {
          const text = String(row?.knowledge_type || 'fault') === 'maintenance' ? (row?.check_standard || '-') : (row?.root_cause || '-')
          return <ExpandableCell text={text} color="#595959" rows={2} />
        },
      },
      {
        title: '解决方法/操作步骤',
        key: 'solution_steps',
        width: 180,
        render: (_, row) => {
          const text = String(row?.knowledge_type || 'fault') === 'maintenance' ? (row?.operation_steps || '-') : (row?.solution || '-')
          return <ExpandableCell text={text} color="#389e0d" rows={2} />
        },
      },
      {
        title: '注意事项',
        dataIndex: 'precautions',
        key: 'precautions',
        width: 160,
        render: (v) => <ExpandableCell text={v} color="#fa8c16" rows={2} />,
      },
    ]

    const typeTagColumn = {
      title: '知识类型',
      dataIndex: 'knowledge_type',
      key: 'knowledge_type',
      width: 100,
      render: (v) => {
        const { text, color } = getKnowledgeTypeLabel(v)
        return <Tag color={color}>{text}</Tag>
      },
    }

    let contentColumns = []
    if (itemTypeFilter === 'fault') {
      contentColumns = [typeTagColumn, ...baseColumns, ...faultColumns]
    } else if (itemTypeFilter === 'maintenance') {
      contentColumns = [typeTagColumn, ...baseColumns, ...maintenanceColumns]
    } else {
      contentColumns = combinedColumns
    }

    return [
      ...contentColumns,
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
        width: 300,
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
  })()

  const filteredItems = useMemo(() => {
    const q = String(itemQuery || '').trim()
    let rows = items
    if (itemTypeFilter !== 'all') {
      rows = rows.filter(row => String(row?.knowledge_type || 'fault') === itemTypeFilter)
    }
    if (!q) return rows
    return rows.filter(row => {
      const hay = [
        row?.machine_category,
        row?.machine,
        row?.knowledge_type,
        row?.problem_category,
        row?.problem,
        row?.root_cause,
        row?.solution,
        row?.operation_category,
        row?.operation_item,
        row?.operation_steps,
        row?.check_standard,
        row?.precautions,
      ].map(v => String(v || '')).join(' ')
      return hay.includes(q)
    })
  }, [items, itemQuery, itemTypeFilter])

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
        {/* 后台任务列表 */}
        {uploadTasks.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div className="flex-between" style={{ marginBottom: 12 }}>
              <Text strong>上传任务（切换页面不会中断）</Text>
              {uploadTasks.some((t) => t.status === 'completed') && (
                <Button size="small" onClick={handleClearCompleted}>清空已完成</Button>
              )}
            </div>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              {uploadTasks.map((task) => {
                const statusMap = {
                  pending: { color: 'default', text: '等待中' },
                  uploading: { color: 'processing', text: '上传中' },
                  processing: { color: 'warning', text: 'AI 处理中' },
                  completed: { color: 'success', text: '已完成' },
                  failed: { color: 'error', text: '失败' },
                }
                const s = statusMap[task.status] || statusMap.pending
                return (
                  <div key={task.id} style={{ padding: 12, background: '#f6ffed', borderRadius: 8, border: '1px solid #b7eb8f' }}>
                    <div className="flex-between" style={{ marginBottom: 8 }}>
                      <Space>
                        <Text>{task.filename}</Text>
                        <Tag color={s.color}>{s.text}</Tag>
                        {task.error && <Text type="danger" style={{ fontSize: 12 }}>{task.error}</Text>}
                      </Space>
                      {task.status !== 'completed' && task.status !== 'failed' && (
                        <Text type="secondary" style={{ fontSize: 12 }}>可切换页面，后台继续</Text>
                      )}
                    </div>
                    <Progress
                      percent={task.status === 'completed' ? 100 : Math.min(task.progress || 0, 99)}
                      status={task.status === 'failed' ? 'exception' : task.status === 'completed' ? 'success' : 'active'}
                      strokeColor="#1890ff"
                      size="small"
                    />
                    {task.status === 'completed' && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        已入库，可刷新列表查看
                      </Text>
                    )}
                  </div>
                )
              })}
            </Space>
          </div>
        )}

        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong>上传到流水线：</Text>
          <Select
            style={{ width: 160 }}
            value={uploadPipeline}
            onChange={setUploadPipeline}
            options={pipelines.map(v => ({ value: v, label: v }))}
            disabled={hasActiveUpload}
            showSearch
            optionFilterProp="label"
          />
          <Input
            style={{ width: 180 }}
            placeholder="新流水线名称"
            value={newPipelineName}
            onChange={(e) => setNewPipelineName(e.target.value)}
            disabled={hasActiveUpload || creatingPipeline}
            onPressEnter={handleCreatePipeline}
          />
          <Button
            icon={<PlusOutlined />}
            onClick={handleCreatePipeline}
            loading={creatingPipeline}
            disabled={hasActiveUpload}
          >
            新建流水线
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>已上传旧文档自动归为流水线1</Text>
        </div>

        {/* 上传组件 */}
        <Dragger
          accept=".pdf,.docx,.doc,.txt,.mp4,.avi,.mov,.mkv,.flv,.wmv,.m4v,.webm"
          customRequest={handleUpload}
          showUploadList={false}
          disabled={hasActiveUpload}
          className={`upload-dragger kb-upload-dragger ${hasActiveUpload ? 'is-uploading' : ''}`}
        >
          <div style={{ padding: '16px 0' }}>
            <p style={{ fontSize: 48, marginBottom: 16, color: '#1890ff' }}>
              <InboxOutlined />
            </p>
            <p style={{ fontSize: 16, color: '#1a1a1a', marginBottom: 8 }}>
              点击或拖拽文件到此处上传
            </p>
            <p style={{ color: '#8c8c8c', fontSize: 13 }}>
              支持 PDF、Word (.docx/.doc)、TXT、MP4 格式
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
          <Button icon={<CheckCircleOutlined />} onClick={() => loadDocs(true)} className="btn-secondary">
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

      <Modal
        open={docSummaryOpen}
        title={docSummaryTitle || 'AI总结'}
        onCancel={() => setDocSummaryOpen(false)}
        footer={null}
        width={860}
      >
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
          {docSummaryText || '-'}
        </div>
      </Modal>

      <Card className="glass-card" style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Space>
            <Text strong style={{ fontSize: 15, color: '#1a1a1a' }}>结构化知识</Text>
            <Select
              style={{ width: 220 }}
              value={itemsPipeline}
              onChange={setItemsPipeline}
              options={pipelines.map(p => ({ value: p, label: p }))}
            />
            <Select
              style={{ width: 120 }}
              value={itemTypeFilter}
              onChange={setItemTypeFilter}
              options={[
                { value: 'all', label: '全部类型' },
                { value: 'fault', label: '故障类' },
                { value: 'maintenance', label: '维修类' },
              ]}
            />
            <Input
              style={{ width: 260 }}
              placeholder="过滤关键词"
              value={itemQuery}
              onChange={(e) => setItemQuery(e.target.value)}
              allowClear
            />
            <Tag color="blue">{filteredItems.length}/{items.length}</Tag>
          </Space>
          <Space>
            <Button onClick={() => loadItems(itemsPipeline)} loading={itemsLoading}>刷新</Button>
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
          dataSource={filteredItems}
          rowKey="item_id"
          loading={itemsLoading}
          scroll={{ x: 1800 }}
          tableLayout="fixed"
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
            let values = await itemForm.validateFields()
            setItemSubmitting(true)
            // 兼容后端：当前后端要求 problem/root_cause 非空；维修类时若未填则自动映射
            if (String(values?.knowledge_type || 'fault') === 'maintenance') {
              if (!String(values?.problem || '').trim()) {
                values = { ...values, problem: String(values?.operation_item || '').trim() }
              }
              if (!String(values?.root_cause || '').trim()) {
                values = { ...values, root_cause: String(values?.check_standard || values?.operation_steps || '').trim() }
              }
            }
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
        <Form form={itemForm} layout="vertical" initialValues={{ pipeline: itemsPipeline, knowledge_type: 'fault' }}>
          <Form.Item name="pipeline" label="流水线" rules={[{ required: true, message: '请输入流水线' }]}>
            <Input placeholder="例如：流水线1" />
          </Form.Item>
          <Form.Item name="knowledge_type" label="知识类型" rules={[{ required: true, message: '请选择知识类型' }]}>
            <Select
              options={[
                { value: 'fault', label: '故障类' },
                { value: 'maintenance', label: '维修类' },
              ]}
              onChange={() => itemForm.validateFields(['knowledge_type'])}
            />
          </Form.Item>
          <Form.Item name="machine_category" label="机械类别">
            <Input placeholder="例如：变频器" />
          </Form.Item>
          <Form.Item name="machine" label="机械">
            <Input placeholder="例如：1FT7 电机" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, curr) => prev.knowledge_type !== curr.knowledge_type}>
            {({ getFieldValue }) => {
              const ktype = String(getFieldValue('knowledge_type') || 'fault')
              if (ktype === 'maintenance') {
                return (
                  <>
                    <Form.Item name="operation_category" label="操作类别">
                      <Input placeholder="例如：定期保养" />
                    </Form.Item>
                    <Form.Item name="operation_item" label="操作项目" rules={[{ required: true, message: '请输入操作项目' }]}>
                      <Input.TextArea placeholder="例如：主轴润滑脂检查" autoSize={{ minRows: 2, maxRows: 4 }} />
                    </Form.Item>
                    <Form.Item name="operation_steps" label="操作步骤">
                      <Input.TextArea placeholder="例如：1. 停机断电 2. 打开注油口 3. 检查油位" autoSize={{ minRows: 2, maxRows: 4 }} />
                    </Form.Item>
                    <Form.Item name="check_standard" label="检查标准">
                      <Input.TextArea placeholder="例如：油位处于刻度线 1/2 至 2/3 之间" autoSize={{ minRows: 2, maxRows: 4 }} />
                    </Form.Item>
                    <Form.Item name="precautions" label="注意事项">
                      <Input.TextArea placeholder="例如：确认设备已完全断电并悬挂警示牌" autoSize={{ minRows: 2, maxRows: 4 }} />
                    </Form.Item>
                  </>
                )
              }
              return (
                <>
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
                </>
              )
            }}
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
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {String(expertWeightItem?.knowledge_type || 'fault') === 'maintenance' ? '操作项目' : '问题'}
            </Text>
            <Text type="secondary">
              {String(expertWeightItem?.knowledge_type || 'fault') === 'maintenance'
                ? (expertWeightItem?.operation_item || '-')
                : (expertWeightItem?.problem || '-')}
            </Text>
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
