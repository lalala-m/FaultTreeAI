import React, { useEffect, useMemo, useState } from 'react'
import { Card, Button, Space, Select, Table, Typography, Input, message, Tag, Switch } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
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

export default function ManualBook() {
  const [pipelines, setPipelines] = useState(['流水线1'])
  const [pipeline, setPipeline] = useState('流水线1')
  const [category, setCategory] = useState('')
  const [useAI, setUseAI] = useState(true)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [reextracting, setReextracting] = useState(false)
  const [query, setQuery] = useState('')

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

  const loadEntries = async (opts = {}) => {
    const p = (opts.pipeline ?? pipeline ?? '').trim() || '流水线1'
    const c = String(opts.category ?? category ?? '').trim()
    const ai = typeof opts.useAI === 'boolean' ? opts.useAI : useAI
    setLoading(true)
    try {
      const res = await api.listManualEntries(p, { category: c || undefined, limit: 600, use_ai: ai ? 1 : 0 })
      setEntries(Array.isArray(res?.entries) ? res.entries : [])
    } catch (e) {
      setEntries([])
      message.error(e?.response?.data?.detail || e?.message || '加载失败')
    }
    setLoading(false)
  }

  useEffect(() => {
    loadEntries({ pipeline, category, useAI })
  }, [pipeline, category, useAI])

  const filtered = useMemo(() => {
    const q = String(query || '').trim()
    if (!q) return entries
    return (entries || []).filter((x) => {
      const t = String(x?.text || '')
      const s = `${String(x?.topic || '')} ${t}`
      return s.includes(q)
    })
  }, [entries, query])

  const exportWord = async () => {
    const p = (pipeline || '').trim() || '流水线1'
    try {
      const res = await api.exportManualWord(p, { use_ai: useAI ? 1 : 0 })
      const blob = new Blob([res.data], { type: res.headers?.['content-type'] || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      const url = URL.createObjectURL(blob)
      const filename = parseFilename(res.headers?.['content-disposition']) || `规范手册_${p}.docx`
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
  }

  const columns = [
    {
      title: '类别',
      dataIndex: 'category',
      key: 'category',
      width: 90,
      render: (v) => {
        const c = String(v || '')
        const color = c === '安全' ? 'red' : c === '操作' ? 'blue' : 'green'
        return <Tag color={color}>{c || '-'}</Tag>
      }
    },
    {
      title: '主题',
      dataIndex: 'topic',
      key: 'topic',
      width: 180,
      render: (v) => <Text type="secondary">{String(v || '-')}</Text>
    },
    {
      title: '条目',
      dataIndex: 'text',
      key: 'text',
      render: (v) => <Text style={{ color: '#111' }}>{String(v || '-')}</Text>
    },
  ]

  const reextract = async () => {
    setReextracting(true)
    try {
      await api.reextractManualEntries(pipeline, { use_ai: useAI })
      message.success('已重新抽取')
      await loadEntries()
    } catch (e) {
      message.error(e?.response?.data?.detail || e?.message || '重新抽取失败')
    }
    setReextracting(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <Title level={4} style={{ margin: 0 }}>规范手册</Title>
              <Text type="secondary">从知识库文档中按流水线整理规范/操作/安全条目，可一键导出</Text>
            </div>
            <Space wrap>
              <Space size={6}>
                <Text type="secondary">AI增强</Text>
                <Switch checked={useAI} onChange={setUseAI} />
              </Space>
              <Button icon={<ReloadOutlined />} onClick={() => loadEntries()} disabled={loading}>刷新</Button>
              <Button onClick={reextract} loading={reextracting} disabled={loading}>
                整理手册/重新抽取
              </Button>
              <Button type="primary" icon={<DownloadOutlined />} onClick={exportWord}>导出 Word</Button>
            </Space>
          </div>
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
                <Text type="secondary">类别</Text>
                <div>
                  <Select
                    style={{ width: 140 }}
                    value={category}
                    onChange={setCategory}
                    options={[
                      { value: '', label: '全部' },
                      { value: '安全', label: '安全' },
                      { value: '操作', label: '操作' },
                      { value: '规范', label: '规范' },
                    ]}
                  />
                </div>
              </div>
            </Space>
            <div style={{ minWidth: 240 }}>
              <Input
                allowClear
                placeholder="搜索条目或文件名"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </Space>
        </Space>
      </Card>

      <Card>
        <Table
          rowKey={(r) => `${r?.category || ''}:${r?.topic || ''}:${r?.text || ''}`}
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
        />
      </Card>
    </div>
  )
}
