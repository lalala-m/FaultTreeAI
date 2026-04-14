import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Typography, Space, Empty, Tag, AutoComplete, Button, message } from 'antd'
import ReactFlow, { Background, Controls, MiniMap, MarkerType, Handle, Position } from 'reactflow'
import 'reactflow/dist/style.css'
import './KnowledgeGraph.css'
import api from '../services/api.js'

const { Title, Text } = Typography
const FAULT_HINTS = ['故障', '异常', '报警', '失效', '损坏', '泄漏', '过热', '振动', '异响', '堵塞', '磨损', '卡滞', '偏差', '无法启动', '不启动', '无压力', '压力不足', '温度过高', '短路', '断路', '跳闸', '停机']
const SOLUTION_HINTS = ['检查', '更换', '清理', '维修', '修复', '调整', '校准', '紧固', '润滑', '复位', '重启', '测试', '确认', '处理', '排查', '连接', '检测', '冲洗', '清空', '取出', '冷却', '拆卸', '测量', '插拔', '送修', '购买', '装回']
const NOISE_TERMS = ['常见故障排查表', '技术参数', '定期保养计划', '安全须知', '产品结构图示', '分步维修指南', '每日', '每周', '每月', '每半年', '每年', '维修查询热线', '更新日期', '可能原因', '解决方法', '故障现象', '故障诊断', '手册', '目录']

const norm = (s) => String(s || '').replace(/[\s，。,.、；;：:【】\[\]()（）\-—_]+/g, '')
const isNoise = (s) => {
  const t = norm(s)
  return !t || NOISE_TERMS.some(n => t.includes(norm(n)))
}
const isGenericFault = (s) => {
  const v = String(s || '').trim()
  const t = norm(v)
  if (!t) return true
  const generic = ['故障', '设备故障', '设备异常', '系统故障', '系统异常', '电饭煲故障', '吸尘器故障', '传送带故障', '输送带故障', '电饭煲异常', '吸尘器异常', '传送带异常', '输送带异常']
  if (generic.some(g => norm(g) === t)) return true
  if (/^故障[0-9一二三四五六七八九十]+$/.test(v)) return true
  if (/^[0-9一二三四五六七八九十]+$/.test(v)) return true
  return false
}
const isFault = (s) => {
  const v = String(s || '')
  if (isNoise(v)) return false
  if (isGenericFault(v)) return false
  if (v.length < 2 || v.length > 30) return false
  if (/[，,。]/.test(v)) return false
  if (['若', '如果', '则', '需要', '请', '确认', '建议'].some(k => v.includes(k))) return false
  if (SOLUTION_HINTS.some(k => v.includes(k))) return false
  if (FAULT_HINTS.some(k => v.includes(k)) || ['无法开机', '吸力减弱', '异常噪音', '充电故障', '无法启动'].includes(v)) return true
  return /(无法|不能|不通电|无反应|不加热|不熟|煮糊|溢出|失灵|错误代码|吸力减弱|异常噪音|充电故障|不启动|无法充电|充不进电)/.test(v)
}
const isSolution = (s) => {
  const v = String(s || '')
  if (isNoise(v)) return false
  return SOLUTION_HINTS.some(k => v.includes(k))
}
const sanitizeDevices = (arr) => {
  const devs = Array.isArray(arr) ? arr : []
  const strict = devs.map(d => {
    const faults = (d.faults || []).filter(f => isFault(f.name)).map(f => ({
      name: f.name,
      solutions: (f.solutions || []).filter(isSolution),
    })).filter(f => f.solutions.length > 0)
    return { name: d.name, faults }
  }).filter(d => !isNoise(d.name) && (d.faults || []).length > 0)
  if (strict.length > 0) return strict
  return devs.map(d => {
    const faults = (d.faults || []).map(f => ({
      name: f.name,
      solutions: (f.solutions || []).filter(s => String(s || '').trim().length >= 2),
    })).filter(f => String(f.name || '').trim().length >= 2 && f.solutions.length > 0)
    return { name: d.name, faults }
  }).filter(d => String(d.name || '').trim().length >= 2 && d.faults.length > 0)
}

const inferDeviceFromFilename = (name) => {
  const n = String(name || '').replace(/\.[^.]+$/, '')
  const m = n.match(/([\u4e00-\u9fff]{2,20})(维修保养手册|维修手册|保养手册)?/)
  return (m && m[1]) ? m[1] : (n || '设备')
}

