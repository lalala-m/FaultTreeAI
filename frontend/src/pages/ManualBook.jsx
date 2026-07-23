import React, { useEffect, useMemo, useState } from 'react'
import { Card, Button, Space, Select, Table, Typography, Input, message, Tag, Tree, Empty, Spin, Statistic, Row, Col, Tooltip } from 'antd'
import { DownloadOutlined, ReloadOutlined, FileTextOutlined } from '@ant-design/icons'
import api from '../services/api.js'

const { Title, Text } = Typography

const parseFilename = (contentDisposition) => {
  const raw = String(contentDisposition || '')
  const m1 = raw.match(/filename\*=UTF-8''([^;]+)/i)
  if (m1?.[1]) {
    try { return decodeURIComponent(m1[1]) } catch { return m1[1] }
  }
  const m2 = raw.match(/filename="?([^"]+)"?/i)
  if (m2?.[1]) return m2[1]
  return ''
}

// 权重 → 标签颜色
const weightColor = (w) => {
  const pct = Math.round((Number(w) || 0) * 100)
  if (pct >= 70) return 'green'
  if (pct >= 50) return 'blue'
  return 'orange'
}

const getKnowledgeTypeLabel = (type) => {
  const t = String(type || 'fault')
  if (t === 'maintenance') return { text: '维修类', color: 'orange' }
  if (t === 'fault') return { text: '故障类', color: 'blue' }
  return { text: t, color: 'default' }
}

