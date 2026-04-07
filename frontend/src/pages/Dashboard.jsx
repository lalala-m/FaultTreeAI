import React, { useEffect, useMemo, useState, Suspense, lazy, useRef } from 'react'
import { Typography, Card, Input, Button, Space, Select, Badge, Slider, Tag, Modal, message, Progress, Radio, Divider, List } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import api from '../services/api.js'

const { Title, Text } = Typography
const FaultTreeViewer = lazy(() => import('../components/FaultTreeViewer.jsx'))
const TreeEditor = lazy(() => import('../components/TreeEditor.jsx'))
const QUESTION_WEIGHT_STORAGE_KEY = 'faulttreeai_troubleshooting_question_weights_v1'

const loadQuestionWeightMemory = () => {
  try {
    const raw = localStorage.getItem(QUESTION_WEIGHT_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const saveQuestionWeightMemory = (memory) => {
  try {
    localStorage.setItem(QUESTION_WEIGHT_STORAGE_KEY, JSON.stringify(memory || {}))
  } catch {
  }
}

const extractTerms = (value) => {
  const matches = String(value || '').toLowerCase().match(/[\u4e00-\u9fa5]{1,}|[a-z0-9_]+/g)
  return Array.from(new Set(matches || []))
}

const textOverlapScore = (a, b) => {
  const termsA = extractTerms(a)
  const termsB = new Set(extractTerms(b))
  if (!termsA.length || !termsB.size) return 0
  const hit = termsA.filter(term => termsB.has(term)).length
  return hit / Math.max(termsA.length, 1)
}

const normalizeValue = (value, min, max, fallback = 0.5) => {
  const v = Number(value)
  if (!Number.isFinite(v)) return fallback
  const lo = Number(min)
  const hi = Number(max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return fallback
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
}

const pickNextQuestionId = (candidates, templates) => {
  const pending = [...(Array.isArray(candidates) ? candidates : [])]
    .filter(item => !item.answered && !item.eliminated)
    .sort((a, b) => b.score - a.score)
  const backup = [...(Array.isArray(candidates) ? candidates : [])]
    .filter(item => !item.answered)
    .sort((a, b) => b.score - a.score)
  const next = pending[0] || backup[0]
  if (!next) return null
  return templates.find(item => item.node_id === next.node_id)?.question_id || null
}

const buildTroubleshootingState = (result, docId, docWeight = 0.5) => {
  const basics = Array.isArray(result?.fault_tree?.nodes)
    ? result.fault_tree.nodes.filter(n => n?.type === 'basic')
    : []
  const importanceMap = new Map(
    Array.isArray(result?.importance)
      ? result.importance.map(item => [String(item.node_id), Number(item.importance || 0)])
      : []
  )
  const questionWeightMemory = loadQuestionWeightMemory()
  const importanceValues = basics.map((node, index) => Number(importanceMap.get(String(node.id)) ?? Math.max(0.1, 1 - index * 0.08)))
  const minImportance = importanceValues.length ? Math.min(...importanceValues) : 0
  const maxImportance = importanceValues.length ? Math.max(...importanceValues) : 1
  const topEvent = String(result?.fault_tree?.top_event || '')
  const candidates = basics
    .map((node, index) => ({
      node_id: String(node.id),
      name: String(node.name || node.id || `节点${index + 1}`),
      description: String(node.description || ''),
      importance_score: Number(importanceMap.get(String(node.id)) ?? Math.max(0.1, 1 - index * 0.08)),
      answered: false,
      eliminated: false,
      last_answer: null,
    }))
    .map((item) => {
      const templateKey = `${item.node_id}:${item.name}`
      const importanceWeight = normalizeValue(item.importance_score, minImportance, maxImportance, 0.5)
      const symptomWeight = textOverlapScore(topEvent, `${item.name} ${item.description}`)
      const memoryWeight = Number(questionWeightMemory[templateKey] ?? 0.5)
      const score = (
        importanceWeight * 0.58 +
        symptomWeight * 0.22 +
        Number(docWeight || 0.5) * 0.10 +
        memoryWeight * 0.10
      )
      return {
        ...item,
        template_key: templateKey,
        importance_weight: importanceWeight,
        symptom_weight: symptomWeight,
        memory_weight: memoryWeight,
        doc_weight: Number(docWeight || 0.5),
        score: Number(score.toFixed(4)),
      }
    })
    .sort((a, b) => b.score - a.score)

  const questions = candidates.slice(0, Math.min(8, candidates.length)).map((item, idx) => ({
    question_id: `Q${String(idx + 1).padStart(3, '0')}`,
    node_id: item.node_id,
    template_key: item.template_key,
    priority_score: item.score,
    title: `优先检查“${item.name}”是否存在异常？`,
    description: item.description || `该项当前权重较高，建议优先检查“${item.name}”相关现象、测量值或连接状态。`,
    options: [
      { label: '是，存在异常', value: 'yes' },
      { label: '否，检查正常', value: 'no' },
      { label: '暂不确定', value: 'unknown' },
    ],
  }))

  return {
    tree_id: result?.tree_id || null,
    top_event: topEvent,
    doc_id: docId || null,
    doc_weight: Number(docWeight || 0.5),
    result,
    candidates,
    questions,
    currentQuestionId: pickNextQuestionId(candidates, questions),
    answers: [],
    finished: questions.length === 0,
  }
}

const applyTroubleshootingAnswer = (state, answerValue) => {
  if (!state || state.finished) return state
  const question = state.questions.find(item => item.question_id === state.currentQuestionId)
  if (!question) return { ...state, finished: true }
  const candidates = state.candidates.map(item => ({ ...item }))
  const target = candidates.find(item => item.node_id === question.node_id)
  if (target) {
    target.answered = true
    target.last_answer = answerValue
    if (answerValue === 'yes') {
      target.score = Math.min(1.5, target.score + 0.42)
      target.eliminated = false
      candidates.forEach(item => {
        if (item.node_id !== target.node_id) item.score = Math.max(0.01, item.score * 0.9)
      })
    } else if (answerValue === 'no') {
      target.score = Math.max(0.01, target.score * 0.08)
      target.eliminated = true
    } else {
      target.score = Math.max(0.01, target.score * 0.88)
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const answers = [
    ...state.answers,
    {
      question_id: question.question_id,
      node_id: question.node_id,
      answer: answerValue,
      answered_at: Date.now(),
    },
  ]
  const nextQuestionId = pickNextQuestionId(candidates, state.questions)
  return {
    ...state,
    candidates,
    answers,
    currentQuestionId: nextQuestionId,
    finished: !nextQuestionId,
  }
}

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
  const fsWrapRef = useRef(null)
  const [fsNativeOpen, setFsNativeOpen] = useState(false)
  const fsLayerRef = useRef(null)
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [troubleshootingState, setTroubleshootingState] = useState(null)
  const [currentAnswer, setCurrentAnswer] = useState('unknown')
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackResolved, setFeedbackResolved] = useState(true)
  const [feedbackRootCause, setFeedbackRootCause] = useState(undefined)
  const [feedbackHelpfulQuestion, setFeedbackHelpfulQuestion] = useState(undefined)
  const [feedbackNote, setFeedbackNote] = useState('')

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
      const selectedDocItem = docs.find(item => item.doc_id === selectedDoc)
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: data.fault_tree?.analysis_summary || '已生成故障树。',
        result: data,
        meta: {
          doc_id: selectedDoc || null,
          doc_weight: Number(selectedDocItem?.current_weight ?? 0.5),
          manual_weight: manualWeight,
          provider: selectedProvider || null,
        },
      }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', text: '生成失败：' + (e.response?.data?.detail || e.message) }])
    }
    setLoading(false)
  }

  const openTroubleshooting = (messageItem) => {
    const state = buildTroubleshootingState(messageItem?.result, messageItem?.meta?.doc_id, messageItem?.meta?.doc_weight ?? 0.5)
    if (!state.questions.length) {
      message.warning('当前故障树暂无可用的连续排查问题')
      return
    }
    setTroubleshootingState(state)
    setCurrentAnswer('unknown')
    setFeedbackResolved(true)
    setFeedbackRootCause(undefined)
    setFeedbackHelpfulQuestion(undefined)
    setFeedbackNote('')
    setTroubleshootingOpen(true)
  }

  const submitTroubleshootingAnswer = () => {
    setTroubleshootingState(prev => applyTroubleshootingAnswer(prev, currentAnswer))
    setCurrentAnswer('unknown')
  }

  const topCandidates = useMemo(() => {
    const list = Array.isArray(troubleshootingState?.candidates) ? troubleshootingState.candidates : []
    return list.slice(0, 3)
  }, [troubleshootingState])

  const currentQuestion = useMemo(
    () => troubleshootingState?.questions?.find(item => item.question_id === troubleshootingState?.currentQuestionId) || null,
    [troubleshootingState]
  )
  const currentCandidate = useMemo(
    () => troubleshootingState?.candidates?.find(item => item.node_id === currentQuestion?.node_id) || null,
    [troubleshootingState, currentQuestion]
  )

  const submitTroubleshootingFeedback = async () => {
    if (!troubleshootingState) return
    setFeedbackSubmitting(true)
    try {
      if (feedbackHelpfulQuestion) {
        const question = troubleshootingState.questions.find(item => item.question_id === feedbackHelpfulQuestion)
        if (question?.template_key) {
          const memory = loadQuestionWeightMemory()
          const nextValue = Math.min(1.5, Number(memory[question.template_key] ?? 0.5) + 0.12)
          memory[question.template_key] = Number(nextValue.toFixed(4))
          saveQuestionWeightMemory(memory)
        }
      }
      if (troubleshootingState.doc_id) {
        await api.feedbackKnowledgeWeight({
          doc_id: troubleshootingState.doc_id,
          feedback_type: feedbackResolved ? 'helpful' : 'misleading',
          amount: feedbackResolved ? 1 : 1,
        })
      }
      const chosen = troubleshootingState.candidates.find(item => item.node_id === feedbackRootCause)
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: feedbackResolved
          ? `已记录本次排障反馈，知识库权重已更新。当前确认根因：${chosen?.name || '已解决'}。`
          : '已记录本次未解决反馈，知识库权重已做负向修正。',
      }])
      message.success(troubleshootingState.doc_id ? '反馈成功，知识库权重已更新' : '反馈已记录')
      setFeedbackOpen(false)
      setTroubleshootingOpen(false)
    } catch (e) {
      message.error(e.response?.data?.detail || e.message || '反馈失败')
    }
    setFeedbackSubmitting(false)
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

  const openNativeFullScreen = (data, mode = 'view') => {
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
    setFsNativeOpen(true)
    setTimeout(() => {
      try { fsLayerRef.current?.requestFullscreen?.() } catch {}
    }, 50)
  }

  const exitNativeFullScreen = () => {
    try { document.fullscreenElement && document.exitFullscreen() } catch {}
    setFsNativeOpen(false)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (fsNativeOpen && e.key === 'Escape') {
        try { document.fullscreenElement && document.exitFullscreen() } catch {}
        setFsNativeOpen(false)
      }
    }
    if (fsNativeOpen) {
      window.addEventListener('keydown', onKey)
    }
    return () => window.removeEventListener('keydown', onKey)
  }, [fsNativeOpen])

  useEffect(() => {
    if (fsOpen) {
      setTimeout(() => {
        try { fsWrapRef.current?.requestFullscreen?.() } catch {}
      }, 50)
    } else {
      try { document.fullscreenElement && document.exitFullscreen() } catch {}
    }
  }, [fsOpen, fsMode])

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
                      <Tag>权重: {m.meta?.manual_weight ?? manualWeight}%</Tag>
                      {m.meta?.doc_weight != null && <Tag color="blue">知识权重: {Math.round(Number(m.meta.doc_weight || 0.5) * 100)}%</Tag>}
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
                        <Button size="small" type="primary" onClick={() => openTroubleshooting(m)}>
                          帮我排查故障
                        </Button>
                        <Button size="small" onClick={() => openNativeFullScreen(m.result, 'view')}>系统全屏查看</Button>
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
      {fsNativeOpen && (
        <div 
          ref={fsLayerRef}
          style={{
            position: 'fixed', inset: 0, background: '#fff', zIndex: 9999,
            display: 'flex', flexDirection: 'column'
          }}
        >
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 600 }}>{fsTree?.top_event || '故障树'}</div>
            <Space>
              {fsMode === 'view' ? (
                <Button type="primary" onClick={() => setFsMode('edit')}>专家编辑</Button>
              ) : (
                <Button type="primary" loading={fsSaving} onClick={saveFullScreen}>保存</Button>
              )}
              <Button onClick={exitNativeFullScreen}>退出全屏</Button>
            </Space>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Suspense fallback={null}>
              {fsTree && fsMode === 'view' && <FaultTreeViewer tree={fsTree} height="calc(100vh - 56px)" />}
              {fsTree && fsMode === 'edit' && (
                <TreeEditor
                  ref={editorRef}
                  initialTree={fsTree}
                  onSave={() => {}}
                  onCancel={() => setFsMode('view')}
                />
              )}
            </Suspense>
          </div>
        </div>
      )}
      <Modal
        open={fsOpen}
        title={fsTree?.top_event || '故障树'}
        onCancel={() => setFsOpen(false)}
        width="96vw"
        style={{ top: 8 }}
        styles={{ body: { height: '78vh', overflow: 'auto' } }}
        footer={
          fsMode === 'view'
            ? [
                <Button key="exitfs" onClick={() => { try { document.fullscreenElement && document.exitFullscreen() } catch {} setFsOpen(false) }}>退出全屏</Button>,
                <Button key="close" onClick={() => setFsOpen(false)}>关闭</Button>,
                <Button key="edit" type="primary" onClick={() => setFsMode('edit')}>专家编辑</Button>,
              ]
            : [
                <Button key="exitfs" onClick={() => { try { document.fullscreenElement && document.exitFullscreen() } catch {} setFsOpen(false) }}>退出全屏</Button>,
                <Button key="cancel" onClick={() => setFsMode('view')}>取消</Button>,
                <Button key="save" type="primary" loading={fsSaving} onClick={saveFullScreen}>保存</Button>,
              ]
        }
      >
        <Suspense fallback={null}>
          <div ref={fsWrapRef} style={{ width: '100%', height: '100%', background: '#fff' }}>
            {fsTree && fsMode === 'view' && <FaultTreeViewer tree={fsTree} />}
            {fsTree && fsMode === 'edit' && (
              <TreeEditor
                ref={editorRef}
                initialTree={fsTree}
                onSave={() => {}}
                onCancel={() => setFsMode('view')}
              />
            )}
          </div>
        </Suspense>
      </Modal>
      <Modal
        open={troubleshootingOpen}
        title={troubleshootingState?.top_event ? `连续排查：${troubleshootingState.top_event}` : '连续排查'}
        onCancel={() => setTroubleshootingOpen(false)}
        width={920}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
            <Button onClick={() => setTroubleshootingOpen(false)}>关闭</Button>
            <Space>
              <Button type="primary" ghost onClick={() => setFeedbackOpen(true)}>
                问题已经解决，点击反馈结果
              </Button>
              <Button type="primary" onClick={submitTroubleshootingAnswer} disabled={!currentQuestion}>
                {troubleshootingState?.finished ? '已完成' : '提交本题并继续'}
              </Button>
            </Space>
          </div>
        }
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Progress
            percent={Math.round(((troubleshootingState?.answers?.length || 0) / Math.max(1, troubleshootingState?.questions?.length || 1)) * 100)}
            status={troubleshootingState?.finished ? 'success' : 'active'}
          />
          <Card size="small" title={currentQuestion ? `第 ${(troubleshootingState?.answers?.length || 0) + 1} 题（按权重优先）` : '排查结果'}>
            {currentQuestion ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap>
                  <Text strong>{currentQuestion.title}</Text>
                  <Tag color="red">问题权重 {Math.round(Number((currentCandidate?.score ?? currentQuestion.priority_score) || 0) * 100)}%</Tag>
                </Space>
                <Text type="secondary">{currentQuestion.description}</Text>
                <Radio.Group value={currentAnswer} onChange={(e) => setCurrentAnswer(e.target.value)}>
                  <Space direction="vertical">
                    {currentQuestion.options.map(option => (
                      <Radio key={option.value} value={option.value}>{option.label}</Radio>
                    ))}
                  </Space>
                </Radio.Group>
              </Space>
            ) : (
              <Text type="secondary">当前没有更多问题，建议查看右侧候选根因并提交反馈。</Text>
            )}
          </Card>
          <Divider style={{ margin: '4px 0' }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16 }}>
            <Card size="small" title="当前最可能根因">
              <List
                dataSource={topCandidates}
                locale={{ emptyText: '暂无候选根因' }}
                renderItem={(item, index) => (
                  <List.Item>
                    <div style={{ width: '100%' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <Text strong>{index + 1}. {item.name}</Text>
                        <Tag color={item.eliminated ? 'default' : index === 0 ? 'red' : 'blue'}>
                          {Math.round(item.score * 100)}%
                        </Tag>
                      </div>
                      <Space size={6} wrap style={{ margin: '6px 0' }}>
                        <Tag>重要度 {Math.round(item.importance_weight * 100)}%</Tag>
                        <Tag>症状匹配 {Math.round(item.symptom_weight * 100)}%</Tag>
                        <Tag>经验权重 {Math.round(item.memory_weight * 100)}%</Tag>
                      </Space>
                      <Text type="secondary">{item.description || '该节点暂无补充说明'}</Text>
                    </div>
                  </List.Item>
                )}
              />
            </Card>
            <Card size="small" title="排查轨迹">
              <List
                size="small"
                dataSource={troubleshootingState?.answers || []}
                locale={{ emptyText: '尚未回答问题' }}
                renderItem={(item) => {
                  const q = troubleshootingState?.questions?.find(v => v.question_id === item.question_id)
                  const ansText = item.answer === 'yes' ? '存在异常' : item.answer === 'no' ? '检查正常' : '暂不确定'
                  return <List.Item>{`${q?.title || item.question_id}：${ansText}`}</List.Item>
                }}
              />
            </Card>
          </div>
        </Space>
      </Modal>
      <Modal
        open={feedbackOpen}
        title="排障反馈"
        onCancel={() => setFeedbackOpen(false)}
        onOk={submitTroubleshootingFeedback}
        okText="提交反馈"
        confirmLoading={feedbackSubmitting}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>本次问题是否已解决</Text>
            <Radio.Group value={feedbackResolved} onChange={(e) => setFeedbackResolved(e.target.value)}>
              <Space>
                <Radio value>已解决</Radio>
                <Radio value={false}>未解决</Radio>
              </Space>
            </Radio.Group>
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>实际根因</Text>
            <Select
              style={{ width: '100%' }}
              value={feedbackRootCause}
              onChange={setFeedbackRootCause}
              placeholder="选择最终确认的根因"
              allowClear
              options={(troubleshootingState?.candidates || []).map(item => ({
                value: item.node_id,
                label: item.name,
              }))}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>最有帮助的问题</Text>
            <Select
              style={{ width: '100%' }}
              value={feedbackHelpfulQuestion}
              onChange={setFeedbackHelpfulQuestion}
              placeholder="选择最有帮助的一题"
              allowClear
              options={(troubleshootingState?.questions || []).map(item => ({
                value: item.question_id,
                label: item.title,
              }))}
            />
          </div>
          <Input.TextArea
            value={feedbackNote}
            onChange={(e) => setFeedbackNote(e.target.value)}
            placeholder="补充说明本次排障结果"
            autoSize={{ minRows: 3, maxRows: 5 }}
          />
          <Text type="secondary">
            {troubleshootingState?.doc_id ? '提交后将回写知识库权重。' : '当前未绑定知识文档，提交后仅记录结果提示，不回写文档权重。'}
          </Text>
        </Space>
      </Modal>
    </div>
  )
}