function CloudNode({ data }) {
  return (
    <div className={`cloud-node cloud-node--${data.kind || 'device'} ${data.hidden ? 'cloud-node--hidden' : 'cloud-node--visible'}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <div className="cloud-node__label">{data.label}</div>
    </div>
  )
}

const nodeTypes = { cloud: CloudNode }
const defaultEdgeOptions = { type: 'straight' }
const DEVICE_NODE_W = 220
const FAULT_NODE_W = 220
const SOLUTION_NODE_W = 260
const ringRadius = (count, nodeWidth, gap = 34, min = 220) => {
  const n = Math.max(1, Number(count) || 1)
  return Math.max(min, (n * (nodeWidth + gap)) / (2 * Math.PI))
}
const CENTER_X = 560
const CENTER_Y = 280
const DEVICE_NODE_H = 86
const SOLUTION_NODE_H = 96
const CLOUD_CENTER_Y_OFFSET = 34
const faultAngles = (count) => {
  const presets = [-150, -30, 30, 150, -120, 120, -60, 60, -170, 170]
  if (count <= presets.length) return presets.slice(0, count).map(d => (d * Math.PI) / 180)
  const arr = []
  for (let i = 0; i < count; i += 1) {
    let a = -Math.PI + (2 * Math.PI * i) / count
    if (Math.abs(Math.cos(a)) < 0.28) a += a > 0 ? 0.35 : -0.35
    arr.push(a)
  }
  return arr
}
const getDeviceRowPos = (allDevices, deviceId) => {
  const total = Math.max((allDevices || []).length, 1)
  const idx = (allDevices || []).findIndex((d) => `dev-${d.name}` === deviceId)
  const safeIdx = idx >= 0 ? idx : 0
  const step = Math.min(340, Math.max(240, 900 / Math.max(total - 1, 1)))
  const startX = CENTER_X - ((total - 1) * step) / 2
  return {
    x: startX + safeIdx * step,
    y: CENTER_Y,
  }
}

export default function KnowledgeGraph() {
  const [line, setLine] = useState('流水线1')
  const [lineInput, setLineInput] = useState('流水线1')
  const [pipelines, setPipelines] = useState([])
  const [devices, setDevices] = useState([])
  const [kbTree, setKbTree] = useState(null)
  const [graphMode, setGraphMode] = useState('legacy') // legacy | structured
  const [structuredNav, setStructuredNav] = useState({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
  const [structuredShowChildren, setStructuredShowChildren] = useState(true)
  const [expandDevices, setExpandDevices] = useState({})
  const [expandFaults, setExpandFaults] = useState({})
  const [rf, setRf] = useState(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [activeDeviceId, setActiveDeviceId] = useState(null)
  const [activeFaultId, setActiveFaultId] = useState(null)
  const [faultFocus, setFaultFocus] = useState(null) // { deviceId, faultIndex, side, anchorX, anchorY }
  const [focusDeviceId, setFocusDeviceId] = useState(null) // 点击后正在聚焦的设备
  const [transitionPhase, setTransitionPhase] = useState('idle') // idle | focusing | expanded | collapsing | faultFocusing | faultExpanded
  const [pinnedDevicePos, setPinnedDevicePos] = useState(null) // { deviceId, x, y }
  const rfRef = useRef(null)
  const idleViewportRef = useRef(null)
  const actionRef = useRef(0)
  const timersRef = useRef([])
  const flowWrapRef = useRef(null)
  const rafRef = useRef(null)
  const structuredAnchorRef = useRef(null)
  const clearTimers = () => {
    timersRef.current.forEach(t => clearTimeout(t))
    timersRef.current = []
  }
  const cancelRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }
  const beginAction = () => {
    actionRef.current += 1
    clearTimers()
    cancelRaf()
    return actionRef.current
  }
  const schedule = (actionId, fn, delayMs) => {
    const t = setTimeout(() => {
      if (actionRef.current !== actionId) return
      fn()
    }, delayMs)
    timersRef.current.push(t)
    return t
  }
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const easeInOutQuint = (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2)
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)
  const animateCenterZoom = (centerX, centerY, zoom, durationMs, easing = easeInOutCubic) => {
    const inst = rfRef.current
    if (!inst) return
    cancelRaf()
    const actionId = actionRef.current
    const wrap = flowWrapRef.current
    const rect = wrap?.getBoundingClientRect?.()
    const vp = inst.getViewport?.()
    const from = {
      x: Number.isFinite(vp?.x) ? vp.x : 0,
      y: Number.isFinite(vp?.y) ? vp.y : 0,
      zoom: Number.isFinite(vp?.zoom) ? vp.zoom : 1,
    }
    const w = Number.isFinite(rect?.width) ? rect.width : 0
    const h = Number.isFinite(rect?.height) ? rect.height : 0
    const to = {
      x: w ? (w / 2 - centerX * zoom) : from.x,
      y: h ? (h / 2 - centerY * zoom) : from.y,
      zoom,
    }
    const startTs = performance.now()
    const step = (now) => {
      if (actionRef.current !== actionId) return
      const t = Math.min(1, (now - startTs) / Math.max(1, durationMs || 1))
      const k = easing(t)
      const x = from.x + (to.x - from.x) * k
      const y = from.y + (to.y - from.y) * k
      const z = from.zoom + (to.zoom - from.zoom) * k
      inst.setViewport({ x, y, zoom: z }, { duration: 0 })
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(step)
  }
  const getNodePos = (nodeId, fallback) => {
    const inst = rfRef.current
    const n = inst?.getNode?.(nodeId)
    return n?.positionAbsolute || n?.position || fallback || { x: CENTER_X, y: CENTER_Y }
  }
  const restoreIdleViewport = (duration = 720) => {
    const inst = rfRef.current
    if (!inst) return
    const v = idleViewportRef.current
    if (v) {
      try {
        inst.setViewport(v, { duration })
        return
      } catch {}
    }
    try {
      inst.fitView({ duration, padding: 0.2 })
      idleViewportRef.current = inst.getViewport()
    } catch {}
  }

  const hashStr = (s) => {
    const v = String(s || '')
    let h = 5381
    for (let i = 0; i < v.length; i += 1) {
      h = ((h << 5) + h) ^ v.charCodeAt(i)
    }
    return (h >>> 0).toString(16)
  }
  const makeId = (prefix, parts) => `${prefix}-${hashStr(`${prefix}|${(parts || []).map(p => String(p || '')).join('|')}`)}`
  const keyOf = (s) => norm(s).toLowerCase()
  const treeCats = useMemo(() => {
    const cats = kbTree?.machine_categories
    return Array.isArray(cats) ? cats : []
  }, [kbTree])
  const findCat = (mcKey) => treeCats.find(c => keyOf(c?.name) === String(mcKey || '')) || null
  const findMachine = (cat, mKey) => {
    const ms = Array.isArray(cat?.machines) ? cat.machines : []
    return ms.find(m => keyOf(m?.name) === String(mKey || '')) || null
  }
  const findPc = (mach, pcKey) => {
    const pcs = Array.isArray(mach?.problem_categories) ? mach.problem_categories : []
    return pcs.find(p => keyOf(p?.name) === String(pcKey || '')) || null
  }
  const findProblem = (pc, pKey) => {
    const ps = Array.isArray(pc?.problems) ? pc.problems : []
    return ps.find(p => keyOf(p?.name) === String(pKey || '')) || null
  }
  const animateStructuredNav = (nextNav, focusId = null) => {
    const actionId = beginAction()
    setStructuredShowChildren(false)
    setStructuredNav(nextNav)
    schedule(actionId, () => setStructuredShowChildren(true), 160)
    const inst = rfRef.current
    if (inst && focusId) {
      schedule(actionId, () => {
        const p = getNodePos(focusId, { x: CENTER_X, y: CENTER_Y })
        const currentZoom = inst.getViewport?.().zoom
        const focusZoom = Number.isFinite(currentZoom) ? Math.min(1.28, currentZoom + 0.28) : 1.12
        requestAnimationFrame(() => animateCenterZoom(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, focusZoom, 980, easeOutCubic))
      }, 100)
    }
  }

  const handleFlowInit = (instance) => {
    rfRef.current = instance
    setRf(instance)
    setTimeout(() => {
      try {
        instance.fitView({ duration: 0, padding: 0.2 })
      } catch {}
      setTimeout(() => {
        try {
          idleViewportRef.current = instance.getViewport()
        } catch {}
      }, 0)
    }, 0)
  }

  useEffect(() => {
    return () => {
      clearTimers()
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const all = await api.listPipelines()
        const uniq = Array.from(new Set((all || []).filter(Boolean)))
        if (uniq.length === 0) uniq.push('流水线1')
        setPipelines(uniq)
        const chosen = uniq.includes(line) ? line : (uniq[0] || '流水线1')
        if (chosen !== line) setLine(chosen)
        setLineInput(chosen)
      } catch {
        setPipelines(['流水线1'])
        setLineInput(line || '流水线1')
      }
    }
    load()
  }, [])

  useEffect(() => {
    const load = async () => {
      const pipeline = (line || '').trim() || '流水线1'
      try {
        const data = await api.getKnowledgeGraph(pipeline)
        const tree = data?.kb_tree?.machine_categories ? data.kb_tree : null
        if (tree?.machine_categories?.length) {
          setGraphMode('structured')
          setKbTree(tree)
          setDevices([])
          setStructuredNav({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
          setStructuredShowChildren(true)
        } else {
          setGraphMode('legacy')
          setKbTree(null)
          let next = sanitizeDevices(data?.devices)
          if ((!next || next.length === 0) && (data?.doc_count || 0) > 0) {
            const docs = await api.listDocuments()
            const byPipe = (Array.isArray(docs) ? docs : []).filter(d => (d.pipeline || '流水线1') === pipeline && d.status === 'active')
            next = byPipe.slice(0, 8).map(d => ({
              name: inferDeviceFromFilename(d.filename),
              faults: [{ name: '设备运行异常', solutions: ['请在知识库中补充“故障现象-解决方法”段落后重建图谱'] }]
            }))
          }
          setDevices(next)
          setStructuredNav({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
          setStructuredShowChildren(true)
        }
        setExpandDevices({})
        setExpandFaults({})
        setActiveDeviceId(null)
        setActiveFaultId(null)
        setFaultFocus(null)
        setFocusDeviceId(null)
        setPinnedDevicePos(null)
        setTransitionPhase('idle')
        setTimeout(() => {
          restoreIdleViewport(0)
        }, 0)
      } catch {
        setDevices([])
        setKbTree(null)
        setGraphMode('legacy')
        setStructuredNav({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
        setStructuredShowChildren(true)
      }
    }
    load()
  }, [line])

  const handleRebuild = async () => {
    try {
      setRebuilding(true)
      const ret = await api.rebuildKnowledgeGraph((line || '').trim() || '流水线1')
      message.success(`重建完成：成功 ${ret.rebuilt || 0}，失败 ${ret.failed || 0}`)
      const data = await api.getKnowledgeGraph((line || '').trim() || '流水线1')
      const tree = data?.kb_tree?.machine_categories ? data.kb_tree : null
      if (tree?.machine_categories?.length) {
        setGraphMode('structured')
        setKbTree(tree)
        setDevices([])
        setStructuredNav({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
        setStructuredShowChildren(true)
      } else {
        setGraphMode('legacy')
        setKbTree(null)
        let next = sanitizeDevices(data?.devices)
        if ((!next || next.length === 0) && (data?.doc_count || 0) > 0) {
          const docs = await api.listDocuments()
          const byPipe = (Array.isArray(docs) ? docs : []).filter(d => (d.pipeline || '流水线1') === line && d.status === 'active')
          next = byPipe.slice(0, 8).map(d => ({
            name: inferDeviceFromFilename(d.filename),
            faults: [{ name: '设备运行异常', solutions: ['请在知识库中补充“故障现象-解决方法”段落后重建图谱'] }]
          }))
        }
        setDevices(next)
        setStructuredNav({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
        setStructuredShowChildren(true)
      }
      setExpandDevices({})
      setExpandFaults({})
      setActiveDeviceId(null)
      setActiveFaultId(null)
      setFaultFocus(null)
      setFocusDeviceId(null)
      setPinnedDevicePos(null)
      setTransitionPhase('idle')
      setTimeout(() => {
        restoreIdleViewport(0)
      }, 0)
      message.info(`当前图谱：${data?.source === 'knowledge_items' ? '结构化知识库' : '文档知识'} / 版本 ${data?.version || '-'}`)
    } catch (e) {
      message.error('重建失败: ' + (e.response?.data?.detail || e.message))
    }
    setRebuilding(false)
  }

  const buildStructuredFlow = useMemo(() => {
    if (graphMode !== 'structured') return null
    if (!treeCats.length) return null
    const ns = []
    const es = []
    const level = structuredNav.level || 'mc'
    const mcKey = structuredNav.mcKey
    const mKey = structuredNav.mKey
    const pcKey = structuredNav.pcKey
    const pKey = structuredNav.pKey

    const nodeIdSet = new Set()
    const edgeIdSet = new Set()

    const addNode = (id, label, kind, x, y, hidden, extra) => {
      if (!id) return
      if (nodeIdSet.has(id)) return
      nodeIdSet.add(id)
      ns.push({
        id,
        type: 'cloud',
        data: { label, kind, hidden: !!hidden, ...(extra || {}) },
        position: { x, y },
        draggable: false,
        style: hidden ? { opacity: 0, pointerEvents: 'none' } : undefined,
      })
    }
    const addEdge = (src, dst, stroke) => {
      if (!src || !dst) return
      const id = `e-${src}-${dst}`
      if (edgeIdSet.has(id)) return
      edgeIdSet.add(id)
      es.push({ id, source: src, target: dst, animated: true, style: { stroke: stroke || '#91caff' }, markerEnd: { type: MarkerType.ArrowClosed } })
    }

    const uniqByKey = (items, getKey, getName) => {
      const map = new Map()
      for (const it of Array.isArray(items) ? items : []) {
        const k = String(getKey(it) || '')
        if (!k) continue
        const nm = String(getName(it) || '').trim()
        const prev = map.get(k)
        if (!prev) {
          map.set(k, it)
          continue
        }
        const prevName = String(getName(prev) || '').trim()
        if (nm.length > prevName.length) map.set(k, it)
      }
      return Array.from(map.entries()).map(([k, it]) => ({ it, key: k }))
    }

    const catPairs = uniqByKey(treeCats, (c) => keyOf(c?.name) || keyOf('通用设备'), (c) => String(c?.name || '').trim() || '通用设备')
    const cats = catPairs.map(({ it, key }) => ({ name: String(it?.name || '').trim() || '通用设备', key, raw: it }))
    const catStep = Math.min(360, Math.max(240, 1000 / Math.max(cats.length - 1, 1)))
    const catStartX = CENTER_X - ((cats.length - 1) * catStep) / 2
    const pipelineId = makeId('pipe', [line])
    const anchor = structuredAnchorRef.current
    const base = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? anchor : { x: CENTER_X, y: CENTER_Y }
    const baseCenter = { x: base.x + DEVICE_NODE_W / 2, y: base.y + CLOUD_CENTER_Y_OFFSET }

    if (level === 'mc' || !mcKey) {
      addNode(pipelineId, line, 'pipeline', CENTER_X, CENTER_Y, false, { level: 'pipe' })
      const center = { x: CENTER_X + DEVICE_NODE_W / 2, y: CENTER_Y + CLOUD_CENTER_Y_OFFSET }
      const ring = ringRadius(cats.length || 1, DEVICE_NODE_W, 54, 300)
      const angles = faultAngles(Math.max(cats.length, 1))
      cats.forEach((c, idx) => {
        const a = angles[idx] ?? ((Math.PI * 2 * idx) / Math.max(cats.length, 1))
        const x = center.x + Math.cos(a) * ring - DEVICE_NODE_W / 2
        const y = center.y + Math.sin(a) * ring - CLOUD_CENTER_Y_OFFSET
        const id = makeId('mc', [c.key])
        addNode(id, c.name, 'device', x, y, false, { level: 'mc', key: c.key })
        addEdge(pipelineId, id, '#91caff')
      })
      return { nodes: ns, edges: es }
    }

    const selectedCat = findCat(mcKey)
    const selectedCatName = String(selectedCat?.name || '').trim() || cats.find(c => c.key === mcKey)?.name || '通用设备'
    const catId = makeId('mc', [mcKey])

    addNode(catId, selectedCatName, 'device', base.x, base.y, false, { level: 'mc', key: mcKey })

    const machines = Array.isArray(selectedCat?.machines) ? selectedCat.machines : []
    const mPairs = uniqByKey(
      machines,
      (m) => keyOf(m?.name) || keyOf('设备'),
      (m) => String(m?.name || '').trim() || '设备'
    )
    const mItems = mPairs.map(({ it, key }) => ({ name: String(it?.name || '').trim() || '设备', key, raw: it })).slice(0, 18)

    if (level === 'm' || !mKey) {
      const ring = ringRadius(mItems.length || 1, DEVICE_NODE_W, 54, 280)
      const angles = faultAngles(Math.max(mItems.length, 1))
      mItems.forEach((m, i) => {
        const a = angles[i] ?? ((Math.PI * 2 * i) / Math.max(mItems.length, 1))
        const x = baseCenter.x + Math.cos(a) * ring - DEVICE_NODE_W / 2
        const y = baseCenter.y + Math.sin(a) * ring - CLOUD_CENTER_Y_OFFSET
        const id = makeId('m', [mcKey, m.key])
        addNode(id, m.name, 'device', x, y, !structuredShowChildren, { level: 'm', mcKey, key: m.key })
        addEdge(catId, id, '#91caff')
      })
      return { nodes: ns, edges: es }
    }

    const selectedMachine = findMachine(selectedCat, mKey)
    const selectedMachineName = String(selectedMachine?.name || '').trim() || mItems.find(m => m.key === mKey)?.name || '设备'
    const machId = makeId('m', [mcKey, mKey])
    addNode(machId, selectedMachineName, 'device', base.x, base.y, false, { level: 'm', mcKey, key: mKey })

    const pcs = Array.isArray(selectedMachine?.problem_categories) ? selectedMachine.problem_categories : []
    const pcPairs = uniqByKey(pcs, (p) => keyOf(p?.name) || keyOf('问题类别'), (p) => String(p?.name || '').trim() || '问题类别')
    const pcItems = pcPairs.map(({ it, key }) => ({ name: String(it?.name || '').trim() || '问题类别', key, raw: it })).slice(0, 18)

    if (level === 'pc' || !pcKey) {
      const ring = ringRadius(pcItems.length || 1, FAULT_NODE_W, 54, 300)
      const angles = faultAngles(Math.max(pcItems.length, 1))
      pcItems.forEach((pc, i) => {
        const a = angles[i] ?? ((Math.PI * 2 * i) / Math.max(pcItems.length, 1))
        const x = baseCenter.x + Math.cos(a) * ring - FAULT_NODE_W / 2
        const y = baseCenter.y + Math.sin(a) * ring - CLOUD_CENTER_Y_OFFSET
        const id = makeId('pc', [mcKey, mKey, pc.key])
        addNode(id, pc.name, 'fault', x, y, !structuredShowChildren, { level: 'pc', mcKey, mKey, key: pc.key })
        addEdge(machId, id, '#ffd666')
      })
      return { nodes: ns, edges: es }
    }

    const selectedPc = findPc(selectedMachine, pcKey)
    const selectedPcName = String(selectedPc?.name || '').trim() || pcItems.find(p => p.key === pcKey)?.name || '问题类别'
    const pcId = makeId('pc', [mcKey, mKey, pcKey])
    addNode(pcId, selectedPcName, 'fault', base.x, base.y, false, { level: 'pc', mcKey, mKey, key: pcKey })

    const problems = Array.isArray(selectedPc?.problems) ? selectedPc.problems : []
    const pPairs = uniqByKey(problems, (p) => keyOf(p?.name) || keyOf('问题'), (p) => String(p?.name || '').trim() || '问题')
    const pItems = pPairs.map(({ it, key }) => ({ name: String(it?.name || '').trim() || '问题', key, raw: it })).slice(0, 18)

    if (level === 'p' || !pKey) {
      const ring = ringRadius(pItems.length || 1, FAULT_NODE_W, 54, 320)
      const angles = faultAngles(Math.max(pItems.length, 1))
      pItems.forEach((p, i) => {
        const a = angles[i] ?? ((Math.PI * 2 * i) / Math.max(pItems.length, 1))
        const x = baseCenter.x + Math.cos(a) * ring - FAULT_NODE_W / 2
        const y = baseCenter.y + Math.sin(a) * ring - CLOUD_CENTER_Y_OFFSET
        const id = makeId('p', [mcKey, mKey, pcKey, p.key])
        addNode(id, p.name, 'fault', x, y, !structuredShowChildren, { level: 'p', mcKey, mKey, pcKey, key: p.key })
        addEdge(pcId, id, '#ffd666')
      })
      return { nodes: ns, edges: es }
    }

    const selectedProblem = findProblem(selectedPc, pKey)
    const selectedProblemName = String(selectedProblem?.name || '').trim() || pItems.find(p => p.key === pKey)?.name || '问题'
    const probId = makeId('p', [mcKey, mKey, pcKey, pKey])
    addNode(probId, selectedProblemName, 'fault', base.x, base.y, false, { level: 'p', mcKey, mKey, pcKey, key: pKey })

    const roots = Array.isArray(selectedProblem?.root_causes) ? selectedProblem.root_causes : []
    const rootPairs = uniqByKey(roots, (r) => keyOf(r), (r) => String(r || '').trim())
    const rootItems = rootPairs.map(({ it }) => String(it || '').trim()).filter(Boolean).slice(0, 12)
    const ring = ringRadius(rootItems.length || 1, SOLUTION_NODE_W, 34, 260)
    const angles = faultAngles(Math.max(rootItems.length, 1))
    rootItems.forEach((r, i) => {
      const a = angles[i] ?? ((Math.PI * 2 * i) / Math.max(rootItems.length, 1))
      const x = baseCenter.x + Math.cos(a) * ring - SOLUTION_NODE_W / 2
      const y = baseCenter.y + Math.sin(a) * ring - CLOUD_CENTER_Y_OFFSET
      const id = makeId('rc', [mcKey, mKey, pcKey, pKey, r])
      addNode(id, r, 'solution', x, y, !structuredShowChildren, { level: 'rc', mcKey, mKey, pcKey, pKey, key: keyOf(r) })
      addEdge(probId, id, '#95de64')
    })
    return { nodes: ns, edges: es }
  }, [graphMode, treeCats, structuredNav, structuredShowChildren])

  useEffect(() => {
    if (graphMode !== 'structured') return
    if ((structuredNav?.level || 'mc') !== 'mc') return
    if (structuredNav?.mcKey) return
    const inst = rfRef.current
    if (!inst) return
    setTimeout(() => {
      try {
        inst.fitView({ duration: 0, padding: 0.18 })
      } catch {}
      setTimeout(() => {
        try {
          idleViewportRef.current = inst.getViewport()
        } catch {}
      }, 0)
    }, 0)
  }, [graphMode, line, treeCats.length, structuredNav?.level, structuredNav?.mcKey])

  const { nodes, edges } = useMemo(() => {
    if (graphMode === 'structured' && buildStructuredFlow) return buildStructuredFlow
    const ns = []
    const es = []
    if ((transitionPhase === 'faultFocusing' || transitionPhase === 'faultExpanded') && faultFocus) {
      const dev = devices.find(d => `dev-${d.name}` === faultFocus.deviceId)
      const fault = (dev?.faults || [])[faultFocus.faultIndex]
      if (dev && fault) {
        const side = faultFocus.side === 'right' ? 'right' : 'left'
        const faultId = `fault-${dev.name}-${faultFocus.faultIndex}`
        const ax = Number.isFinite(faultFocus.anchorX) ? faultFocus.anchorX : CENTER_X
        const ay = Number.isFinite(faultFocus.anchorY) ? faultFocus.anchorY : CENTER_Y
        ns.push({
          id: faultId,
          type: 'cloud',
          data: { label: fault.name, kind: 'fault', hidden: false, deviceId: faultFocus.deviceId, faultIndex: faultFocus.faultIndex, side },
          position: { x: ax, y: ay },
          draggable: false
        })
        if (transitionPhase === 'faultExpanded') {
          const devX = ax + (side === 'right' ? -360 : 360)
          const solX = ax + (side === 'right' ? 360 : -360)
          const devId = `dev-${dev.name}`
          ns.push({
            id: devId,
            type: 'cloud',
            data: { label: dev.name, kind: 'device', hidden: false },
            position: { x: devX, y: ay },
            draggable: false
          })
          es.push({ id: `e-${devId}-${faultId}`, source: devId, target: faultId, animated: true, style: { stroke: '#faad14' }, markerEnd: { type: MarkerType.ArrowClosed } })
          const sols = fault.solutions || []
          const startY = ay - ((sols.length - 1) * 120) / 2
          sols.forEach((s, i) => {
            const solId = `sol-${dev.name}-${faultFocus.faultIndex}-${i}`
            ns.push({
              id: solId,
              type: 'cloud',
              data: { label: s, kind: 'solution', hidden: false },
              position: { x: solX, y: startY + i * 120 },
              draggable: false
            })
            es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' }, markerEnd: { type: MarkerType.ArrowClosed } })
          })
        }
      }
      return { nodes: ns, edges: es }
    }
    const basePosById = new Map()
    devices.forEach((d) => {
      basePosById.set(`dev-${d.name}`, getDeviceRowPos(devices, `dev-${d.name}`))
    })
    devices.forEach((d, i) => {
      const devId = `dev-${d.name}`
      const base = basePosById.get(devId) || { x: CENTER_X, y: CENTER_Y }
      const showOnlyFocused = transitionPhase === 'focusing' || transitionPhase === 'expanded' || transitionPhase === 'collapsing'
      const isVisible = showOnlyFocused ? devId === focusDeviceId : true
      if (!isVisible) return
      const x = base.x
      const y = base.y
      const isPinned = pinnedDevicePos && pinnedDevicePos.deviceId === devId
      const px = isPinned ? pinnedDevicePos.x : x
      const py = isPinned ? pinnedDevicePos.y : y
      ns.push({
        id: devId,
        type: 'cloud',
        data: { label: d.name, kind: 'device', hidden: false },
        position: { x: px, y: py },
        draggable: false
      })
      if (transitionPhase === 'expanded' && activeDeviceId === devId) {
        const fxCenter = px
        const fyCenter = py
        const faults = d.faults || []
        const faultRing = ringRadius(faults.length || 1, FAULT_NODE_W, 54, 320)
        const angles = faultAngles(Math.max(faults.length, 1))
        ;faults.forEach((f, fi) => {
          const fAngle = angles[fi] ?? ((Math.PI * 2 * fi) / Math.max(faults.length, 1))
          const fx = fxCenter + Math.cos(fAngle) * faultRing
          const fy = fyCenter + Math.sin(fAngle) * faultRing
          const faultId = `fault-${d.name}-${fi}`
          ns.push({
            id: faultId,
            type: 'cloud',
            data: { label: f.name, kind: 'fault', hidden: false, deviceId: devId, faultIndex: fi, side: fx >= fxCenter ? 'right' : 'left' },
            position: { x: fx, y: fy },
            draggable: false
          })
          es.push({ id: `e-${devId}-${faultId}`, source: devId, target: faultId, animated: true, style: { stroke: '#faad14' }, markerEnd: { type: MarkerType.ArrowClosed } })
          if (activeFaultId === faultId) {
            const solutions = f.solutions || []
            const sRadius = ringRadius(solutions.length || 1, SOLUTION_NODE_W, 24, 210)
            ;solutions.forEach((s, si) => {
              const sAngle = (Math.PI * 2 * si) / Math.max(solutions.length, 1) - Math.PI / 2
              const sx = fx + Math.cos(sAngle) * sRadius
              const sy = fy + Math.sin(sAngle) * sRadius
              const solId = `sol-${d.name}-${fi}-${si}`
              ns.push({
                id: solId,
                type: 'cloud',
                data: { label: s, kind: 'solution', hidden: false },
                position: { x: sx, y: sy },
                draggable: false
              })
              es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' }, markerEnd: { type: MarkerType.ArrowClosed } })
            })
          }
        })
      }
    })
    return { nodes: ns, edges: es }
  }, [graphMode, buildStructuredFlow, devices, activeDeviceId, activeFaultId, focusDeviceId, transitionPhase, faultFocus, pinnedDevicePos])

  const onNodeClick = (_, node) => {
    if (graphMode === 'structured') {
      const d = node?.data || {}
      const lv = d.level
      const actionId = beginAction()
      const inst = rfRef.current
      const centerOn = (id, zoom = 1.06) => {
        if (!inst || !id) return
        schedule(actionId, () => {
          const p = getNodePos(id, node.positionAbsolute || node.position)
          inst.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { zoom, duration: 820 })
        }, 0)
      }
      if (lv === 'mc') {
        const mcKey = d.key
        if (structuredNav.level === 'm' && structuredNav.mcKey === mcKey) {
          animateStructuredNav({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
          schedule(actionId, () => inst?.fitView?.({ duration: 680, padding: 0.2 }), 40)
          return
        }
        animateStructuredNav({ level: 'm', mcKey, mKey: null, pcKey: null, pKey: null }, makeId('mc', [mcKey]))
        return
      }
      if (lv === 'pipe') {
        rfRef.current?.fitView?.({ duration: 680, padding: 0.2 })
        return
      }
      if (lv === 'm') {
        const mcKey = d.mcKey
        const mKey = d.key
        if (structuredNav.level === 'pc' && structuredNav.mcKey === mcKey && structuredNav.mKey === mKey) {
          animateStructuredNav({ level: 'm', mcKey, mKey: null, pcKey: null, pKey: null }, makeId('m', [mcKey, mKey]))
          return
        }
        animateStructuredNav({ level: 'pc', mcKey, mKey, pcKey: null, pKey: null }, makeId('m', [mcKey, mKey]))
        return
      }
      if (lv === 'pc') {
        const mcKey = d.mcKey
        const mKey = d.mKey
        const pcKey = d.key
        if (structuredNav.level === 'p' && structuredNav.mcKey === mcKey && structuredNav.mKey === mKey && structuredNav.pcKey === pcKey) {
          animateStructuredNav({ level: 'pc', mcKey, mKey, pcKey: null, pKey: null }, makeId('pc', [mcKey, mKey, pcKey]))
          return
        }
        animateStructuredNav({ level: 'p', mcKey, mKey, pcKey, pKey: null }, makeId('pc', [mcKey, mKey, pcKey]))
        return
      }
      if (lv === 'p') {
        const mcKey = d.mcKey
        const mKey = d.mKey
        const pcKey = d.pcKey
        const pKey = d.key
        if (structuredNav.level === 'rc' && structuredNav.mcKey === mcKey && structuredNav.mKey === mKey && structuredNav.pcKey === pcKey && structuredNav.pKey === pKey) {
          animateStructuredNav({ level: 'p', mcKey, mKey, pcKey, pKey: null }, makeId('p', [mcKey, mKey, pcKey, pKey]))
          return
        }
        animateStructuredNav({ level: 'rc', mcKey, mKey, pcKey, pKey }, makeId('p', [mcKey, mKey, pcKey, pKey]))
        return
      }
      return
    }
    if (node.id.startsWith('dev-')) {
      const actionId = beginAction()
      const isSameExpandedDevice = transitionPhase === 'expanded' && activeDeviceId === node.id && !faultFocus
      if (isSameExpandedDevice) {
        setActiveDeviceId(null)
        setActiveFaultId(null)
        setFaultFocus(null)
        setFocusDeviceId(null)
        setPinnedDevicePos(null)
        setTransitionPhase('idle')
        restoreIdleViewport(720)
        return
      }
      const fromFaultScene = transitionPhase === 'faultFocusing' || transitionPhase === 'faultExpanded'
      const nextSelected = node.id
      if (rfRef.current) {
        if (nextSelected) {
          const currentZoom = rfRef.current?.getViewport?.().zoom
          const focusZoom = Number.isFinite(currentZoom) ? Math.min(1.12, currentZoom + 0.28) : 1.12
          if (fromFaultScene) {
            const p0 = node.positionAbsolute || node.position
            animateCenterZoom(p0.x + DEVICE_NODE_W / 2, p0.y + CLOUD_CENTER_Y_OFFSET, focusZoom, 680)
            schedule(actionId, () => {
              setFaultFocus(null)
              setActiveFaultId(null)
              setActiveDeviceId(null)
              setPinnedDevicePos({ deviceId: node.id, x: p0.x, y: p0.y })
              setFocusDeviceId(node.id)
              setTransitionPhase('focusing')
            }, 680)
            schedule(actionId, () => {
              setActiveDeviceId(node.id)
              setActiveFaultId(null)
              setTransitionPhase('expanded')
              const device = devices.find(d => `dev-${d.name}` === node.id)
              const faultCount = Math.max((device?.faults || []).length, 1)
              const targetZoom = faultCount <= 3 ? 0.98 : faultCount <= 5 ? 0.9 : 0.82
              schedule(actionId, () => {
                const p1 = getNodePos(node.id, p0)
                animateCenterZoom(p1.x + DEVICE_NODE_W / 2, p1.y + CLOUD_CENTER_Y_OFFSET, targetZoom, 760)
              }, 40)
            }, 720)
          } else {
            const p0 = getNodePos(node.id, node.positionAbsolute || node.position)
            animateCenterZoom(p0.x + DEVICE_NODE_W / 2, p0.y + CLOUD_CENTER_Y_OFFSET, focusZoom, 680)
            schedule(actionId, () => {
              setPinnedDevicePos(null)
              setFocusDeviceId(node.id)
              setTransitionPhase('focusing')
            }, 680)
            schedule(actionId, () => {
              setActiveDeviceId(node.id)
              setActiveFaultId(null)
              setTransitionPhase('expanded')
              const device = devices.find(d => `dev-${d.name}` === node.id)
              const faultCount = Math.max((device?.faults || []).length, 1)
              const targetZoom = faultCount <= 3 ? 0.98 : faultCount <= 5 ? 0.9 : 0.82
              schedule(actionId, () => {
                const p1 = getNodePos(node.id, p0)
                animateCenterZoom(p1.x + DEVICE_NODE_W / 2, p1.y + CLOUD_CENTER_Y_OFFSET, targetZoom, 760)
              }, 40)
            }, 720)
          }
        }
      }
      if (!rfRef.current) {
        setFaultFocus(null)
        setActiveDeviceId(nextSelected)
        setActiveFaultId(null)
        setFocusDeviceId(nextSelected)
        setPinnedDevicePos(null)
        setTransitionPhase('expanded')
      }
      return
    }
    if (node.id.startsWith('fault-') && transitionPhase === 'expanded') {
      const actionId = beginAction()
      const sameFault = faultFocus && faultFocus.deviceId === node.data?.deviceId && faultFocus.faultIndex === node.data?.faultIndex
      if (sameFault) {
        setFaultFocus(null)
        setActiveFaultId(null)
        setTransitionPhase('expanded')
        const devId = node.data?.deviceId
        if (devId && rfRef.current) {
          schedule(actionId, () => {
            const p = getNodePos(devId, null)
            rfRef.current?.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { duration: 520 })
          }, 0)
        }
        return
      }
      const p = node.positionAbsolute || node.position
      if (rfRef.current) {
        const currentZoom = rfRef.current?.getViewport?.().zoom
          const focusZoom = Number.isFinite(currentZoom) ? Math.min(1.28, currentZoom + 0.26) : 1.12
        animateCenterZoom(p.x + FAULT_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, focusZoom, 620)
        schedule(actionId, () => {
          setActiveFaultId(node.id)
          setFaultFocus({
            deviceId: node.data?.deviceId,
            faultIndex: node.data?.faultIndex,
            side: node.data?.side || 'right',
            anchorX: p.x,
            anchorY: p.y
          })
          setTransitionPhase('faultExpanded')
          const dev = devices.find(d => `dev-${d.name}` === node.data?.deviceId)
          const fault = (dev?.faults || [])[node.data?.faultIndex]
          const solCount = Math.max((fault?.solutions || []).length, 1)
          const targetZoom = solCount <= 2 ? 1.0 : solCount <= 4 ? 0.94 : solCount <= 6 ? 0.88 : 0.82
          schedule(actionId, () => {
            animateCenterZoom(p.x + FAULT_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, targetZoom, 760)
          }, 40)
        }, 660)
      }
      return
    }
    if (rfRef.current) {
      const p = node.positionAbsolute || node.position
      const kind = node.data?.kind || 'device'
      const w = kind === 'solution' ? SOLUTION_NODE_W : DEVICE_NODE_W
      const h = kind === 'solution' ? SOLUTION_NODE_H : DEVICE_NODE_H
      if (!node.id.startsWith('dev-') && transitionPhase !== 'faultFocusing') {
        beginAction()
        rfRef.current.setCenter(p.x + w / 2, p.y + (kind === 'solution' ? h / 2 : CLOUD_CENTER_Y_OFFSET), { zoom: 1.16, duration: 620 })
      }
    }
  }

  const onPaneClick = () => {
    if (graphMode !== 'structured') return
    const nav = structuredNav
    if (nav.level === 'mc') return
    if (nav.level === 'm') {
      animateStructuredNav({ level: 'mc', mcKey: null, mKey: null, pcKey: null, pKey: null })
      rfRef.current?.fitView?.({ duration: 680, padding: 0.2 })
      return
    }
    if (nav.level === 'pc') {
      animateStructuredNav({ level: 'm', mcKey: nav.mcKey, mKey: null, pcKey: null, pKey: null }, makeId('mc', [nav.mcKey]))
      return
    }
    if (nav.level === 'p') {
      animateStructuredNav({ level: 'pc', mcKey: nav.mcKey, mKey: nav.mKey, pcKey: null, pKey: null }, makeId('m', [nav.mcKey, nav.mKey]))
      return
    }
    if (nav.level === 'rc') {
      animateStructuredNav({ level: 'p', mcKey: nav.mcKey, mKey: nav.mKey, pcKey: nav.pcKey, pKey: null }, makeId('pc', [nav.mcKey, nav.mKey, nav.pcKey]))
    }
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 16 }}>
        <Title level={3} className="page-title">数据云图</Title>
        <Text type="secondary">{graphMode === 'structured' ? '按结构化知识库条目结构展示' : '先展示设备，点击设备展开故障，点击故障展开解决方案'}</Text>
      </div>

      <Card className="glass-card" style={{ marginBottom: 16 }}>
        <Space wrap align="start" style={{ width: '100%' }}>
          <div style={{ minWidth: 260 }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>查看流水线</Text>
            <AutoComplete
              style={{ width: 160 }}
              value={lineInput}
              options={pipelines.map(p => ({ value: p }))}
              onSearch={setLineInput}
              onSelect={(v) => {
                const nv = (v || '').trim() || '流水线1'
                setLineInput(nv)
                setLine(nv)
              }}
              filterOption={(inputValue, option) => (option?.value || '').toLowerCase().includes(inputValue.toLowerCase())}
              onBlur={() => {
                const nv = (lineInput || '').trim() || '流水线1'
                if (nv !== line) setLine(nv)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const nv = (lineInput || '').trim() || '流水线1'
                  if (nv !== line) setLine(nv)
                }
              }}
            />
            <div style={{ marginTop: 8 }}>
              <Tag color="blue">{line}</Tag>
              <Tag>{graphMode === 'structured' ? '结构化知识' : `${devices.length} 个设备`}</Tag>
            </div>
          </div>
          <Button type="primary" onClick={handleRebuild} loading={rebuilding}>
            重建当前流水线数据
          </Button>
        </Space>
      </Card>

      <Card className="glass-card" styles={{ body: { padding: 0 } }}>
        {nodes.length === 0 ? (
          <div style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              description={
                graphMode === 'structured'
                  ? `当前${line}暂无可展示的结构化条目（请先“整理历史/清理无用”，并确保“问题”和“导致原因”不为空）`
                  : `当前${line}暂无可展示的设备图谱`
              }
            />
          </div>
        ) : (
          <div ref={flowWrapRef} style={{ height: 560 }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              onInit={handleFlowInit}
              nodeTypes={nodeTypes}
              defaultEdgeOptions={defaultEdgeOptions}
              fitView={graphMode !== 'structured'}
              fitViewOptions={{ padding: 0.2 }}
            >
              {graphMode !== 'structured' && <MiniMap />}
              <Controls />
              <Background />
            </ReactFlow>
          </div>
        )}
      </Card>
    </div>
  )
}