export default function ManualBook() {
  const [pipelines, setPipelines] = useState(['流水线1'])
  const [pipeline, setPipeline] = useState('流水线1')
  const [machineCategory, setMachineCategory] = useState('')
  const [data, setData] = useState(null) // { sections, items, machine_categories, total }
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [query, setQuery] = useState('')
  const [expandedKeys, setExpandedKeys] = useState([])

  useEffect(() => {
    const load = async () => {
      try {
        const vals = await api.listPipelines()
        const uniq = Array.from(new Set((vals || []).filter(Boolean)))
        if (uniq.length === 0) uniq.push('流水线1')
        setPipelines(uniq)
        if (!uniq.includes(pipeline)) setPipeline(uniq[0])
      } catch {
        setPipelines(['流水线1'])
      }
    }
    load()
  }, [])

  const loadData = async (opts = {}) => {
    const p = (opts.pipeline ?? pipeline ?? '').trim() || '流水线1'
    const mc = String(opts.machineCategory ?? machineCategory ?? '').trim() || undefined
    setLoading(true)
    try {
      const res = await api.listStructuredManual(p, { machine_category: mc, limit: 2000 })
      setData(res || null)
      // 默认展开第一个机械类别
      const sections = (res?.sections) || []
      if (sections.length > 0) {
        setExpandedKeys([`mc-${sections[0].machine_category}`])
      }
    } catch (e) {
      setData(null)
      message.error(e?.response?.data?.detail || e?.message || '加载失败')
    }
    setLoading(false)
  }

  useEffect(() => {
    loadData({ pipeline, machineCategory })
  }, [pipeline, machineCategory])

  // 扁平条目（用于表格视图）
  const flatItems = useMemo(() => {
    return Array.isArray(data?.items) ? data.items : []
  }, [data])

  // 搜索过滤
  const filteredItems = useMemo(() => {
    const q = String(query || '').trim()
    if (!q) return flatItems
    return flatItems.filter((x) => {
      const s = [
        x?.machine_category, x?.machine, x?.knowledge_type,
        x?.problem_category, x?.problem, x?.root_cause, x?.solution,
        x?.operation_category, x?.operation_item, x?.operation_steps,
        x?.check_standard, x?.precautions,
      ].filter(Boolean).join(' ')
      return s.includes(q)
    })
  }, [flatItems, query])

  // 树形数据（机械类别 → 机械）
  const treeData = useMemo(() => {
    const sections = (data?.sections) || []
    return sections.map((sec) => ({
      key: `mc-${sec.machine_category}`,
      title: (
        <Space size={6}>
          <Text strong>{sec.machine_category}</Text>
          <Tag color="blue">{sec.count} 条</Tag>
        </Space>
      ),
      children: (sec.machines || []).map((m) => ({
        key: `m-${sec.machine_category}-${m.machine}`,
        title: (
          <Space size={6}>
            <Text>{m.machine}</Text>
            <Tag>{m.count} 条</Tag>
          </Space>
        ),
        isLeaf: true,
      })),
    }))
  }, [data])

  const exportWord = async () => {
    const p = (pipeline || '').trim() || '流水线1'
    setExporting(true)
    try {
      const res = await api.exportStructuredManualWord(p)
      const blob = new Blob([res.data], { type: res.headers?.['content-type'] || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      const url = URL.createObjectURL(blob)
      const filename = parseFilename(res.headers?.['content-disposition']) || `规范手册_结构化知识_${p}.docx`
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      message.success('已导出 Word')
    } catch (e) {
      message.error(e?.response?.data?.detail || e?.message || '导出失败')
    }
    setExporting(false)
  }

  // 通用省略号单元格：超出宽度截断，hover 显示完整内容
  const EllipsisCell = ({ children, color, width }) => (
    <Tooltip title={children} placement="topLeft" overlayStyle={{ maxWidth: 400 }}>
      <div
        style={{
          color,
          maxWidth: width,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          lineHeight: 1.5,
        }}
      >
        {children}
      </div>
    </Tooltip>
  )

  const columns = [
    {
      title: '知识类型',
      dataIndex: 'knowledge_type',
      key: 'knowledge_type',
      width: 90,
      render: (v) => {
        const { text, color } = getKnowledgeTypeLabel(v)
        return <Tag color={color}>{text}</Tag>
      },
    },
    {
      title: '机械类别',
      dataIndex: 'machine_category',
      key: 'machine_category',
      width: 100,
      render: (v) => v ? <Tag color="purple">{v}</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: '机械',
      dataIndex: 'machine',
      key: 'machine',
      width: 120,
      render: (v) => <EllipsisCell width={100} color="#1a1a1a">{v || '-'}</EllipsisCell>,
    },
    {
      title: '问题类别',
      dataIndex: 'problem_category',
      key: 'problem_category',
      width: 100,
      render: (v) => v ? <Tag color="cyan">{v}</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: '问题',
      dataIndex: 'problem',
      key: 'problem',
      width: 200,
      render: (v) => <EllipsisCell width={180} color="#1a1a1a">{v || '-'}</EllipsisCell>,
    },
    {
      title: '导致原因',
      dataIndex: 'root_cause',
      key: 'root_cause',
      width: 180,
      render: (v) => <EllipsisCell width={160} color="#595959">{v || '-'}</EllipsisCell>,
    },
    {
      title: '解决方法',
      dataIndex: 'solution',
      key: 'solution',
      width: 200,
      render: (v) => <EllipsisCell width={180} color="#389e0d">{v || '-'}</EllipsisCell>,
    },
    {
      title: '操作类别',
      dataIndex: 'operation_category',
      key: 'operation_category',
      width: 100,
      render: (v) => v ? <Tag color="cyan">{v}</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: '操作项目',
      dataIndex: 'operation_item',
      key: 'operation_item',
      width: 200,
      render: (v) => <EllipsisCell width={180} color="#1a1a1a">{v || '-'}</EllipsisCell>,
    },
    {
      title: '操作步骤',
      dataIndex: 'operation_steps',
      key: 'operation_steps',
      width: 220,
      render: (v) => <EllipsisCell width={200} color="#595959">{v || '-'}</EllipsisCell>,
    },
    {
      title: '检查标准',
      dataIndex: 'check_standard',
      key: 'check_standard',
      width: 180,
      render: (v) => <EllipsisCell width={160} color="#1890ff">{v || '-'}</EllipsisCell>,
    },
    {
      title: '注意事项',
      dataIndex: 'precautions',
      key: 'precautions',
      width: 180,
      render: (v) => <EllipsisCell width={160} color="#fa8c16">{v || '-'}</EllipsisCell>,
    },
    {
      title: '权重',
      dataIndex: 'effective_weight',
      key: 'effective_weight',
      width: 80,
      render: (v, row) => {
        const weight = Number(v)
        const fallback = Number(row?.current_weight ?? 0.5)
        const pct = Math.round((Number.isFinite(weight) ? weight : (Number.isFinite(fallback) ? fallback : 0.5)) * 100)
        return <Tag color={weightColor(pct / 100)}>{pct}%</Tag>
      },
    },
  ]

  // 统计
  const stats = useMemo(() => {
    const total = data?.total || flatItems.length
    const mcCount = (data?.machine_categories || []).length
    const machineCount = new Set(flatItems.map(x => x?.machine).filter(Boolean)).size
    return { total, mcCount, machineCount }
  }, [data, flatItems])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <Title level={4} style={{ margin: 0 }}>规范手册</Title>
              <Text type="secondary">展示知识库中的结构化知识（机械类别 → 机械 → 问题 → 原因 → 解决方案），可一键导出 Word</Text>
            </div>
            <Space wrap>
              <Button icon={<ReloadOutlined />} onClick={() => loadData()} disabled={loading}>刷新</Button>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={exportWord}
                loading={exporting}
                disabled={!flatItems.length}
              >
                导出 Word
              </Button>
            </Space>
          </div>

          <Row gutter={16}>
            <Col>
              <Statistic title="知识条目" value={stats.total} />
            </Col>
            <Col>
              <Statistic title="机械类别" value={stats.mcCount} />
            </Col>
            <Col>
              <Statistic title="机械设备" value={stats.machineCount} />
            </Col>
          </Row>

          <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space wrap>
              <div>
                <Text type="secondary">流水线</Text>
                <div>
                  <Select
                    style={{ width: 160 }}
                    value={pipeline}
                    onChange={setPipeline}
                    options={pipelines.map(v => ({ value: v, label: v }))}
                  />
                </div>
              </div>
              <div>
                <Text type="secondary">机械类别</Text>
                <div>
                  <Select
                    style={{ width: 160 }}
                    value={machineCategory}
                    onChange={setMachineCategory}
                    allowClear
                    placeholder="全部"
                    options={(data?.machine_categories || []).map(v => ({ value: v, label: v }))}
                  />
                </div>
              </div>
            </Space>
            <div style={{ minWidth: 260 }}>
              <Input
                allowClear
                placeholder="搜索机械/问题/操作项目/原因/检查标准/解决方案"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </Space>
        </Space>
      </Card>

      <Card>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin tip="加载中…" />
          </div>
        ) : flatItems.length === 0 ? (
          <Empty
            description="暂无结构化知识"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          >
            <Text type="secondary">请先在「知识库」页面上传文档并整理结构化知识。</Text>
          </Empty>
        ) : (
          <>
            {/* 分类树（可折叠的导航） */}
            {treeData.length > 0 && (
              <div style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <FileTextOutlined /> 知识结构（点击展开查看机械设备分组）
                </Text>
                <Tree
                  treeData={treeData}
                  expandedKeys={expandedKeys}
                  onExpand={setExpandedKeys}
                  selectable={false}
                  style={{ marginTop: 8, background: 'transparent' }}
                />
              </div>
            )}

            <Table
              rowKey={(r) => r?.item_id || `${r?.machine_category}:${r?.machine}:${r?.problem}`}
              columns={columns}
              dataSource={filteredItems}
              pagination={{
                pageSize: 20,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50, 100],
                showTotal: (t) => `共 ${t} 条`,
              }}
              scroll={{ x: 1950 }}
              size="middle"
              style={{ whiteSpace: 'nowrap' }}
              tableLayout="fixed"
            />
          </>
        )}
      </Card>
    </div>
  )
}
