import React, { useEffect, useMemo, useState, Suspense, lazy, useRef } from 'react'
import { Typography, Card, Input, Button, Space, Select, Badge, Slider, Tag, Modal, message, Popover } from 'antd'
import { ThunderboltOutlined, SendOutlined, SettingOutlined, CameraOutlined, PlusOutlined } from '@ant-design/icons'
import api from '../services/api.js'
import { generationStore } from '../services/generationStore.js'
import { dashboardStore } from '../services/dashboardStore.js'

const { Title, Text } = Typography
const FaultTreeViewer = lazy(() => import('../components/FaultTreeViewer.jsx'))
const TreeEditor = lazy(() => import('../components/TreeEditor.jsx'))
const QUESTION_WEIGHT_STORAGE_KEY = 'faulttreeai_troubleshooting_question_weights_v1'
const DASHBOARD_PIPELINE_STORAGE_KEY = 'faulttreeai_dashboard_pipeline_v1'

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

const sanitizeExampleInput = (raw, maxLen = 20) => {
  const src = String(raw || '').replace(/[\r\n\t]+/g, ' ').trim()
  if (!src) return ''
  const withoutBullets = src.replace(/^[\s•·\u2022\u25CF\u25A0\u25A1\u25E6\-–—]+/g, '')
  const withoutBrackets = withoutBullets
    .replace(/（[^）]{0,40}）/g, ' ')
    .replace(/\([^)]{0,40}\)/g, ' ')
    .replace(/【[^】]{0,40}】/g, ' ')
    .replace(/\[[^\]]{0,40}\]/g, ' ')
  const cleaned = withoutBrackets
    .replace(/[^0-9a-zA-Z\u4e00-\u9fff ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const compact = cleaned.replace(/\s+/g, '')
  const faultHints = [
    '故障', '异常', '报警', '失效', '损坏', '泄漏', '过热', '过温', '振动', '异响',
    '堵塞', '磨损', '卡滞', '偏差', '无法', '不能', '不启动', '不动作', '不亮',
    '短路', '断路', '跳闸', '停机', '压力不足', '温度过高', '噪声', '误报警', '动作缓慢',
  ]
  const solutionHints = [
    '检查', '确认', '确保', '更换', '清理', '维修', '修复', '调整', '校准', '紧固', '润滑',
    '重启', '测试', '测量', '插拔', '拆卸', '按压', '建议', '需要', '使用', '必须', '应当', '避免',
  ]
  const badPrefixes = ['确保', '确认', '如果', '当', '建议', '检查', '避免', '需要', '必须', '应当']
  const hasFaultHint = faultHints.some(k => compact.includes(k))
  if (!hasFaultHint) return ''
  const unsafeHints = [
    '人员伤亡', '危险电压', '触电', '安全须知', '注意事项', '警告',
    '操作说明', '使用说明', '说明书', '安装指南', '安装说明', '错误操作'
  ]
  if (unsafeHints.some(k => compact.includes(k))) return ''
  if (badPrefixes.some(p => compact.startsWith(p))) return ''
  if (solutionHints.some(k => compact.includes(k)) && !compact.includes('无法')) return ''

  const hasChinese = /[\u4e00-\u9fff]/.test(cleaned)
  const normalized = hasChinese ? cleaned.replace(/\s+/g, '') : cleaned
  const sliced = normalized.length > maxLen ? normalized.slice(0, maxLen).trim() : normalized
  if (sliced.length < 4) return ''
  return sliced
}

const buildExampleSuggestions = (items, limit = 8) => {
  const out = []
  const seen = new Set()
  const arr = Array.isArray(items) ? items : []
  for (const item of arr) {
    const v = sanitizeExampleInput(item)
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= limit) break
  }
  return out
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

const inferMachineFromText = (text) => {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const compact = raw.replace(/\s+/g, '').toUpperCase()
  if (compact.includes('1FT7')) return 'SIMOTICS S-1FT7'
  const m1 = raw.match(/^(.*?)(故障|异常|报警|报错|不工作|无法|不能|无反应|过热|异响|振动|吸力|充电|掉电|断电|停机|卡滞|堵塞)/)
  const head = String(m1?.[1] || '').trim()
  if (head && head.length <= 40) return head
  const m2 = raw.match(/([A-Za-z0-9][A-Za-z0-9\-\s]{2,30}\d)/)
  const code = String(m2?.[1] || '').trim()
  if (code) return code
  return ''
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

export default function Dashboard({ onNavigate, user, mobile }) {
  const [messages, setMessages] = useState(() => dashboardStore.getMessages())
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [docs, setDocs] = useState([])
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [pipelines, setPipelines] = useState([])
  const [selectedPipeline, setSelectedPipeline] = useState(() => {
    try {
      return (localStorage.getItem(DASHBOARD_PIPELINE_STORAGE_KEY) || '').trim() || '流水线1'
    } catch {
      return '流水线1'
    }
  })
  const [providers, setProviders] = useState([])
  const [selectedProvider, setSelectedProvider] = useState('minimax')
  const [manualWeight, setManualWeight] = useState(50)
  const [fsOpen, setFsOpen] = useState(false)
  const [fsMode, setFsMode] = useState('view') // view | edit
  const [fsTree, setFsTree] = useState(null)
  const [fsSaving, setFsSaving] = useState(false)
  const editorRef = useRef(null)
  const fsWrapRef = useRef(null)
  const [fsNativeOpen, setFsNativeOpen] = useState(false)
  const fsLayerRef = useRef(null)
  const [troubleshootingSessions, setTroubleshootingSessions] = useState({})
  const troubleshootingSessionsRef = useRef({})
  const [feedbackSubmittingSession, setFeedbackSubmittingSession] = useState(null)
  const bottomRef = useRef(null)
  const [clarifyDrafts, setClarifyDrafts] = useState({})      // { [clarifyId]: { [qid]: string } }
  const [clarifySubmitting, setClarifySubmitting] = useState(null) // 正在提交的 clarifyId
  const clarifyIdCounter = useRef(0)
  const pendingJobRef = useRef(null)

  // 订阅全局内存 store：切换页面后恢复对话历史
  useEffect(() => {
    const unsubscribe = dashboardStore.subscribe((storeMessages) => {
      setMessages(storeMessages)
    })
    return unsubscribe
  }, [])

  // 对话历史变化时同步到内存 store（刷新/重启后自动清空）
  useEffect(() => {
    dashboardStore.setMessages(messages)

    // 检查是否有正在进行的生成任务在页面切换期间已完成
    const typingMsg = messages.find(m => m.kind === 'typing' && m.id?.startsWith('typing_'))
    if (typingMsg?.id && typingMsg?.topEvent) {
      const job = generationStore.get(typingMsg.topEvent, typingMsg.answers)
      if (job?.status === 'completed') {
        finalizeGenerateResult(job.result, typingMsg.id)
      } else if (job?.status === 'error') {
        setMessages(prev => prev.map(m => (m.id === typingMsg.id
          ? { role: 'assistant', text: '生成失败：' + (job.error?.response?.data?.detail || job.error?.message || '未知错误') }
          : m
        )))
        setLoading(false)
      } else if (job?.status === 'running') {
        setLoading(true)
        job.promise
          .then(data => finalizeGenerateResult(data, typingMsg.id))
          .catch(e => setMessages(prev => prev.map(m => (m.id === typingMsg.id
            ? { role: 'assistant', text: '生成失败：' + (e?.response?.data?.detail || e?.message || '未知错误') }
            : m
          ))))
          .finally(() => setLoading(false))
      }
    }
  }, [messages])

  useEffect(() => {
    troubleshootingSessionsRef.current = troubleshootingSessions
  }, [troubleshootingSessions])

  const persistSession = (topEvent, answers, msgs) => {
    try {
      const source = msgs || dashboardStore.getMessages()
      if (!source || source.length === 0) return
      const clean = JSON.parse(JSON.stringify(source))
      api.saveSession({
        top_event: String(topEvent || '').trim(),
        answers: answers || {},
        messages: clean,
      }).catch(() => {})
    } catch {}
  }

  useEffect(() => {
    const loadDocs = async () => {
      if (String(user?.role || '') !== 'expert') {
        setDocs([])
        return
      }
      try {
        const data = await api.listDocuments()
        setDocs(Array.isArray(data) ? data : [])
      } catch {
        setDocs([])
      }
    }
    const loadPipelines = async () => {
      try {
        const vals = await api.listPipelines()
        const uniq = Array.from(new Set((Array.isArray(vals) ? vals : []).filter(Boolean)))
        if (uniq.length === 0) uniq.push('流水线1')
        setPipelines(uniq)
        if (!uniq.includes(selectedPipeline)) {
          setSelectedPipeline(uniq[0])
          try { localStorage.setItem(DASHBOARD_PIPELINE_STORAGE_KEY, uniq[0]) } catch {}
        }
      } catch {
        setPipelines(['流水线1'])
      }
    }
    const loadProviders = async () => {
      try {
        const data = await api.getProviders()
        const items = data.providers || []
        setProviders(items)
        const minimax = items.find(p => p.name === 'minimax' && p.available)
        const first = items.find(p => p.available)
        setSelectedProvider(minimax?.name || first?.name || data.primary || 'minimax')
      } catch {
        setProviders([])
        setSelectedProvider('minimax')
      }
    }
    loadDocs()
    loadPipelines()
    loadProviders()
  }, [user?.role])

  useEffect(() => {
    const applyPayload = (payload) => {
      const text = String(payload?.fault_description || '').trim()
      if (!text) return
      setInput(text)
      message.info('已从视觉识别结果填充故障描述')
    }

    const tryConsume = () => {
      try {
        const raw = sessionStorage.getItem('faulttreeai_pending_vision_to_generate')
        if (!raw) return
        const payload = JSON.parse(raw)
        sessionStorage.removeItem('faulttreeai_pending_vision_to_generate')
        applyPayload(payload)
      } catch {
      }
    }

    const onInject = (e) => {
      if (e?.detail) applyPayload(e.detail)
      tryConsume()
    }

    tryConsume()
    window.addEventListener('dashboard-inject', onInject)
    return () => window.removeEventListener('dashboard-inject', onInject)
  }, [])

  const fallbackSuggestions = useMemo(() => ([
    '设备通电后无法启动伴随异响',
    '电机运行过热触发保护',
    '伺服驱动器报警无法复位',
    '设备运行振动增大噪声变大',
    '设备无法开机电源指示灯不亮',
    '运行过程中频繁跳闸疑似短路',
    '气动系统压力不足动作缓慢',
    '传感器信号不稳定误报警频发',
  ]), [])

  const [suggestions, setSuggestions] = useState([])

  useEffect(() => {
    const load = async () => {
      try {
        const pipeline = (selectedPipeline || '').trim() || '流水线1'
        const list = await api.listKnowledgeItemSuggestions(pipeline, 12)
        const cleaned = buildExampleSuggestions(list, 8)
        setSuggestions(cleaned)
      } catch {
        setSuggestions([])
      }
    }
    if (messages.length === 0) load()
  }, [selectedPipeline, messages.length])

  useEffect(() => {
    try { localStorage.setItem(DASHBOARD_PIPELINE_STORAGE_KEY, (selectedPipeline || '').trim() || '流水线1') } catch {}
  }, [selectedPipeline])

  useEffect(() => {
    try {
      if (messages.length === 0) return
      bottomRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
    } catch {
    }
  }, [messages.length])

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
    if (!text || loading) return

    const normalized = text.replace(/\s+/g, '')
    const isTroubleshootingCmd = /^(帮我排查故障|排查故障|开始排查|继续排查|帮我排查)$/.test(normalized)
    if (isTroubleshootingCmd) {
      setMessages((prev) => {
        const lastTreeMsg = [...prev].reverse().find((m) => m?.result?.fault_tree || m?.result?.tree_id)
        if (!lastTreeMsg) {
          return [...prev, { role: 'user', text }, { role: 'assistant', text: '请先生成故障树，再开始排查。' }]
        }
        queueMicrotask(() => startTroubleshooting(lastTreeMsg))
        return [...prev, { role: 'user', text }]
      })
      setInput('')
      return
    }

    const now = Date.now()
    const typingId = `typing_${now}_${Math.random().toString(16).slice(2, 8)}`
    setMessages(prev => [...prev,
      { role: 'user', text },
      { role: 'assistant', kind: 'typing', id: typingId, topEvent: text, answers: {} }
    ])
    setInput('')
    setLoading(true)

    // —— 先查历史 clarify 缓存，命中则直接复用问题 ——
    try {
      const cached = await api.clarifyLookup(text)
      if (cached?.found && Array.isArray(cached.questions) && cached.questions.length > 0) {
        clarifyIdCounter.current += 1
        const clarifyId = `clarify_${now}_${clarifyIdCounter.current}`
        setMessages(prev => prev.map(m => (m.id === typingId ? {
          id: clarifyId,
          role: 'assistant',
          kind: 'clarification',
          top_event: text,
          questions: cached.questions,
          intro: String(cached?.raw_intro || '为了更精准地定位故障源，请补充以下信息：'),
          refined_query_hint: String(cached?.refined_query_hint || ''),
          provider: cached?.provider || null,
          cached: true,
          meta: {
            doc_id: selectedDoc || null,
            doc_weight: Number(docs.find(item => item.doc_id === selectedDoc)?.current_weight ?? 0.5),
            manual_weight: manualWeight,
            provider: selectedProvider || null,
          },
        } : m)))
        const initDraft = {}
        cached.questions.forEach(q => { initDraft[q.id] = '' })
        setClarifyDrafts(prev => ({ ...prev, [clarifyId]: initDraft }))
        setLoading(false)
        return
      }
    } catch (e) {
      // 缓存查询失败继续走 clarify
    }

    // —— 二次澄清流程：调用 /clarify 让 LLM 生成针对性问题 ——
    try {
      const clarifyResp = await api.clarifyProblem({
        top_event: text,
        doc_ids: selectedDoc ? [selectedDoc] : undefined,
        provider: selectedProvider || undefined,
        rag_top_k: 3,
        max_questions: 4,
      })
      const questions = Array.isArray(clarifyResp?.questions) ? clarifyResp.questions : []
      if (questions.length > 0) {
        clarifyIdCounter.current += 1
        const clarifyId = `clarify_${now}_${clarifyIdCounter.current}`
        // 用澄清卡片替换 typing 占位
        setMessages(prev => prev.map(m => (m.id === typingId ? {
          id: clarifyId,
          role: 'assistant',
          kind: 'clarification',
          top_event: text,
          questions,
          intro: String(clarifyResp?.raw_intro || '为了更精准地定位故障源，请补充以下信息：'),
          refined_query_hint: String(clarifyResp?.refined_query_hint || ''),
          provider: clarifyResp?.provider || null,
          cached: false,
          meta: {
            doc_id: selectedDoc || null,
            doc_weight: Number(docs.find(item => item.doc_id === selectedDoc)?.current_weight ?? 0.5),
            manual_weight: manualWeight,
            provider: selectedProvider || null,
          },
        } : m)))
        // 初始化草稿
        const initDraft = {}
        questions.forEach(q => { initDraft[q.id] = '' })
        setClarifyDrafts(prev => ({ ...prev, [clarifyId]: initDraft }))
        setLoading(false)
        return
      }
      // 没有问题就回退到直接生成
    } catch (e) {
      // 澄清失败也回退到直接生成
    }

    // —— 兜底：直接走排查步骤流程，不再直接生成故障树 ——
    await runStepsFlow(text, {}, [], typingId)
  }

  // 用输入 + 补充信息去匹配历史故障树
  const tryReuseFaultTree = async (topEvent, userPrompt, typingId) => {
    const lookupQuery = userPrompt ? `${topEvent}\n${userPrompt}` : topEvent
    try {
      const hit = await api.lookupFaultTree(lookupQuery)
      if (hit?.found && hit?.tree_id) {
        const reused = await api.getFaultTree(hit.tree_id)
        const selectedDocItem = docs.find(item => item.doc_id === selectedDoc)
        setMessages(prev => prev.map(m => (m.id === typingId ? {
          role: 'assistant',
          text: reused?.fault_tree?.analysis_summary || '已从历史记录匹配到故障树。',
          result: reused,
          meta: {
            doc_id: selectedDoc || null,
            doc_weight: Number(selectedDocItem?.current_weight ?? 0.5),
            manual_weight: manualWeight,
            provider: selectedProvider || null,
            reused: true,
            similarity: Number(hit?.similarity || 0),
          },
        } : m)))
        setLoading(false)
        return true
      }
    } catch {
      // lookup 失败继续生成
    }
    return false
  }

  // 把"直接生成故障树"的逻辑抽出来，方便 clarify 失败回退与跳过澄清时复用
  const finalizeGenerateResult = (data, typingId) => {
    const selectedDocItem = docs.find(item => item.doc_id === selectedDoc)
    let nextMessages = []
    let topEvent = ''
    let answers = {}
    setMessages(prev => {
      const typingMsg = prev.find(m => m.id === typingId)
      topEvent = typingMsg?.topEvent || ''
      answers = typingMsg?.answers || {}
      nextMessages = prev.map(m => (m.id === typingId ? {
        role: 'assistant',
        text: data?.fault_tree?.analysis_summary || '已生成故障树。',
        result: data,
        meta: {
          doc_id: selectedDoc || null,
          doc_weight: Number(selectedDocItem?.current_weight ?? 0.5),
          manual_weight: manualWeight,
          provider: selectedProvider || null,
        },
      } : m))
      return nextMessages
    })
    persistSession(topEvent, answers, nextMessages)
  }

  const generateFromTopEvent = async (topEvent, typingId, userPrompt = '', clarifyQuestions = null, clarifyAnswers = null) => {
    // 先尝试用完整信息复用历史记录（兼容旧逻辑）
    const reused = await tryReuseFaultTree(topEvent, userPrompt, typingId)
    if (reused) return

    const payload = {
      top_event: topEvent,
      user_prompt: userPrompt,
      rag_top_k: 5,
      use_fallback: true,
      provider: selectedProvider || undefined,
      doc_ids: selectedDoc ? [selectedDoc] : undefined,
      manual_weight: Math.max(0, Math.min(100, manualWeight)) / 100.0,
    }
    if (clarifyQuestions) {
      payload.clarify_questions = clarifyQuestions
    }
    if (clarifyAnswers) {
      payload.clarify_answers = clarifyAnswers
    }

    const promise = api.generateFaultTree(payload)
    generationStore.start(topEvent, clarifyAnswers, promise)
    pendingJobRef.current = { topEvent, answers: clarifyAnswers, typingId }

    try {
      const data = await promise
      finalizeGenerateResult(data, typingId)
    } catch (e) {
      setMessages(prev => prev.map(m => (m.id === typingId
        ? { role: 'assistant', text: '生成失败：' + (e.response?.data?.detail || e.message) }
        : m
      )))
    } finally {
      setLoading(false)
      pendingJobRef.current = null
    }
  }

  // 用户在澄清卡片上点"提交"
  const submitClarification = async (clarifyId) => {
    const clarifyMsg = messages.find(m => m.id === clarifyId)
    if (!clarifyMsg || clarifyMsg.kind !== 'clarification') return
    if (clarifySubmitting) return

    const draft = clarifyDrafts[clarifyId] || {}
    const questions = Array.isArray(clarifyMsg.questions) ? clarifyMsg.questions : []
    const missingRequired = questions.filter(q => q.required && !String(draft[q.id] || '').trim())
    if (missingRequired.length > 0) {
      message.warning(`请填写必填项：${missingRequired.map(q => q.text).join('；')}`)
      return
    }

    setClarifySubmitting(clarifyId)
    // 把答案组装成一段富文本 user_prompt
    const answerLines = []
    for (const q of questions) {
      const ans = String(draft[q.id] || '').trim()
      if (!ans) continue
      answerLines.push(`- ${q.text}\n  回答：${ans}`)
    }
    const enrichedPrompt = answerLines.length
      ? `原始描述：${clarifyMsg.top_event}\n\n补充信息：\n${answerLines.join('\n')}`
      : ''

    // 在消息流中追加一条用户消息（汇总用户填的内容）+ 一个 typing 占位
    const userSummary = answerLines.length
      ? answerLines.map(l => l.split('\n').map(s => s.trim()).filter(Boolean).join(' → ')).join('；')
      : '（未填写补充信息）'
    const typingId = `typing_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === clarifyId)
      if (idx < 0) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], submitted: true, submittedAnswers: draft }
      next.splice(idx + 1, 0,
        { role: 'user', text: userSummary },
        { role: 'assistant', kind: 'typing', id: typingId, topEvent: clarifyMsg.top_event, answers: draft }
      )
      return next
    })

    setLoading(true)

    await runStepsFlow(clarifyMsg.top_event, draft, questions, typingId, enrichedPrompt)
    setClarifySubmitting(null)
  }

  const finalizeStepsResult = (typingId, topEvent, answers, questions, steps, summary, reused = false, hitCount = 0, provider = null) => {
    const selectedDocItem = docs.find(item => item.doc_id === selectedDoc)
    let nextMessages = []
    setMessages(prev => {
      nextMessages = prev.map(m => (m.id === typingId ? {
        id: `steps_${typingId}`,
        role: 'assistant',
        kind: 'steps',
        top_event: topEvent,
        questions,
        answers,
        steps,
        summary,
        currentStep: 0,
        stepResults: [],
        finished: false,
        meta: {
          doc_id: selectedDoc || null,
          doc_weight: Number(selectedDocItem?.current_weight ?? 0.5),
          manual_weight: manualWeight,
          provider: selectedProvider || provider || null,
          reused,
          hit_count: hitCount,
        },
      } : m))
      return nextMessages
    })
    persistSession(topEvent, answers, nextMessages)
  }

  // 统一走“排查步骤”流程：先查历史 steps，命中则秒回，否则调用 LLM 生成
  const runStepsFlow = async (topEvent, answers, questions, typingId, userPrompt = '') => {
    try {
      const cachedSteps = await api.stepsLookup(topEvent, answers)
      if (cachedSteps?.found && Array.isArray(cachedSteps.steps) && cachedSteps.steps.length > 0) {
        finalizeStepsResult(typingId, topEvent, answers, questions, cachedSteps.steps, '', true, cachedSteps.hit_count)
        setLoading(false)
        return
      }
    } catch {
      // steps 查询失败继续生成
    }

    try {
      const stepsResp = await api.generateSteps({
        top_event: topEvent,
        user_prompt: userPrompt,
        doc_ids: selectedDoc ? [selectedDoc] : undefined,
        provider: selectedProvider || undefined,
        rag_top_k: 2,
        clarify_questions: questions,
        clarify_answers: answers,
      })
      finalizeStepsResult(typingId, topEvent, answers, questions, stepsResp?.steps || [], stepsResp?.summary || '', false, 0, stepsResp?.provider)
    } catch (e) {
      setMessages(prev => prev.map(m => (m.id === typingId
        ? { role: 'assistant', text: '生成排查步骤失败：' + (e.response?.data?.detail || e.message) }
        : m
      )))
    } finally {
      setLoading(false)
    }
  }

  const advanceStep = (msgId, result) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId || m.kind !== 'steps') return m
      const nextResults = [...(m.stepResults || []), { step: m.currentStep || 0, result }]
      const nextStep = (m.currentStep || 0) + 1
      const total = Array.isArray(m.steps) ? m.steps.length : 0
      return {
        ...m,
        stepResults: nextResults,
        currentStep: nextStep,
        finished: nextStep >= total,
      }
    }))
  }

  const generateTreeFromSteps = async (stepsMsgId) => {
    const stepsMsg = messages.find(m => m.id === stepsMsgId)
    if (!stepsMsg || stepsMsg.kind !== 'steps') return

    const typingId = `typing_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === stepsMsgId)
      if (idx < 0) return prev
      const next = [...prev]
      next.splice(idx + 1, 0,
        { role: 'user', text: '生成故障树' },
        { role: 'assistant', kind: 'typing', id: typingId, topEvent: stepsMsg.top_event, answers: stepsMsg.answers }
      )
      return next
    })
    setLoading(true)

    // 先按 top_event + 答案组合匹配历史诊断案例
    try {
      const diagnosis = await api.diagnosisLookup(stepsMsg.top_event, stepsMsg.answers)
      if (diagnosis?.found && diagnosis?.fault_tree) {
        const selectedDocItem = docs.find(item => item.doc_id === selectedDoc)
        setMessages(prev => prev.map(m => (m.id === typingId ? {
          role: 'assistant',
          text: diagnosis.fault_tree?.analysis_summary || '已从历史诊断案例匹配到故障树。',
          result: {
            tree_id: diagnosis.tree_id,
            fault_tree: diagnosis.fault_tree,
          },
          meta: {
            doc_id: selectedDoc || null,
            doc_weight: Number(selectedDocItem?.current_weight ?? 0.5),
            manual_weight: manualWeight,
            provider: selectedProvider || null,
            reused: true,
            hit_count: diagnosis.hit_count || 0,
          },
        } : m)))
        setLoading(false)
        return
      }
    } catch {
      // 诊断查询失败继续生成
    }

    const answerLines = []
    for (const q of (stepsMsg.questions || [])) {
      const ans = String((stepsMsg.answers || {})[q.id] || '').trim()
      if (!ans) continue
      answerLines.push(`- ${q.text}\n  回答：${ans}`)
    }
    const enrichedPrompt = answerLines.length
      ? `原始描述：${stepsMsg.top_event}\n\n补充信息：\n${answerLines.join('\n')}`
      : ''

    await generateFromTopEvent(stepsMsg.top_event, typingId, enrichedPrompt, stepsMsg.questions, stepsMsg.answers)
  }

  // 跳过澄清，直接走 steps 流程
  const skipClarification = async (clarifyId) => {
    const clarifyMsg = messages.find(m => m.id === clarifyId)
    if (!clarifyMsg || clarifyMsg.kind !== 'clarification') return
    if (clarifySubmitting) return
    setClarifySubmitting(clarifyId)
    const typingId = `typing_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === clarifyId)
      if (idx < 0) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], submitted: true, skipped: true }
      next.splice(idx + 1, 0, { role: 'user', text: '（跳过补充信息，直接生成排查步骤）' })
      next.splice(idx + 2, 0, { role: 'assistant', kind: 'typing', id: typingId, topEvent: clarifyMsg.top_event, answers: {} })
      return next
    })
    setLoading(true)

    await runStepsFlow(clarifyMsg.top_event, {}, clarifyMsg.questions || [], typingId)
    setClarifySubmitting(null)
  }

  const updateClarifyDraft = (clarifyId, qid, value) => {
    setClarifyDrafts(prev => ({
      ...prev,
      [clarifyId]: { ...(prev[clarifyId] || {}), [qid]: value },
    }))
  }

  // 从 hint 文本中提取可点击的示例选项（如 "如：A/B；C" → ["A","B","C"]）
  const parseHintOptions = (hint) => {
    if (!hint) return []
    const raw = String(hint).trim()
    // 去掉前缀 "如：" / "例如：" / "如"（兼容 LLM 输出带/不带冒号）
    let body = raw.replace(/^(如|例如)[：:\s]*/, '')
    if (!body) return []
    // 按 ；或 ; 分割，再按 / 或 、 分割（兼容中英文顿号/斜杠）
    return body.split(/[;；]/)
      .map(s => s.trim())
      .filter(Boolean)
      .flatMap(group =>
        group.split(/[/／\u3001]/).map(s => s.trim()).filter(Boolean)  // \u3001 = 顿号
      )
      .filter(s => s.length <= 30)  // 过滤过长的非选项文本
  }

  const rateFromDashboard = async (msgId, treeId, vote) => {
    if (!treeId) return
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, meta: { ...(m.meta || {}), ratingSubmitting: true } } : m)))
    try {
      await api.rateFaultTree(treeId, vote)
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, meta: { ...(m.meta || {}), rated: vote, ratingSubmitting: false } } : m)))
      message.success(vote === 'up' ? '已反馈：有用' : '已反馈：无用')
    } catch (e) {
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, meta: { ...(m.meta || {}), ratingSubmitting: false } } : m)))
      message.error(e?.response?.data?.detail || e?.message || '反馈失败')
    }
  }

  const composerSettings = (
    <div style={{ width: 520 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <div style={{ width: 72, fontSize: 12, color: '#666' }}>操作手册</div>
        <Select
          style={{ flex: 1 }}
          placeholder="选择已上传的操作手册..."
          value={selectedDoc}
          onChange={setSelectedDoc}
          allowClear
          options={docs.filter(d => d.status === 'active').map(d => ({ value: d.doc_id, label: d.filename }))}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <div style={{ width: 72, fontSize: 12, color: '#666' }}>模型</div>
        <Select
          style={{ flex: 1 }}
          value={selectedProvider}
          onChange={setSelectedProvider}
          options={providers.map(p => ({
            value: p.name,
            disabled: !p.available,
            label: (
              <Space>
                <span>{p.display_name || (String(p.name || '').slice(0, 1).toUpperCase() + String(p.name || '').slice(1))}</span>
                {p.model ? <Tag color="geekblue">{String(p.model)}</Tag> : null}
                <Badge status={p.available ? 'success' : 'error'} text={p.available ? '可用' : (p.reason || '不可用')} />
              </Space>
            )
          }))}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 72, fontSize: 12, color: '#666' }}>文档权重</div>
        <Slider
          style={{ flex: 1, minWidth: 220 }}
          value={manualWeight}
          onChange={setManualWeight}
          min={0}
          max={100}
          step={1}
          marks={{ 0: '0%', 50: '50%', 100: '100%' }}
        />
        <Tag color="geekblue" style={{ minWidth: 48, textAlign: 'center' }}>{manualWeight}%</Tag>
      </div>
    </div>
  )

  const createTroubleshootingMessage = (sessionId, state) => {
    const question = state?.questions?.find(item => item.question_id === state?.currentQuestionId) || null
    const candidate = state?.candidates?.find(item => item.node_id === question?.node_id) || null
    const topCandidates = (Array.isArray(state?.candidates) ? state.candidates : []).slice(0, 3)
    return {
      role: 'assistant',
      kind: state?.finished ? 'troubleshooting_done' : 'troubleshooting',
      session_id: sessionId,
      question_id: question?.question_id || null,
      question,
      candidate,
      top_candidates: topCandidates,
      meta: {
        doc_id: state?.doc_id || null,
        doc_weight: state?.doc_weight,
      },
    }
  }

  const startTroubleshooting = (messageItem) => {
    const state = buildTroubleshootingState(
      messageItem?.result,
      messageItem?.meta?.doc_id,
      messageItem?.meta?.doc_weight ?? 0.5
    )
    if (!state.questions.length) {
      message.warning('当前故障树暂无可用的连续排查问题')
      return
    }
    const sessionId = `TS_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    setTroubleshootingSessions(prev => ({ ...prev, [sessionId]: state }))
    setMessages(prev => [
      ...prev,
      { role: 'assistant', text: `开始排查：${state.top_event || '设备故障'}` },
      createTroubleshootingMessage(sessionId, state),
    ])
  }

  const answerLabel = (value) => {
    if (value === 'yes') return '是，存在异常'
    if (value === 'no') return '否，检查正常'
    return '暂不确定'
  }

  const submitTroubleshootingAnswer = (sessionId, answerValue) => {
    const session = troubleshootingSessionsRef.current?.[sessionId]
    if (!session || session.finished) return
    const question = session.questions.find(item => item.question_id === session.currentQuestionId)
    if (!question) return
    const nextState = applyTroubleshootingAnswer(session, answerValue)
    setTroubleshootingSessions(prev => ({ ...prev, [sessionId]: nextState }))
    setMessages(prev => [
      ...prev,
      { role: 'user', text: answerLabel(answerValue) },
      createTroubleshootingMessage(sessionId, nextState),
    ])
  }

  const submitTroubleshootingFinalFeedback = async (sessionId) => {
    const session = troubleshootingSessionsRef.current?.[sessionId]
    if (!session) return
    if (feedbackSubmittingSession) return

    const pipeline = (docs.find(d => d.doc_id === selectedDoc)?.pipeline || '流水线1').trim() || '流水线1'
    const candidates = Array.isArray(session.candidates) ? session.candidates : []
    const options = candidates
      .slice()
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 8)

    if (!options.length) {
      message.warning('当前排查会话没有可反馈的候选原因')
      return
    }

    let chosenNodeId = options[0]?.node_id
    let customRootCause = ''
    Modal.confirm({
      title: '反馈最终结果',
      content: (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 8, color: '#555' }}>请选择最终确认的根因（将更新知识库“问题→原因”的权重）</div>
          <div style={{ marginBottom: 8, fontSize: 12, color: '#888' }}>
            现象（自动）：{String(session.top_event || '').trim() || '设备故障'}
          </div>
          <Select
            style={{ width: '100%' }}
            defaultValue={chosenNodeId}
            options={options.map(o => ({ value: o.node_id, label: o.name }))}
            onChange={(v) => { chosenNodeId = v }}
          />
          <div style={{ marginTop: 12, marginBottom: 6, color: '#555' }}>可选：自定义根因/结论（用于补充或纠正）</div>
          <Input.TextArea
            allowClear
            placeholder="根因/结论（填写后将优先采用；不填则使用上面选择）"
            autoSize={{ minRows: 2, maxRows: 4 }}
            onChange={(e) => { customRootCause = e.target.value }}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>流水线：{pipeline}</div>
        </div>
      ),
      okText: '确认反馈',
      cancelText: '取消',
      onOk: async () => {
        const chosen = options.find(o => o.node_id === chosenNodeId) || options[0]
        const finalProblem = String(session.top_event || '').trim() || '设备故障'
        const finalRootCause = String(customRootCause || chosen?.name || '').trim()
        if (!finalRootCause) {
          message.warning('请输入根因/结论或选择一项候选原因')
          return Promise.reject(new Error('missing root cause'))
        }
        setFeedbackSubmittingSession(sessionId)
        try {
          const query = `${finalProblem} ${finalRootCause}`.trim()
          const resp = await api.searchKnowledgeItems({ query, pipeline, top_k: 8, knowledge_type: 'fault' })
          const results = Array.isArray(resp?.results) ? resp.results : []
          const best = results
            .map((r) => {
              const rootCause = String(r.root_cause || '')
              const problem = String(r.problem || '')
              const score = textOverlapScore(finalRootCause, rootCause) * 0.7 + textOverlapScore(finalProblem, problem) * 0.3
              return { r, score }
            })
            .sort((a, b) => b.score - a.score)[0]?.r

          if (!best?.item_id) {
            const fallbackDoc = docs.find(d => d.doc_id === selectedDoc)
            const filename = String(fallbackDoc?.filename || '')
            const fromTopEvent = inferMachineFromText(finalProblem)
            const fromFilename = (filename.replace(/\.[^.]+$/, '').match(/([\u4e00-\u9fffA-Za-z0-9\-\s]{2,40})(维修保养手册|维修手册|保养手册|用户手册|说明书)?/) || [])[1] || ''
            const inferredMachine = String(fromTopEvent || fromFilename || '').trim()
            const createResp = await api.createKnowledgeItem({
              pipeline,
              knowledge_type: 'fault',
              machine: inferredMachine,
              problem: finalProblem,
              root_cause: finalRootCause,
              solution: '',
              metadata: {
                source: 'troubleshooting_feedback_autocreate',
                tree_id: session.tree_id || null,
                node_id: chosen?.node_id || null,
                custom_root_cause: Boolean(String(customRootCause || '').trim()),
                machine_inferred_from: fromTopEvent ? 'top_event' : (fromFilename ? 'filename' : ''),
              }
            }, { enrich: 1 })
            const newItemId = createResp?.item_id
            if (!newItemId) {
              message.error('自动创建知识库条目失败')
              return
            }
            await api.feedbackKnowledgeItemWeight({ item_id: newItemId, feedback_type: 'helpful', amount: 1 })
            setMessages(prev => [...prev, { role: 'assistant', text: `未匹配到知识库条目，已自动创建并反馈：${finalProblem} → ${finalRootCause}。` }])
            message.success('已自动创建知识库条目并更新权重')
            return
          }

          await api.feedbackKnowledgeItemWeight({ item_id: best.item_id, feedback_type: 'helpful', amount: 1 })
          setMessages(prev => [...prev, { role: 'assistant', text: `已反馈最终结果：${finalProblem} → ${finalRootCause}，知识库权重已更新。` }])
          message.success('反馈成功，知识库权重已更新')
        } catch (e) {
          message.error(e.response?.data?.detail || e.message || '反馈失败')
        } finally {
          setFeedbackSubmittingSession(null)
        }
      }
    })
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

  const isMobile = !!mobile
  const openVision = (tab) => {
    onNavigate?.('vision')
    try {
      window.dispatchEvent(new CustomEvent('vision-open', { detail: { tab } }))
    } catch {
    }
  }
  const openMobileActions = () => {
    try {
      window.dispatchEvent(new CustomEvent('mobile-actions-open'))
    } catch {
    }
  }

  const mobileComposerHeight = 152

  return (
    <div className="page-container" style={{ height: isMobile ? '100%' : 'calc(100vh - 112px)', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', minHeight: 'auto', background: 'transparent' }}>
      <style>{`
        .chat-scroll::-webkit-scrollbar { width: 0; height: 0; }
        @keyframes chatDotPulse { 0%, 80%, 100% { opacity: .25; transform: translateY(0);} 40% { opacity: 1; transform: translateY(-2px);} }
      `}</style>
      <div className="chat-scroll" style={{ flex: 1, overflow: 'auto', padding: isMobile ? `10px 0 ${mobileComposerHeight + 16}px 0` : '12px 0 18px 0', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {messages.length === 0 ? (
          <div style={{ height: isMobile ? 'calc(100dvh - 260px)' : 'calc(100vh - 220px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#111' }}>有什么我能帮你的吗？</div>
              <div style={{ marginTop: 8, color: '#666' }}>从下方输入故障现象，我会生成故障树并提供排查建议</div>
            </div>
            <div style={{ maxWidth: 980, padding: '0 12px', display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
              {(suggestions.length > 0 ? suggestions : buildExampleSuggestions(fallbackSuggestions, 8)).map((s) => (
                <Button
                  key={s}
                  shape="round"
                  onClick={() => setInput(s)}
                  style={{ background: '#f5f5f5', borderColor: '#f0f0f0' }}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: 980, margin: '0 auto', padding: '0 12px' }}>
            <div style={{ marginBottom: 12 }}>
              <Title level={3} className="page-title" style={{ margin: 0 }}>对话</Title>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {messages.map((m, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '86%',
                    padding: 12,
                    borderRadius: 12,
                    background: m.role === 'user' ? '#e6f7ff' : '#fff',
                    border: '1px solid #f0f0f0'
                  }}>
                    {m.kind === 'typing' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <span style={{ width: 6, height: 6, borderRadius: 6, background: '#1677ff', display: 'inline-block', animation: 'chatDotPulse 1.1s infinite', animationDelay: '0s' }} />
                          <span style={{ width: 6, height: 6, borderRadius: 6, background: '#1677ff', display: 'inline-block', animation: 'chatDotPulse 1.1s infinite', animationDelay: '0.15s' }} />
                          <span style={{ width: 6, height: 6, borderRadius: 6, background: '#1677ff', display: 'inline-block', animation: 'chatDotPulse 1.1s infinite', animationDelay: '0.3s' }} />
                        </div>
                        <Text type="secondary">正在生成…</Text>
                      </div>
                    ) : null}
                    {m.kind === 'clarification' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                          <Text strong>{m.intro || '为了更精准地定位故障源，请补充以下信息：'}</Text>
                          <div style={{ marginTop: 4 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              针对故障现象「{m.top_event}」的关键澄清
                            </Text>
                          </div>
                        </div>
                        {(Array.isArray(m.questions) ? m.questions : []).map(q => {
                          const draft = clarifyDrafts[m.id] || {}
                          const val = draft[q.id] || ''
                          const disabled = !!m.submitted || clarifySubmitting === m.id
                          const options = parseHintOptions(q.hint)
                          return (
                            <div key={q.id} style={{ borderTop: '1px dashed #f0f0f0', paddingTop: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Text style={{ fontWeight: 500 }}>{q.text}</Text>
                                {q.required ? <Tag color="red" style={{ marginLeft: 4 }}>必填</Tag> : null}
                              </div>

                              {/* 可点击的示例选项 */}
                              {options.length > 0 && !disabled ? (
                                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                                  {options.map((opt, idx) => {
                                    const isSelected = val === opt
                                    return (
                                      <Tag.CheckableTag
                                        key={idx}
                                        checked={isSelected}
                                        onChange={() => {
                                          // 点击已选中则取消；否则填入选项值
                                          if (isSelected) {
                                            updateClarifyDraft(m.id, q.id, '')
                                          } else {
                                            updateClarifyDraft(m.id, q.id, opt)
                                          }
                                        }}
                                        style={{
                                          cursor: 'pointer',
                                          borderRadius: 6,
                                          padding: '2px 10px',
                                          fontSize: 13,
                                          transition: 'all 0.15s',
                                          ...(isSelected ? {
                                            background: '#1677ff',
                                            color: '#fff',
                                            borderColor: '#1677ff',
                                          } : {
                                            background: '#fafafa',
                                            color: '#555',
                                            border: '1px solid #e8e8e8',
                                          }),
                                        }}
                                      >
                                        {opt}
                                      </Tag.CheckableTag>
                                    )
                                  })}
                                </div>
                              ) : null}

                              <Input.TextArea
                                value={m.submitted ? (m.submittedAnswers?.[q.id] || '') : val}
                                onChange={e => updateClarifyDraft(m.id, q.id, e.target.value)}
                                placeholder="或自定义输入…"
                                autoSize={{ minRows: 1, maxRows: 3 }}
                                disabled={disabled}
                                style={{ marginTop: options.length > 0 ? 6 : 4, borderRadius: 8 }}
                              />
                            </div>
                          )
                        })}
                        {!m.submitted ? (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                            <Button size="small" onClick={() => skipClarification(m.id)} loading={clarifySubmitting === m.id}>
                              跳过，生成排查步骤
                            </Button>
                            <Button size="small" type="primary" onClick={() => submitClarification(m.id)} loading={clarifySubmitting === m.id}>
                              提交并生成排查步骤
                            </Button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <Tag color={m.skipped ? 'default' : 'green'}>
                              {m.skipped ? '已跳过' : '已提交，正在生成…'}
                            </Tag>
                          </div>
                        )}
                      </div>
                    ) : null}
                    {m.kind === 'steps' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                          <Text strong>建议排查步骤</Text>
                          <div style={{ marginTop: 4 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              针对「{m.top_event}」{m.meta?.reused ? `（命中历史记录，复用次数 ${m.meta?.hit_count || 0}）` : ''}
                              {Array.isArray(m.steps) && m.steps.length > 0 ? ` · 步骤 ${Math.min((m.currentStep || 0) + 1, m.steps.length)} / ${m.steps.length}` : ''}
                            </Text>
                          </div>
                        </div>
                        {m.summary && (m.currentStep || 0) === 0 && (
                          <div style={{ padding: 10, background: '#f6ffed', borderRadius: 8, border: '1px solid #b7eb8f' }}>
                            <Text style={{ whiteSpace: 'pre-wrap' }}>{m.summary}</Text>
                          </div>
                        )}
                        {(() => {
                          const steps = Array.isArray(m.steps) ? m.steps : []
                          const idx = Math.min(m.currentStep || 0, steps.length - 1)
                          const s = steps[idx]
                          if (!s) return null
                          return (
                            <div style={{ padding: 12, background: '#fafafa', borderRadius: 8, border: '1px solid #f0f0f0' }}>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                <Tag color="blue">步骤 {s.step || idx + 1}</Tag>
                                <Text strong style={{ fontSize: 15 }}>{s.title}</Text>
                              </div>
                              <div style={{ marginTop: 8 }}>
                                <Text style={{ whiteSpace: 'pre-wrap' }}>{s.action}</Text>
                              </div>
                              {s.expected && (
                                <div style={{ marginTop: 8, padding: 8, background: '#e6f7ff', borderRadius: 6 }}>
                                  <Text type="secondary" style={{ fontSize: 12 }}>预期结果：{s.expected}</Text>
                                </div>
                              )}
                              {s.decision && (
                                <div style={{ marginTop: 6 }}>
                                  <Text type="secondary" style={{ fontSize: 12 }}>决策：{s.decision}</Text>
                                </div>
                              )}
                              {s.note && (
                                <div style={{ marginTop: 6 }}>
                                  <Text type="warning" style={{ fontSize: 12 }}>注意：{s.note}</Text>
                                </div>
                              )}
                            </div>
                          )
                        })()}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            {(m.finished || (m.currentStep || 0) >= (Array.isArray(m.steps) ? m.steps.length : 0) - 1) ? (
                              <Button size="small" onClick={() => setMessages(prev => prev.map(x => x.id === m.id ? { ...x, resolved: true } : x))}>
                                问题已解决，无需生成
                              </Button>
                            ) : null}
                          </div>
                          <Space>
                            {!m.finished && (m.currentStep || 0) < (Array.isArray(m.steps) ? m.steps.length : 0) - 1 ? (
                              <>
                                <Text type="secondary" style={{ fontSize: 12 }}>这一步结果：</Text>
                                <Button size="small" onClick={() => advanceStep(m.id, 'normal')}>正常</Button>
                                <Button size="small" danger onClick={() => advanceStep(m.id, 'abnormal')}>异常</Button>
                                <Button size="small" type="primary" ghost onClick={() => advanceStep(m.id, 'unknown')}>不确定</Button>
                              </>
                            ) : (
                              <Button size="small" type="primary" onClick={() => generateTreeFromSteps(m.id)} loading={loading}>
                                生成故障树
                              </Button>
                            )}
                          </Space>
                        </div>
                      </div>
                    ) : null}
                    {m.kind === 'troubleshooting' || m.kind === 'troubleshooting_done' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                          <Text strong>帮你排查故障</Text>
                          <div style={{ marginTop: 4 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {m.question ? `当前问题：${m.question.title}` : '排查已结束，可直接反馈结果'}
                            </Text>
                          </div>
                        </div>
                        {m.question && (
                          <div>
                            <Text style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{m.question.description}</Text>
                            <div style={{ marginTop: 8 }}>
                              <Space wrap>
                                {m.question.options.map(opt => (
                                  <Button
                                    key={opt.value}
                                    size="small"
                                    type={opt.value === 'yes' ? 'primary' : 'default'}
                                    onClick={() => submitTroubleshootingAnswer(m.session_id, opt.value)}
                                    disabled={troubleshootingSessions?.[m.session_id]?.currentQuestionId !== m.question_id}
                                  >
                                    {opt.label}
                                  </Button>
                                ))}
                              </Space>
                            </div>
                          </div>
                        )}
                        {Array.isArray(m.top_candidates) && m.top_candidates.length > 0 && (
                          <div>
                            <Text type="secondary" style={{ fontSize: 12 }}>当前最可能根因：</Text>
                            <div style={{ marginTop: 6 }}>
                              <Space wrap>
                                {m.top_candidates.slice(0, 3).map(item => (
                                  <Tag key={item.node_id} color="red">
                                    {item.name} {Math.round(Number(item.score || 0) * 100)}%
                                  </Tag>
                                ))}
                              </Space>
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            onClick={() => submitTroubleshootingFinalFeedback(m.session_id)}
                            loading={feedbackSubmittingSession === m.session_id}
                          >
                            问题已解决，反馈结果
                          </Button>
                        </div>
                      </div>
                    ) : (
                      m.kind !== 'typing' ? <Text style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Text> : null
                    )}
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
                          <Space wrap>
                            <Button size="small" type="primary" onClick={() => startTroubleshooting(m)}>
                              帮我排查故障
                            </Button>
                            <Button size="small" onClick={() => openNativeFullScreen(m.result, 'view')}>系统全屏查看</Button>
                            <Button size="small" type="primary" onClick={() => openFullScreen(m.result, 'edit')}>主页专家编辑</Button>
                            <Button
                              size="small"
                              disabled={!!m.meta?.rated}
                              loading={!!m.meta?.ratingSubmitting}
                              onClick={() => rateFromDashboard(m.id, m.result?.tree_id, 'up')}
                            >
                              有用
                            </Button>
                            <Button
                              size="small"
                              disabled={!!m.meta?.rated}
                              loading={!!m.meta?.ratingSubmitting}
                              onClick={() => rateFromDashboard(m.id, m.result?.tree_id, 'down')}
                            >
                              无用
                            </Button>
                          </Space>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div style={{ padding: isMobile ? `10px 0 calc(10px + env(safe-area-inset-bottom)) 0` : '12px 0 18px 0', background: isMobile ? 'rgba(245,247,250,0.92)' : 'transparent', position: isMobile ? 'fixed' : 'static', left: isMobile ? 0 : undefined, right: isMobile ? 0 : undefined, bottom: isMobile ? 0 : undefined, zIndex: isMobile ? 1000 : undefined, backdropFilter: isMobile ? 'blur(10px)' : undefined }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '0 12px' }}>
          <Card className="glass-card" style={{ borderRadius: 16 }} styles={{ body: { padding: 12 } }}>
            {isMobile ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 2, WebkitOverflowScrolling: 'touch' }}>
                  <Button size="small" shape="round" icon={<ThunderboltOutlined />} onClick={() => setInput('设备运行异常')}>
                    快速
                  </Button>
                  <Button size="small" shape="round" onClick={() => onNavigate?.('manual')}>
                    规范手册
                  </Button>
                  <Button size="small" shape="round" onClick={() => onNavigate?.('knowledgeGraph')}>
                    数据云图
                  </Button>
                  <Select
                    size="small"
                    value={selectedPipeline}
                    onChange={setSelectedPipeline}
                    style={{ width: 120 }}
                    options={(pipelines.length ? pipelines : ['流水线1']).map(v => ({ value: v, label: v }))}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Button
                    type="text"
                    icon={<CameraOutlined style={{ fontSize: 20 }} />}
                    onClick={() => openVision('image')}
                    disabled={loading}
                    style={{ width: 40, height: 40 }}
                  />
                  <Input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onPressEnter={() => send()}
                    placeholder="发消息…"
                    disabled={loading}
                    style={{ borderRadius: 20, height: 40 }}
                    suffix={
                      <Button type="text" icon={<SendOutlined />} onClick={send} disabled={loading} style={{ width: 36, height: 36 }} />
                    }
                  />
                  <Button
                    type="text"
                    icon={<PlusOutlined style={{ fontSize: 22 }} />}
                    onClick={openMobileActions}
                    disabled={loading}
                    style={{ width: 40, height: 40 }}
                  />
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <Input.TextArea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send() } }}
                    placeholder="发消息…"
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    disabled={loading}
                    style={{ borderRadius: 12 }}
                  />
                  <Button type="primary" icon={<SendOutlined />} onClick={send} loading={loading} style={{ height: 40 }}>
                    发送
                  </Button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                  <Space size={8} wrap>
                    <Button size="small" icon={<ThunderboltOutlined />} onClick={() => setInput('设备运行异常')}>
                      快速
                    </Button>
                    <Select
                      size="small"
                      value={selectedPipeline}
                      onChange={setSelectedPipeline}
                      style={{ width: 124 }}
                      options={(pipelines.length ? pipelines : ['流水线1']).map(v => ({ value: v, label: v }))}
                    />
                  </Space>
                  <Popover content={composerSettings} trigger="click" placement="topRight">
                    <Button size="small" icon={<SettingOutlined />}>
                      设置
                    </Button>
                  </Popover>
                </div>
              </>
            )}
          </Card>
          {!isMobile && (
            <div style={{ marginTop: 10, textAlign: 'center', color: '#888', fontSize: 12 }}>
              Enter 发送，Shift+Enter 换行
            </div>
          )}
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
    </div>
  )
}
