import React, { useEffect, useState, Suspense, lazy, useRef } from 'react'
import { Typography, Card, Input, Button, Space, Select, Badge, Slider, Tag, Modal, message } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import api from '../services/api.js'

const { Title, Text } = Typography
const FaultTreeViewer = lazy(() => import('../components/FaultTreeViewer.jsx'))
const TreeEditor = lazy(() => import('../components/TreeEditor.jsx'))

export default function Dashboard({ onNavigate }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [docs, setDocs] = useState([])
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [providers, setProviders] = useState([])
  const [selectedProvider, setSelectedProvider] = useState(null)
  const [manualWeight, setManualWeight] = useState(50)
  const [fsOpen, setFsOpen] = useState(false)
  const [fsMode, setFsMode] = useState('view') // view | edit
  const [fsTree, setFsTree] = useState(null)
  const [fsSaving, setFsSaving] = useState(false)
  const editorRef = useRef(null)

  useEffect(() => {
    const loadDocs = async () => {
      try {
        const data = await api.listDocuments()
        setDocs(Array.isArray(data) ? data : [])
      } catch {
        setDocs([])
      }
    }
    const loadProviders = async () => {
      try {
        const data = await api.getProviders()
        setProviders(data.providers || [])
        const first = (data.providers || []).find(p => p.available)
        setSelectedProvider(first?.name || data.primary || 'minimax')
      } catch {
        setProviders([])
        setSelectedProvider('minimax')
      }
    }
    loadDocs()
    loadProviders()
  }, [])

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('dashboard_chat_inject')
      if (raw) {
        const obj = JSON.parse(raw)
        if (Array.isArray(obj?.messages) && obj.messages.length) {
          setMessages(prev => [...prev, ...obj.messages.map(m => ({ role: m.role, text: String(m.text || '') }))])
        }
        sessionStorage.removeItem('dashboard_chat_inject')
      }
    } catch {}
  }, [])
  const send = async () => {
    const text = input.trim()
    if (!text) return
    setMessages(prev => [...prev, { role: 'user', text }])
    setInput('')
    setLoading(true)
    try {
      const data = await api.generateFaultTree({
        top_event: text,
        user_prompt: '',
        rag_top_k: 5,
        use_fallback: true,
        provider: selectedProvider || undefined,
        doc_ids: selectedDoc ? [selectedDoc] : undefined,
        manual_weight: Math.max(0, Math.min(100, manualWeight)) / 100.0,
      })
      setMessages(prev => [...prev, { role: 'assistant', text: data.fault_tree?.analysis_summary || '已生成故障树。', result: data }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', text: '生成失败：' + (e.response?.data?.detail || e.message) }])
    }
    setLoading(false)
  }

  const loadToGenerate = (data) => {
    try {
      const payload = {
        topEvent: data?.fault_tree?.top_event || '',
        systemName: '',
        selectedDoc,
        selectedProvider,
        result: {
          tree_id: data.tree_id,
          fault_tree: data.fault_tree,
          nodes_json: data.fault_tree?.nodes,
          gates_json: data.fault_tree?.gates,
          mcs: data.mcs,
          importance: data.importance,
          validation_issues: data.validation_issues,
          provider: data.provider,
        },
        viewMode: 'view',
        savedAt: Date.now(),
      }
      sessionStorage.setItem('faulttreeai_generate_state_v1', JSON.stringify(payload))
    } catch {}
    onNavigate?.('generate')
  }

  const openFullScreen = (data, mode = 'view') => {
    const tree = {
      tree_id: data.tree_id,
      fault_tree: data.fault_tree,
      top_event: data.fault_tree?.top_event,
      nodes_json: data.fault_tree?.nodes,
      gates_json: data.fault_tree?.gates,
      mcs: data.mcs,
      importance: data.importance,
      validation_issues: data.validation_issues,
      provider: data.provider
    }
    setFsTree(tree)
    setFsMode(mode)
    setFsOpen(true)
  }

  const saveFullScreen = async () => {
    if (!fsTree?.tree_id || !editorRef.current) return
    setFsSaving(true)
    try {
      const edited = await editorRef.current.save()
      const payload = {
        nodes: edited.nodes,
        gates: edited.gates,
        fault_tree: edited.fault_tree,
        mcs: fsTree.mcs,
        importance: fsTree.importance,
        validation_issues: fsTree.validation_issues,
      }
      await api.saveFaultTree(fsTree.tree_id, payload)
      setFsTree(prev => ({
        ...prev,
        fault_tree: edited.fault_tree,
        nodes_json: edited.nodes,
        gates_json: edited.gates
      }))
      message.success('已保存到数据库')
      setFsMode('view')
    } catch (e) {
      message.error(e?.message || '保存失败')
    }
    setFsSaving(false)
  }

  return (
    <div className="page-container" style={{ paddingBottom: 96 }}>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} className="page-title">对话</Title>
      </div>
      <Card className="glass-card" style={{ minHeight: '60vh' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.length === 0 && <Text type="secondary">在下方输入框与 AI 对话，这里会显示双方对话内容。</Text>}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '80%',
                padding: 12,
                borderRadius: 8,
                background: m.role === 'user' ? '#e6f7ff' : '#fafafa',
                border: '1px solid #f0f0f0'
              }}>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Text>
                {m.result && (
                  <div style={{ marginTop: 12 }}>
                    <Space wrap>
                      {m.result.provider && <Tag color="purple">模型: {String(m.result.provider).toUpperCase()}</Tag>}
                      <Tag>权重: {manualWeight}%</Tag>
                      <Tag>TopK: 5</Tag>
                    </Space>
                    <div style={{ marginTop: 12 }}>
                      <Suspense fallback={null}>
                        <FaultTreeViewer tree={{
                          tree_id: m.result.tree_id,
                          fault_tree: m.result.fault_tree,
                          nodes_json: m.result.fault_tree?.nodes,
                          gates_json: m.result.fault_tree?.gates,
                          mcs: m.result.mcs,
                          importance: m.result.importance,
                          validation_issues: m.result.validation_issues
                        }} />
                      </Suspense>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Button size="small" onClick={() => loadToGenerate(m.result)}>
                        载入到生成页并编辑
                      </Button>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Space wrap>
                        <Button size="small" onClick={() => openFullScreen(m.result, 'view')}>全屏查看</Button>
                        <Button size="small" type="primary" onClick={() => openFullScreen(m.result, 'edit')}>主页专家编辑</Button>
                        <Button size="small" onClick={() => loadToGenerate(m.result)}>载入到生成页并编辑</Button>
                      </Space>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{ position: 'fixed', left: 280, right: 0, bottom: 0, background: '#fff', borderTop: '1px solid #f0f0f0', padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <Select
            style={{ width: 420 }}
            placeholder="选择已上传的操作手册..."
            value={selectedDoc}
            onChange={setSelectedDoc}
            allowClear
            options={docs.filter(d=>d.status==='active').map(d=>({value:d.doc_id,label:d.filename}))}
          />
          <Select
            style={{ width: 180 }}
            value={selectedProvider}
            onChange={setSelectedProvider}
            options={providers.map(p => ({
              value: p.name,
              disabled: !p.available,
              label: (
                <Space>
                  <span style={{ textTransform: 'capitalize' }}>{p.name}</span>
                  <Badge status={p.available ? 'success' : 'error'} text={p.available ? '可用' : (p.reason || '不可用')} />
                </Space>
              )
            }))}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>文档权重</span>
            <Slider style={{ flex: 1, minWidth: 300 }} value={manualWeight} onChange={setManualWeight} min={0} max={100} step={1} marks={{0:'0%',50:'50%',100:'100%'}} />
            <Tag color="geekblue" style={{ minWidth: 48, textAlign: 'center' }}>{manualWeight}%</Tag>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Input.TextArea
            value={input}
            onChange={e=>setInput(e.target.value)}
            onPressEnter={(e)=>{ if(!e.shiftKey){ e.preventDefault(); send(); } }}
            placeholder="有问题，尽管问，shift+enter 换行"
            autoSize={{ minRows: 2, maxRows: 4 }}
            disabled={loading}
          />
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={send} loading={loading}>发送</Button>
        </div>
      </div>
      <Modal
        open={fsOpen}
        title={fsTree?.top_event || '故障树'}
        onCancel={() => setFsOpen(false)}
        width="96vw"
        style={{ top: 8 }}
        bodyStyle={{ height: '78vh', overflow: 'auto' }}
        footer={
          fsMode === 'view'
            ? [
                <Button key="close" onClick={() => setFsOpen(false)}>关闭</Button>,
                <Button key="edit" type="primary" onClick={() => setFsMode('edit')}>专家编辑</Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setFsMode('view')}>取消</Button>,
                <Button key="save" type="primary" loading={fsSaving} onClick={saveFullScreen}>保存</Button>,
              ]
        }
      >
        <Suspense fallback={null}>
          {fsTree && fsMode === 'view' && <FaultTreeViewer tree={fsTree} />}
          {fsTree && fsMode === 'edit' && (
            <TreeEditor
              ref={editorRef}
              initialTree={fsTree}
              onSave={() => {}}
              onCancel={() => setFsMode('view')}
            />
          )}
        </Suspense>
      </Modal>
    </div>
  )
}
