import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Typography, Space, Empty, message, Select } from 'antd'
import './KnowledgeGraph.css'
import api from '../services/api.js'
import PixiCloudGraph from '../components/PixiCloudGraph.jsx'

const { Title, Text } = Typography
const FAULT_HINTS = ['故障', '异常', '报警', '失效', '损坏', '泄漏', '过热', '振动', '异响', '堵塞', '磨损', '卡滞', '偏差', '无法启动', '不启动', '无压力', '压力不足', '温度过高', '短路', '断路', '跳闸', '停机']
const SOLUTION_HINTS = ['检查', '更换', '清理', '维修', '修复', '调整', '校准', '紧固', '润滑', '复位', '重启', '测试', '确认', '处理', '排查', '连接', '检测', '冲洗', '清空', '取出', '冷却', '拆卸', '测量', '插拔', '送修', '购买', '装回']
const NOISE_TERMS = ['常见故障排查表', '技术参数', '定期保养计划', '安全须知', '产品结构图示', '分步维修指南', '每日', '每周', '每月', '每半年', '每年', '维修查询热线', '更新日期', '可能原因', '解决方法', '故障现象', '故障诊断', '手册', '目录']

const norm = (s) => String(s || '').replace(/[\s，。,.、；;：:【】\[\]()（）\-—_]+/g, '')
const keyOf = (s) => norm(s).toLowerCase()
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

const ALL_PIPELINES_VALUE = '__all__'
const ALL_PIPELINES_LABEL = '全部流水线'

const mergeDevices = (groups) => {
  const deviceMap = new Map()
  ;(Array.isArray(groups) ? groups : []).forEach((group) => {
    sanitizeDevices(group).forEach((device) => {
      const dKey = keyOf(device.name) || device.name
      if (!deviceMap.has(dKey)) {
        deviceMap.set(dKey, { name: device.name, faults: new Map() })
      }
      const bucket = deviceMap.get(dKey)
      ;(device.faults || []).forEach((fault) => {
        const fKey = keyOf(fault.name) || fault.name
        if (!bucket.faults.has(fKey)) {
          bucket.faults.set(fKey, { name: fault.name, solutions: [] })
        }
        const targetFault = bucket.faults.get(fKey)
        ;(fault.solutions || []).forEach((solution) => {
          const sv = String(solution || '').trim()
          if (sv && !targetFault.solutions.includes(sv)) targetFault.solutions.push(sv)
        })
      })
    })
  })
  return Array.from(deviceMap.values()).map((device) => ({
    name: device.name,
    faults: Array.from(device.faults.values()),
  }))
}

const devicesToMachineCategories = (devices, categoryName = '通用设备') => {
  const safeDevices = sanitizeDevices(devices)
  if (!safeDevices.length) return []
  return [{
    name: categoryName,
    machines: safeDevices.map((device) => ({
      name: device.name,
      problem_categories: [{
        name: '常见问题',
        problems: (device.faults || []).map((fault) => ({
          name: fault.name,
          root_causes: (fault.solutions || []).slice(0, 8),
        })),
      }],
    })),
  }]
}

const buildFallbackDevicesFromDocs = (docs, pipeline) => {
  const safePipeline = String(pipeline || '').trim() || '流水线1'
  const byPipe = (Array.isArray(docs) ? docs : []).filter((d) => {
    const docPipeline = String(d?.pipeline || '流水线1').trim() || '流水线1'
    return docPipeline === safePipeline && d?.status === 'active'
  })
  return byPipe.slice(0, 8).map((d, index) => {
    const inferredName = String(inferDeviceFromFilename(d?.filename) || '').trim()
    const safeName = inferredName.length >= 2 && !/^\d+$/.test(inferredName)
      ? inferredName
      : `${safePipeline}设备${index + 1}`
    return {
      name: safeName,
    faults: [{ name: '设备运行异常', solutions: ['请在知识库中补充“故障现象-解决方法”段落后重建图谱'] }],
    }
  })
}

const DEVICE_NODE_W = 200
const FAULT_NODE_W = 220
const SOLUTION_NODE_W = 240
const ringRadius = (count, nodeWidth, gap = 34, min = 220) => {
  const n = Math.max(1, Number(count) || 1)
  return Math.max(min, (n * (nodeWidth + gap)) / (2 * Math.PI))
}
const CENTER_X = 560
const CENTER_Y = 280
const PIXI_DEVICE_W = 220
const PIXI_DEVICE_H = 86
const DEVICE_NODE_H = 78
const SOLUTION_NODE_H = 88
const CLOUD_CENTER_Y_OFFSET = 34
const STRUCTURED_CHILDREN_DELAY = 260
const STRUCTURED_NAV_DELAY = 140
const STRUCTURED_NAV_DURATION = 1000
const DEVICE_FOCUS_DURATION = 400
const DEVICE_EXPAND_DELAY = 400
const DEVICE_EXPAND_ZOOM_DURATION = 1000
const DEVICE_COLLAPSE_DURATION = 820
const FAULT_FOCUS_DURATION = 400
const FAULT_EXPAND_DELAY = 400
const FAULT_EXPAND_ZOOM_DURATION = 1000
const GENERIC_CENTER_DURATION = 1000
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
const getOverviewRowPos = (items, index) => {
  const total = Math.max((items || []).length, 1)
  const safeIdx = Math.max(0, Number(index) || 0)
  const step = Math.min(320, Math.max(220, 860 / Math.max(total - 1, 1)))
  const startX = CENTER_X - ((total - 1) * step) / 2
  return {
    x: startX + safeIdx * step,
    y: CENTER_Y,
  }
}
const hashUnit = (s) => {
  const v = String(s || '')
  let h = 0
  for (let i = 0; i < v.length; i += 1) h = (h * 31 + v.charCodeAt(i)) >>> 0
  return (h % 1000) / 1000
}

export default function KnowledgeGraph() {
  const [line, setLine] = useState(ALL_PIPELINES_VALUE)
  const [pipelines, setPipelines] = useState([])
  const [devices, setDevices] = useState([])
  const [kbTree, setKbTree] = useState(null)
  const [graphMode, setGraphMode] = useState('legacy') // legacy | structured
  const visualPreset = 'v2'
  const [structuredNav, setStructuredNav] = useState({ level: 'm', mKey: null, pKey: null })
  const [structuredShowChildren, setStructuredShowChildren] = useState(true)
  const [expandDevices, setExpandDevices] = useState({})
  const [expandFaults, setExpandFaults] = useState({})
  const [rf, setRf] = useState(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [activeDeviceId, setActiveDeviceId] = useState(null)
  const [activeFaultId, setActiveFaultId] = useState(null)
  const [faultFocus, setFaultFocus] = useState(null) // { deviceId, faultIndex, side, anchorX, anchorY }
  const [focusDeviceId, setFocusDeviceId] = useState(null) // 点击后正在聚焦的设备
  const [transitionPhase, setTransitionPhase] = useState('idle') // idle | focusing | expanded | collapsing | faultFocusing | faultExpanded | structuredFocusing | pipelineReturning | pipelineFocusing
  const [pinnedDevicePos, setPinnedDevicePos] = useState(null) // { deviceId, x, y }
  const [structuredFocus, setStructuredFocus] = useState(null) // { id, kind, mKey, pKey?, label }
  const [structuredPinnedPos, setStructuredPinnedPos] = useState(null) // { x, y }
  const rfRef = useRef(null)
  const idleViewportRef = useRef(null)
  const actionRef = useRef(0)
  const timersRef = useRef([])
  const flowWrapRef = useRef(null)
  const rafRef = useRef(null)
  const structuredAnchorRef = useRef(null)
  const pixiFrameRef = useRef(null)
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
  const animateStructuredNodeTo = (fromPos, toPos, durationMs, onDone) => {
    cancelRaf()
    const actionId = actionRef.current
    const start = {
      x: Number.isFinite(fromPos?.x) ? fromPos.x : CENTER_X,
      y: Number.isFinite(fromPos?.y) ? fromPos.y : CENTER_Y,
    }
    const target = {
      x: Number.isFinite(toPos?.x) ? toPos.x : CENTER_X,
      y: Number.isFinite(toPos?.y) ? toPos.y : CENTER_Y,
    }
    const dx = target.x - start.x
    const dy = target.y - start.y
    const distance = Math.hypot(dx, dy)
    if (distance <= 0.5) {
      setStructuredPinnedPos({ x: target.x, y: target.y })
      onDone?.()
      return
    }
    const durationSec = Math.max(0.001, (durationMs || 1) / 1000)
    const speed = distance / durationSec
    const ux = dx / distance
    const uy = dy / distance
    const startTs = performance.now()
    const step = (now) => {
      if (actionRef.current !== actionId) return
      const elapsedSec = Math.max(0, (now - startTs) / 1000)
      const travel = Math.min(distance, speed * elapsedSec)
      setStructuredPinnedPos({
        x: start.x + ux * travel,
        y: start.y + uy * travel,
      })
      if (travel < distance) {
        rafRef.current = requestAnimationFrame(step)
        return
      }
      rafRef.current = null
      onDone?.()
    }
    rafRef.current = requestAnimationFrame(step)
  }
  const animatePinnedNodeTo = (nodeId, fromPos, toPos, durationMs, onDone) => {
    cancelRaf()
    const actionId = actionRef.current
    const start = {
      x: Number.isFinite(fromPos?.x) ? fromPos.x : CENTER_X,
      y: Number.isFinite(fromPos?.y) ? fromPos.y : CENTER_Y,
    }
    const target = {
      x: Number.isFinite(toPos?.x) ? toPos.x : CENTER_X,
      y: Number.isFinite(toPos?.y) ? toPos.y : CENTER_Y,
    }
    const dx = target.x - start.x
    const dy = target.y - start.y
    const distance = Math.hypot(dx, dy)
    if (distance <= 0.5) {
      setPinnedDevicePos({ deviceId: nodeId, x: target.x, y: target.y })
      onDone?.()
      return
    }
    const durationSec = Math.max(0.001, (durationMs || 1) / 1000)
    const speed = distance / durationSec
    const ux = dx / distance
    const uy = dy / distance
    const startTs = performance.now()
    const step = (now) => {
      if (actionRef.current !== actionId) return
      const elapsedSec = Math.max(0, (now - startTs) / 1000)
      const travel = Math.min(distance, speed * elapsedSec)
      const nextX = start.x + ux * travel
      const nextY = start.y + uy * travel
      setPinnedDevicePos({ deviceId: nodeId, x: nextX, y: nextY })
      if (travel < distance) {
        rafRef.current = requestAnimationFrame(step)
        return
      }
      rafRef.current = null
      onDone?.()
    }
    rafRef.current = requestAnimationFrame(step)
  }
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
  const getPinnedCenterTarget = (fallback = { x: CENTER_X, y: CENTER_Y }) => {
    const frame = pixiFrameRef.current
    if (!frame || !Number.isFinite(frame.scale) || frame.scale <= 0) return fallback
    const x = ((frame.viewW / 2 - frame.offsetX) / frame.scale) - PIXI_DEVICE_W / 2
    const y = ((frame.viewH / 2 - frame.offsetY) / frame.scale) - PIXI_DEVICE_H / 2
    return {
      x: Number.isFinite(x) ? x : fallback.x,
      y: Number.isFinite(y) ? y : fallback.y,
    }
  }
  const restoreIdleViewport = (duration = 860) => {
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
  const isPipelineOverview = line === ALL_PIPELINES_VALUE
  const treeCats = useMemo(() => {
    const cats = kbTree?.machine_categories
    return Array.isArray(cats) ? cats : []
  }, [kbTree])
  const flatMachines = useMemo(() => {
    const machineMap = new Map()
    treeCats.forEach((cat) => {
      const machines = Array.isArray(cat?.machines) ? cat.machines : []
      machines.forEach((machine) => {
        const name = String(machine?.name || '').trim() || '设备'
        const mKey = keyOf(name) || '设备'
        if (!machineMap.has(mKey)) {
          machineMap.set(mKey, { key: mKey, name, problemsMap: new Map() })
        }
        const targetMachine = machineMap.get(mKey)
        const problemCategories = Array.isArray(machine?.problem_categories) ? machine.problem_categories : []
        problemCategories.forEach((pc) => {
          const problems = Array.isArray(pc?.problems) ? pc.problems : []
          problems.forEach((problem) => {
            const pname = String(problem?.name || '').trim() || '问题'
            const pKey = keyOf(pname) || '问题'
            if (!targetMachine.problemsMap.has(pKey)) {
              targetMachine.problemsMap.set(pKey, { key: pKey, name: pname, rootCauses: [] })
            }
            const targetProblem = targetMachine.problemsMap.get(pKey)
            const roots = Array.isArray(problem?.root_causes) ? problem.root_causes : []
            roots.forEach((r) => {
              const rv = String(r || '').trim()
              if (rv && !targetProblem.rootCauses.includes(rv)) targetProblem.rootCauses.push(rv)
            })
          })
        })
      })
    })
    return Array.from(machineMap.values()).map((m) => ({
      key: m.key,
      name: m.name,
      problems: Array.from(m.problemsMap.values()).slice(0, 24),
    }))
  }, [treeCats])
  const findFlatMachine = (mKey) => flatMachines.find((m) => m.key === String(mKey || '')) || null
  const findFlatProblem = (machine, pKey) => (machine?.problems || []).find((p) => p.key === String(pKey || '')) || null
  const selectedPipelineId = !isPipelineOverview && line ? `pipe-${line}` : null
  const animateStructuredNav = (nextNav, focusId = null) => {
    const actionId = beginAction()
    setStructuredShowChildren(false)
    setStructuredNav(nextNav)
    schedule(actionId, () => setStructuredShowChildren(true), STRUCTURED_CHILDREN_DELAY)
    const inst = rfRef.current
    if (inst && focusId) {
      schedule(actionId, () => {
        const p = getNodePos(focusId, { x: CENTER_X, y: CENTER_Y })
        const currentZoom = inst.getViewport?.().zoom
        const focusZoom = Number.isFinite(currentZoom) ? Math.min(1.28, currentZoom + 0.28) : 1.12
        requestAnimationFrame(() => animateCenterZoom(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, focusZoom, STRUCTURED_NAV_DURATION, easeOutCubic))
      }, STRUCTURED_NAV_DELAY)
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
        const chosen = line === ALL_PIPELINES_VALUE || uniq.includes(line) ? line : ALL_PIPELINES_VALUE
        if (chosen !== line) setLine(chosen)
      } catch {
        setPipelines(['流水线1'])
        setLine(ALL_PIPELINES_VALUE)
      }
    }
    load()
  }, [])

  useEffect(() => {
    const load = async () => {
      if (isPipelineOverview) {
        setDevices([])
        setKbTree(null)
        setGraphMode('legacy')
        setStructuredNav({ level: 'm', mKey: null, pKey: null })
        setStructuredShowChildren(true)
        setExpandDevices({})
        setExpandFaults({})
        setActiveDeviceId(null)
        setActiveFaultId(null)
        setFaultFocus(null)
        setFocusDeviceId(null)
        setPinnedDevicePos(null)
        setStructuredFocus(null)
        setStructuredPinnedPos(null)
        setTransitionPhase('idle')
        setTimeout(() => {
          restoreIdleViewport(0)
        }, 0)
        return
      }
      const targetPipelines = line === ALL_PIPELINES_VALUE
        ? (pipelines.length ? pipelines : ['流水线1'])
        : [((line || '').trim() || '流水线1')]
      try {
        const docs = await api.listDocuments()
        const graphResults = await Promise.all(targetPipelines.map(async (pipeline) => ({
          pipeline,
          data: await api.getKnowledgeGraph(pipeline),
        })))
        const fallbackGroups = graphResults.map(({ pipeline, data }) => {
          const currentDevices = sanitizeDevices(data?.devices)
          if (currentDevices.length > 0) return []
          if ((data?.doc_count || 0) <= 0) return buildFallbackDevicesFromDocs(docs, pipeline)
          return buildFallbackDevicesFromDocs(docs, pipeline)
        })
        const mergedDeviceList = mergeDevices([
          ...graphResults.map((item) => item.data?.devices),
          ...fallbackGroups,
        ])
        const mergedCategories = []
        graphResults.forEach(({ pipeline, data }, index) => {
          const treeCats = Array.isArray(data?.kb_tree?.machine_categories) ? data.kb_tree.machine_categories : []
          if (treeCats.length) {
            mergedCategories.push(...treeCats)
            return
          }
          const fallbackDevices = fallbackGroups[index] || []
          const categoryDevices = sanitizeDevices(data?.devices).length > 0 ? data?.devices : fallbackDevices
          mergedCategories.push(...devicesToMachineCategories(categoryDevices, line === ALL_PIPELINES_VALUE ? pipeline : '通用设备'))
        })
        if (mergedCategories.length) {
          setGraphMode('structured')
          setKbTree({ machine_categories: mergedCategories })
          setDevices(mergedDeviceList)
          setStructuredNav({ level: 'm', mKey: null, pKey: null })
          setStructuredShowChildren(true)
        } else {
          setGraphMode('legacy')
          setKbTree(null)
          setDevices(mergedDeviceList)
          setStructuredNav({ level: 'm', mKey: null, pKey: null })
          setStructuredShowChildren(true)
        }
        setExpandDevices({})
        setExpandFaults({})
        setActiveDeviceId(null)
        setActiveFaultId(null)
        setFaultFocus(null)
        setFocusDeviceId(null)
        setPinnedDevicePos(null)
        setStructuredFocus(null)
        setStructuredPinnedPos(null)
        setTransitionPhase('idle')
        setTimeout(() => {
          restoreIdleViewport(0)
        }, 0)
      } catch {
        setDevices([])
        setKbTree(null)
        setGraphMode('legacy')
        setStructuredNav({ level: 'm', mKey: null, pKey: null })
        setStructuredShowChildren(true)
      }
    }
    load()
  }, [isPipelineOverview, line, pipelines])

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
        setStructuredNav({ level: 'm', mKey: null, pKey: null })
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
        setStructuredNav({ level: 'm', mKey: null, pKey: null })
        setStructuredShowChildren(true)
      }
      setExpandDevices({})
      setExpandFaults({})
      setActiveDeviceId(null)
      setActiveFaultId(null)
      setFaultFocus(null)
      setFocusDeviceId(null)
      setPinnedDevicePos(null)
      setStructuredFocus(null)
      setStructuredPinnedPos(null)
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
    if (!flatMachines.length) return null
    const ns = []
    const es = []
    const level = structuredNav.level || 'm'
    const mKey = structuredNav.mKey
    const pKey = structuredNav.pKey
    const nodeIdSet = new Set()
    const edgeIdSet = new Set()

    const addNode = (id, label, kind, x, y, hidden, extra) => {
      if (!id || nodeIdSet.has(id)) return
      nodeIdSet.add(id)
      ns.push({ id, type: 'cloud', data: { label, kind, preset: visualPreset, hidden: !!hidden, ...(extra || {}) }, position: { x, y }, draggable: false, style: hidden ? { opacity: 0, pointerEvents: 'none' } : undefined })
    }
    const addEdge = (src, dst, stroke) => {
      if (!src || !dst) return
      const id = `e-${src}-${dst}`
      if (edgeIdSet.has(id)) return
      edgeIdSet.add(id)
      es.push({ id, source: src, target: dst, animated: visualPreset !== 'v1', style: { stroke: stroke || '#91caff', opacity: 0.92 } })
    }
    const anchor = structuredAnchorRef.current
    const base = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? anchor : { x: CENTER_X, y: CENTER_Y }
    const baseCenter = { x: base.x + DEVICE_NODE_W / 2, y: base.y + CLOUD_CENTER_Y_OFFSET }

    if ((transitionPhase === 'structuredFocusing' || transitionPhase === 'pipelineReturning') && structuredFocus) {
      const pos = structuredPinnedPos && Number.isFinite(structuredPinnedPos.x) && Number.isFinite(structuredPinnedPos.y)
        ? structuredPinnedPos
        : { x: CENTER_X, y: CENTER_Y }
      addNode(
        structuredFocus.id,
        structuredFocus.label,
        structuredFocus.kind || 'device',
        pos.x,
        pos.y,
        false,
        {
          level: structuredFocus.kind === 'pipeline' ? undefined : (structuredFocus.kind === 'fault' ? 'p' : 'm'),
          mKey: structuredFocus.mKey,
          key: structuredFocus.kind === 'fault' ? structuredFocus.pKey : structuredFocus.mKey,
          pipeline: structuredFocus.kind === 'pipeline' ? structuredFocus.pipeline : undefined,
          disableLayoutTween: true,
          raiseAbove: true,
          emphasis: structuredFocus.kind === 'fault' ? 1.05 : 1.02,
        }
      )
      return { nodes: ns, edges: es }
    }

    if (level === 'm' || !mKey) {
      const pipelineNameKey = keyOf(line)
      const shouldShowPipeline = selectedPipelineId && !flatMachines.some((m) => keyOf(m.name) === pipelineNameKey)
      if (shouldShowPipeline) {
        addNode(selectedPipelineId, line, 'pipeline', CENTER_X, CENTER_Y, false, { pipeline: line })
      }
      const overviewMachines = flatMachines.slice(0, 18)
      const overviewRing = ringRadius(overviewMachines.length || 1, DEVICE_NODE_W, 56, 360)
      const overviewAngles = faultAngles(Math.max(overviewMachines.length, 1))
      overviewMachines.forEach((m, i) => {
        let x
        let y
        if (shouldShowPipeline) {
          const a = overviewAngles[i] ?? ((Math.PI * 2 * i) / Math.max(overviewMachines.length, 1))
          x = CENTER_X + Math.cos(a) * overviewRing
          y = CENTER_Y + Math.sin(a) * overviewRing
        } else if (visualPreset === 'v1') {
          const cols = Math.min(4, Math.max(1, flatMachines.length))
          const r = Math.floor(i / cols)
          const c = i % cols
          const sx = CENTER_X - ((Math.min(flatMachines.length, cols) - 1) * 260) / 2
          const sy = CENTER_Y - (Math.ceil(flatMachines.length / cols) - 1) * 120 / 2
          x = sx + c * 260
          y = sy + r * 120
        } else if (visualPreset === 'v3') {
          const a = i * 2.3999632297
          const rr = 120 + i * 80
          x = CENTER_X + Math.cos(a) * rr
          y = CENTER_Y + Math.sin(a) * rr
        } else if (visualPreset === 'v4') {
          const sy = CENTER_Y - ((Math.min(flatMachines.length, 18) - 1) * 110) / 2
          x = CENTER_X - 320
          y = sy + i * 110
        } else {
          const pos = getDeviceRowPos(flatMachines.slice(0, 18), `m-${m.key}`)
          x = pos.x
          y = pos.y
        }
        addNode(`m-${m.key}`, m.name, 'device', x, y, false, { level: 'm', key: m.key, emphasis: selectedPipelineId ? 0.9 : 1 })
        if (shouldShowPipeline) addEdge(selectedPipelineId, `m-${m.key}`, '#69b1ff')
      })
      return { nodes: ns, edges: es }
    }

    const machine = findFlatMachine(mKey)
    const machineName = machine?.name || '设备'
    const machineId = `m-${mKey}`
    addNode(machineId, machineName, 'device', base.x, base.y, false, { level: 'm', key: mKey })
    const problems = (machine?.problems || []).slice(0, 18)

    if (level === 'p' || !pKey) {
      const ring = ringRadius(problems.length || 1, FAULT_NODE_W, 54, 320)
      const angles = faultAngles(Math.max(problems.length, 1))
      problems.forEach((p, i) => {
        let x
        let y
        if (visualPreset === 'v1') {
          const cols = Math.min(3, Math.max(1, problems.length))
          const r = Math.floor(i / cols)
          const c = i % cols
          const sx = baseCenter.x - ((cols - 1) * 250) / 2
          x = sx + c * 250 - FAULT_NODE_W / 2
          y = baseCenter.y + 185 + r * 106 - CLOUD_CENTER_Y_OFFSET
        } else if (visualPreset === 'v3') {
          const a = i * 2.3999632297
          const rr = 170 + i * 30
          x = baseCenter.x + Math.cos(a) * rr - FAULT_NODE_W / 2
          y = baseCenter.y + Math.sin(a) * rr - CLOUD_CENTER_Y_OFFSET
        } else if (visualPreset === 'v4') {
          x = baseCenter.x + 320 - FAULT_NODE_W / 2
          y = baseCenter.y - ((problems.length - 1) * 88) / 2 + i * 88 - CLOUD_CENTER_Y_OFFSET
        } else {
          const a = angles[i] ?? ((Math.PI * 2 * i) / Math.max(problems.length, 1))
          x = baseCenter.x + Math.cos(a) * ring - FAULT_NODE_W / 2
          y = baseCenter.y + Math.sin(a) * ring - CLOUD_CENTER_Y_OFFSET
        }
        const id = `p-${mKey}-${p.key}`
        addNode(id, p.name, 'fault', x, y, !structuredShowChildren, { level: 'p', mKey, key: p.key })
        addEdge(machineId, id, '#ffd666')
      })
      return { nodes: ns, edges: es }
    }

    const problem = findFlatProblem(machine, pKey)
    const problemName = problem?.name || '问题'
    const problemId = `p-${mKey}-${pKey}`
    addNode(machineId, machineName, 'device', base.x - 340, base.y, false, { level: 'm', key: mKey })
    addNode(problemId, problemName, 'fault', base.x, base.y, false, { level: 'p', mKey, key: pKey })
    addEdge(machineId, problemId, '#ffd666')
    const roots = (problem?.rootCauses || []).slice(0, 12)
    const ring = ringRadius(roots.length || 1, SOLUTION_NODE_W, 34, 260)
    const angles = faultAngles(Math.max(roots.length, 1))
    roots.forEach((r, i) => {
      let x
      let y
      if (visualPreset === 'v1') {
        x = baseCenter.x + 250 - SOLUTION_NODE_W / 2
        y = baseCenter.y - ((roots.length - 1) * 84) / 2 + i * 84 - CLOUD_CENTER_Y_OFFSET
      } else if (visualPreset === 'v3') {
        const a = i * 2.3999632297
        const rr = 170 + i * 28
        x = baseCenter.x + Math.cos(a) * rr - SOLUTION_NODE_W / 2
        y = baseCenter.y + Math.sin(a) * rr - CLOUD_CENTER_Y_OFFSET
      } else if (visualPreset === 'v4') {
        x = baseCenter.x + 360 - SOLUTION_NODE_W / 2
        y = baseCenter.y - ((roots.length - 1) * 84) / 2 + i * 84 - CLOUD_CENTER_Y_OFFSET
      } else {
        const a = angles[i] ?? ((Math.PI * 2 * i) / Math.max(roots.length, 1))
        x = baseCenter.x + Math.cos(a) * ring - SOLUTION_NODE_W / 2
        y = baseCenter.y + Math.sin(a) * ring - CLOUD_CENTER_Y_OFFSET
      }
      const id = `rc-${mKey}-${pKey}-${keyOf(r)}`
      addNode(id, r, 'solution', x, y, !structuredShowChildren, { level: 'rc', mKey, pKey, key: keyOf(r) })
      addEdge(problemId, id, '#95de64')
    })
    return { nodes: ns, edges: es }
  }, [graphMode, flatMachines, structuredNav, structuredShowChildren, visualPreset, selectedPipelineId, line, transitionPhase, structuredFocus, structuredPinnedPos])

  useEffect(() => {
    if (graphMode !== 'structured') return
    if ((structuredNav?.level || 'm') !== 'm') return
    if (structuredNav?.mKey) return
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
  }, [graphMode, line, flatMachines.length, structuredNav?.level, structuredNav?.mKey])

  const { nodes, edges } = useMemo(() => {
    if (isPipelineOverview) {
      if (transitionPhase === 'pipelineFocusing' && structuredFocus?.kind === 'pipeline') {
        const pos = structuredPinnedPos && Number.isFinite(structuredPinnedPos.x) && Number.isFinite(structuredPinnedPos.y)
          ? structuredPinnedPos
          : getOverviewRowPos(pipelines, Math.max(0, pipelines.findIndex((item) => item === structuredFocus.pipeline)))
        return {
          nodes: [{
            id: structuredFocus.id,
            type: 'cloud',
            data: {
              label: structuredFocus.label,
              kind: 'pipeline',
              preset: visualPreset,
              hidden: false,
              pipeline: structuredFocus.pipeline,
              disableLayoutTween: true,
              emphasis: 0.92,
            },
            position: pos,
            draggable: false,
          }],
          edges: [],
        }
      }
      const ns = (pipelines || []).map((pipeline, index) => {
        const pos = getOverviewRowPos(pipelines, index)
        return {
          id: `pipe-${pipeline}`,
          type: 'cloud',
          data: { label: pipeline, kind: 'pipeline', preset: visualPreset, hidden: false, pipeline, emphasis: 0.9 },
          position: pos,
          draggable: false,
        }
      })
      return { nodes: ns, edges: [] }
    }
    if (graphMode === 'structured' && buildStructuredFlow) return buildStructuredFlow
    const ns = []
    const es = []
    const pipelineId = selectedPipelineId
    if (transitionPhase === 'idle' && pipelineId) {
      ns.push({
        id: pipelineId,
        type: 'cloud',
        data: { label: line, kind: 'pipeline', preset: visualPreset, hidden: false, pipeline: line, emphasis: 0.92 },
        position: { x: CENTER_X, y: CENTER_Y },
        draggable: false,
      })
    }
    if ((transitionPhase === 'faultFocusing' || transitionPhase === 'faultExpanded') && faultFocus) {
      const dev = devices.find(d => `dev-${d.name}` === faultFocus.deviceId)
      const fault = (dev?.faults || [])[faultFocus.faultIndex]
      if (dev && fault) {
        const side = faultFocus.side === 'right' ? 'right' : 'left'
        const faultId = `fault-${dev.name}-${faultFocus.faultIndex}`
        const ax = CENTER_X
        const ay = CENTER_Y
        ns.push({
          id: faultId,
          type: 'cloud',
          data: {
            label: fault.name,
            kind: 'fault',
            preset: visualPreset,
            hidden: false,
            deviceId: faultFocus.deviceId,
            faultIndex: faultFocus.faultIndex,
            side,
            emphasis: transitionPhase === 'faultFocusing' ? 1.1 : 1.04,
          },
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
            data: { label: dev.name, kind: 'device', preset: visualPreset, hidden: false },
            position: { x: devX, y: ay },
            draggable: false
          })
          es.push({ id: `e-${devId}-${faultId}`, source: devId, target: faultId, animated: true, style: { stroke: '#faad14' } })
          const sols = fault.solutions || []
          const startY = ay - ((sols.length - 1) * 120) / 2
          sols.forEach((s, i) => {
            const solId = `sol-${dev.name}-${faultFocus.faultIndex}-${i}`
            ns.push({
              id: solId,
              type: 'cloud',
              data: { label: s, kind: 'solution', preset: visualPreset, hidden: false },
              position: { x: solX, y: startY + i * 120 },
              draggable: false
            })
            es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' } })
          })
        }
      }
      return { nodes: ns, edges: es }
    }

    if (transitionPhase === 'expanded' && activeDeviceId && activeFaultId) {
      const dev = devices.find((d) => `dev-${d.name}` === activeDeviceId)
      const idxMatch = String(activeFaultId).match(/-(\d+)$/)
      const fi = idxMatch ? Number(idxMatch[1]) : NaN
      const fault = Number.isFinite(fi) ? (dev?.faults || [])[fi] : null
      if (dev && fault) {
        const ax = CENTER_X
        const ay = CENTER_Y
        const faultId = `fault-${dev.name}-${fi}`
        ns.push({
          id: faultId,
          type: 'cloud',
          data: {
            label: fault.name,
            kind: 'fault',
            preset: visualPreset,
            hidden: false,
            deviceId: activeDeviceId,
            faultIndex: fi,
            emphasis: 1.06,
          },
          position: { x: ax, y: ay },
          draggable: false,
        })
        const solutions = fault.solutions || []
        const sRadius = ringRadius(solutions.length || 1, SOLUTION_NODE_W, 24, 240)
        const angles = faultAngles(Math.max(solutions.length, 1))
        solutions.forEach((s, si) => {
          const a = angles[si] ?? ((Math.PI * 2 * si) / Math.max(solutions.length, 1))
          const sx = ax + Math.cos(a) * sRadius
          const sy = ay + Math.sin(a) * sRadius
          const solId = `sol-${dev.name}-${fi}-${si}`
          ns.push({
            id: solId,
            type: 'cloud',
            data: { label: s, kind: 'solution', preset: visualPreset, hidden: false },
            position: { x: sx, y: sy },
            draggable: false,
          })
          es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' } })
        })
        return { nodes: ns, edges: es }
      }
    }
    const basePosById = new Map()
    devices.forEach((d, i) => {
      const id = `dev-${d.name}`
      if (visualPreset === 'v1') {
        const total = Math.max(devices.length, 1)
        const cols = Math.min(4, total)
        const r = Math.floor(i / cols)
        const c = i % cols
        const sx = CENTER_X - ((Math.min(total, cols) - 1) * 260) / 2
        const sy = CENTER_Y - (Math.ceil(total / cols) - 1) * 120 / 2
        basePosById.set(id, { x: sx + c * 260, y: sy + r * 120 })
      } else if (visualPreset === 'v3') {
        const a = i * 2.3999632297
        const rr = 120 + i * 80
        basePosById.set(id, { x: CENTER_X + Math.cos(a) * rr, y: CENTER_Y + Math.sin(a) * rr })
      } else if (visualPreset === 'v4') {
        const sy = CENTER_Y - ((devices.length - 1) * 110) / 2
        basePosById.set(id, { x: CENTER_X - 320, y: sy + i * 110 })
      } else {
        basePosById.set(id, getDeviceRowPos(devices, id))
      }
    })
    devices.forEach((d, i) => {
      const devId = `dev-${d.name}`
      const base = basePosById.get(devId) || { x: CENTER_X, y: CENTER_Y }
      const showOnlyFocused = transitionPhase === 'focusing' || transitionPhase === 'expanded' || transitionPhase === 'collapsing'
      const isVisible = showOnlyFocused ? devId === focusDeviceId : true
      if (!isVisible) return
      let x = base.x
      let y = base.y
      const isPinned = pinnedDevicePos && pinnedDevicePos.deviceId === devId
      if (isPinned) {
        x = pinnedDevicePos.x
        y = pinnedDevicePos.y
      } else if (showOnlyFocused && devId === focusDeviceId) {
        x = CENTER_X
        y = CENTER_Y
      } else if (transitionPhase === 'idle' && pipelineId) {
        const ring = ringRadius(devices.length || 1, DEVICE_NODE_W, 56, 330)
        const angle = faultAngles(Math.max(devices.length, 1))[i] ?? ((Math.PI * 2 * i) / Math.max(devices.length, 1))
        x = CENTER_X + Math.cos(angle) * ring
        y = CENTER_Y + Math.sin(angle) * ring
      }
      const px = x
      const py = y
      ns.push({
        id: devId,
        type: 'cloud',
        data: {
          label: d.name,
          kind: 'device',
          preset: visualPreset,
          hidden: false,
          emphasis: transitionPhase === 'idle' && pipelineId ? 0.9 : 1,
          disableLayoutTween: Boolean(isPinned),
        },
        position: { x: px, y: py },
        draggable: false
      })
      if (transitionPhase === 'idle' && pipelineId) {
        es.push({ id: `e-${pipelineId}-${devId}`, source: pipelineId, target: devId, animated: true, style: { stroke: '#69b1ff' } })
      }
      if (transitionPhase === 'expanded' && activeDeviceId === devId) {
        const fxCenter = px
        const fyCenter = py
        const faults = d.faults || []
        const faultRing = ringRadius(faults.length || 1, FAULT_NODE_W, 54, visualPreset === 'v3' ? 260 : 320)
        const angles = faultAngles(Math.max(faults.length, 1))
        ;faults.forEach((f, fi) => {
          let fx = fxCenter
          let fy = fyCenter
          if (visualPreset === 'v1') {
            const cols = Math.min(3, Math.max(1, faults.length))
            const r = Math.floor(fi / cols)
            const c = fi % cols
            const sx = fxCenter - ((cols - 1) * 250) / 2
            fx = sx + c * 250
            fy = fyCenter + 180 + r * 120
          } else if (visualPreset === 'v3') {
            const a = fi * 2.3999632297
            const rr = 170 + fi * 36
            fx = fxCenter + Math.cos(a) * rr
            fy = fyCenter + Math.sin(a) * rr
          } else if (visualPreset === 'v4') {
            fx = fxCenter + 340
            fy = fyCenter - ((faults.length - 1) * 90) / 2 + fi * 90
          } else {
            const fAngle = angles[fi] ?? ((Math.PI * 2 * fi) / Math.max(faults.length, 1))
            fx = fxCenter + Math.cos(fAngle) * faultRing
            fy = fyCenter + Math.sin(fAngle) * faultRing
          }
          const faultId = `fault-${d.name}-${fi}`
          ns.push({
            id: faultId,
            type: 'cloud',
            data: { label: f.name, kind: 'fault', preset: visualPreset, hidden: false, deviceId: devId, faultIndex: fi, side: fx >= fxCenter ? 'right' : 'left' },
            position: { x: fx, y: fy },
            draggable: false
          })
          if (visualPreset !== 'v1') {
            es.push({ id: `e-${devId}-${faultId}`, source: devId, target: faultId, animated: true, style: { stroke: '#faad14' } })
          }
          if (activeFaultId === faultId) {
            const solutions = f.solutions || []
            const sRadius = ringRadius(solutions.length || 1, SOLUTION_NODE_W, 24, 210)
            ;solutions.forEach((s, si) => {
              let sx = fx
              let sy = fy
              if (visualPreset === 'v1') {
                sx = fx + (si % 2 === 0 ? -180 : 180)
                sy = fy + 90 + Math.floor(si / 2) * 95
              } else if (visualPreset === 'v3') {
                const a = si * 2.3999632297 + hashUnit(s) * 0.4
                const rr = 130 + si * 24
                sx = fx + Math.cos(a) * rr
                sy = fy + Math.sin(a) * rr
              } else if (visualPreset === 'v4') {
                sx = fx + 360
                sy = fy - ((solutions.length - 1) * 76) / 2 + si * 76
              } else {
                const sAngle = (Math.PI * 2 * si) / Math.max(solutions.length, 1) - Math.PI / 2
                sx = fx + Math.cos(sAngle) * sRadius
                sy = fy + Math.sin(sAngle) * sRadius
              }
              const solId = `sol-${d.name}-${fi}-${si}`
              ns.push({
                id: solId,
                type: 'cloud',
                data: { label: s, kind: 'solution', preset: visualPreset, hidden: false },
                position: { x: sx, y: sy },
                draggable: false
              })
              if (visualPreset !== 'v1') {
                es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' } })
              }
            })
          }
        })
      }
    })
    return { nodes: ns, edges: es }
  }, [isPipelineOverview, pipelines, graphMode, buildStructuredFlow, devices, activeDeviceId, activeFaultId, focusDeviceId, transitionPhase, faultFocus, pinnedDevicePos, visualPreset, selectedPipelineId, line, structuredFocus, structuredPinnedPos])

  const onNodeClick = (_, node) => {
    if (node.id.startsWith('pipe-')) {
      const pipeline = String(node.data?.pipeline || '').trim()
      if (pipeline) {
        const actionId = beginAction()
        const startPos = node.positionAbsolute || node.position || getOverviewRowPos(pipelines, Math.max(0, pipelines.findIndex((item) => item === pipeline)))
        const targetPos = getPinnedCenterTarget({ x: CENTER_X, y: CENTER_Y })
        setStructuredFocus({ id: `pipe-${pipeline}`, kind: 'pipeline', pipeline, label: pipeline })
        setStructuredPinnedPos({ x: startPos.x, y: startPos.y })
        setTransitionPhase('pipelineFocusing')
        animateStructuredNodeTo(startPos, targetPos, DEVICE_FOCUS_DURATION, () => {
          if (actionRef.current !== actionId) return
          setStructuredFocus(null)
          setStructuredPinnedPos(null)
          setLine(pipeline)
          setTransitionPhase('idle')
        })
      }
      return
    }
    if (graphMode === 'structured') {
      const d = node?.data || {}
      const lv = d.level
      if (lv === 'm') {
        const mKey = d.key
        if ((structuredNav.level === 'p' || structuredNav.level === 'rc') && structuredNav.mKey === mKey) {
          animateStructuredNav({ level: 'm', mKey: null, pKey: null })
          return
        }
        const actionId = beginAction()
        const startPos = node.positionAbsolute || node.position || { x: CENTER_X, y: CENTER_Y }
        const targetPos = getPinnedCenterTarget({ x: CENTER_X, y: CENTER_Y })
        structuredAnchorRef.current = { x: targetPos.x, y: targetPos.y }
        setStructuredShowChildren(false)
        setStructuredFocus({ id: `m-${mKey}`, mKey, label: d.label || '设备' })
        setStructuredPinnedPos({ x: startPos.x, y: startPos.y })
        setTransitionPhase('structuredFocusing')
        animateStructuredNodeTo(startPos, targetPos, DEVICE_FOCUS_DURATION, () => {
          if (actionRef.current !== actionId) return
          setStructuredFocus(null)
          setStructuredPinnedPos(null)
          setStructuredNav({ level: 'p', mKey, pKey: null })
          setStructuredShowChildren(true)
          setTransitionPhase('idle')
        })
        return
      }
      if (lv === 'p') {
        const mKey = d.mKey
        const pKey = d.key
        if (structuredNav.level === 'rc' && structuredNav.mKey === mKey && structuredNav.pKey === pKey) {
          animateStructuredNav({ level: 'p', mKey, pKey: null }, `p-${mKey}-${pKey}`)
          return
        }
        const actionId = beginAction()
        const startPos = node.positionAbsolute || node.position || { x: CENTER_X, y: CENTER_Y }
        const targetPos = getPinnedCenterTarget({ x: CENTER_X, y: CENTER_Y })
        structuredAnchorRef.current = { x: targetPos.x, y: targetPos.y }
        setStructuredShowChildren(false)
        setStructuredFocus({ id: `p-${mKey}-${pKey}`, kind: 'fault', mKey, pKey, label: d.label || '问题' })
        setStructuredPinnedPos({ x: startPos.x, y: startPos.y })
        setTransitionPhase('structuredFocusing')
        animateStructuredNodeTo(startPos, targetPos, FAULT_FOCUS_DURATION, () => {
          if (actionRef.current !== actionId) return
          setStructuredFocus(null)
          setStructuredPinnedPos(null)
          setStructuredNav({ level: 'rc', mKey, pKey })
          setStructuredShowChildren(true)
          setTransitionPhase('idle')
        })
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
        restoreIdleViewport(DEVICE_COLLAPSE_DURATION)
        return
      }
      const fromFaultScene = transitionPhase === 'faultFocusing' || transitionPhase === 'faultExpanded'
      const nextSelected = node.id
      if (rfRef.current) {
        if (nextSelected) {
          const currentZoom = rfRef.current?.getViewport?.().zoom
          const focusZoom = Number.isFinite(currentZoom) ? Math.min(1.12, currentZoom + 0.28) : 1.12
          const p0 = getNodePos(node.id, node.positionAbsolute || node.position)
          setFaultFocus(null)
          setActiveFaultId(null)
          setActiveDeviceId(null)
          setPinnedDevicePos(null)
          setFocusDeviceId(node.id)
          setTransitionPhase('focusing')
          animateCenterZoom(CENTER_X + DEVICE_NODE_W / 2, CENTER_Y + CLOUD_CENTER_Y_OFFSET, focusZoom, DEVICE_FOCUS_DURATION, easeInOutCubic)
          if (fromFaultScene) {
            schedule(actionId, () => {
              setActiveDeviceId(node.id)
              setActiveFaultId(null)
              setTransitionPhase('expanded')
              const device = devices.find(d => `dev-${d.name}` === node.id)
              const faultCount = Math.max((device?.faults || []).length, 1)
              const targetZoom = faultCount <= 3 ? 0.98 : faultCount <= 5 ? 0.9 : 0.82
              schedule(actionId, () => {
                animateCenterZoom(CENTER_X + DEVICE_NODE_W / 2, CENTER_Y + CLOUD_CENTER_Y_OFFSET, targetZoom, DEVICE_EXPAND_ZOOM_DURATION, easeInOutCubic)
              }, 40)
            }, DEVICE_EXPAND_DELAY)
          } else {
            schedule(actionId, () => {
              setActiveDeviceId(node.id)
              setActiveFaultId(null)
              setTransitionPhase('expanded')
              const device = devices.find(d => `dev-${d.name}` === node.id)
              const faultCount = Math.max((device?.faults || []).length, 1)
              const targetZoom = faultCount <= 3 ? 0.98 : faultCount <= 5 ? 0.9 : 0.82
              schedule(actionId, () => {
                animateCenterZoom(CENTER_X + DEVICE_NODE_W / 2, CENTER_Y + CLOUD_CENTER_Y_OFFSET, targetZoom, DEVICE_EXPAND_ZOOM_DURATION, easeInOutCubic)
              }, 40)
            }, DEVICE_EXPAND_DELAY)
          }
        }
      }
      if (!rfRef.current) {
        const startPos = getNodePos(nextSelected, node.positionAbsolute || node.position)
        setFaultFocus(null)
        setActiveFaultId(null)
        setFocusDeviceId(nextSelected)
        setActiveDeviceId(null)
        setPinnedDevicePos({ deviceId: nextSelected, x: startPos.x, y: startPos.y })
        setTransitionPhase('focusing')
        animatePinnedNodeTo(
          nextSelected,
          startPos,
          { x: CENTER_X, y: CENTER_Y },
          DEVICE_FOCUS_DURATION,
          () => {
            if (actionRef.current !== actionId) return
            setActiveDeviceId(nextSelected)
            setActiveFaultId(null)
            setPinnedDevicePos(null)
            setTransitionPhase('expanded')
          }
        )
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
            rfRef.current?.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { duration: DEVICE_COLLAPSE_DURATION })
          }, 0)
        }
        return
      }
      const p = node.positionAbsolute || node.position
      const nextFaultFocus = {
        deviceId: node.data?.deviceId,
        faultIndex: node.data?.faultIndex,
        side: node.data?.side || 'right',
        anchorX: p.x,
        anchorY: p.y
      }
      if (rfRef.current) {
        const currentZoom = rfRef.current?.getViewport?.().zoom
        const focusZoom = Number.isFinite(currentZoom) ? Math.min(1.18, currentZoom + 0.14) : 1.08
        setFaultFocus(nextFaultFocus)
        setActiveFaultId(null)
        setTransitionPhase('faultFocusing')
        schedule(actionId, () => {
          animateCenterZoom(CENTER_X + FAULT_NODE_W / 2, CENTER_Y + CLOUD_CENTER_Y_OFFSET, focusZoom, FAULT_FOCUS_DURATION, easeOutCubic)
        }, 30)
        schedule(actionId, () => {
          setActiveFaultId(node.id)
          setTransitionPhase('faultExpanded')
          const dev = devices.find(d => `dev-${d.name}` === node.data?.deviceId)
          const fault = (dev?.faults || [])[node.data?.faultIndex]
          const solCount = Math.max((fault?.solutions || []).length, 1)
          const targetZoom = solCount <= 2 ? 1.0 : solCount <= 4 ? 0.94 : solCount <= 6 ? 0.88 : 0.82
          schedule(actionId, () => {
            animateCenterZoom(CENTER_X + FAULT_NODE_W / 2, CENTER_Y + CLOUD_CENTER_Y_OFFSET, targetZoom, FAULT_EXPAND_ZOOM_DURATION)
          }, 40)
        }, FAULT_EXPAND_DELAY)
      }
      if (!rfRef.current) {
        setFaultFocus(nextFaultFocus)
        setActiveFaultId(null)
        setTransitionPhase('faultFocusing')
        schedule(actionId, () => {
          setActiveFaultId(node.id)
          setTransitionPhase('faultExpanded')
        }, FAULT_FOCUS_DURATION)
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
        rfRef.current.setCenter(p.x + w / 2, p.y + (kind === 'solution' ? h / 2 : CLOUD_CENTER_Y_OFFSET), { zoom: 1.16, duration: GENERIC_CENTER_DURATION })
      }
    }
  }

  const onPaneClick = () => {
    if (!isPipelineOverview && line !== ALL_PIPELINES_VALUE && graphMode !== 'structured') {
      setLine(ALL_PIPELINES_VALUE)
      return
    }
    if (graphMode !== 'structured') return
    const nav = structuredNav
    if (nav.level === 'm') {
      if (!isPipelineOverview && line !== ALL_PIPELINES_VALUE) {
        const actionId = beginAction()
        const pipelineIndex = Math.max(0, pipelines.findIndex((item) => item === line))
        const startPos = { x: CENTER_X, y: CENTER_Y }
        const targetPos = getOverviewRowPos(pipelines, pipelineIndex)
        setStructuredShowChildren(false)
        setStructuredFocus({ id: `pipe-${line}`, kind: 'pipeline', pipeline: line, label: line })
        setStructuredPinnedPos({ x: startPos.x, y: startPos.y })
        setTransitionPhase('pipelineReturning')
        animateStructuredNodeTo(startPos, targetPos, DEVICE_FOCUS_DURATION, () => {
          if (actionRef.current !== actionId) return
          setStructuredFocus(null)
          setStructuredPinnedPos(null)
          setLine(ALL_PIPELINES_VALUE)
          setTransitionPhase('idle')
        })
        return
      }
      animateStructuredNav({ level: 'm', mKey: null, pKey: null })
      rfRef.current?.fitView?.({ duration: DEVICE_COLLAPSE_DURATION, padding: 0.2 })
      return
    }
    if (nav.level === 'p') {
      animateStructuredNav({ level: 'm', mKey: null, pKey: null }, `m-${nav.mKey}`)
      return
    }
    if (nav.level === 'rc') {
      animateStructuredNav({ level: 'p', mKey: nav.mKey, pKey: null }, `m-${nav.mKey}`)
    }
  }

  const currentLineLabel = line === ALL_PIPELINES_VALUE ? ALL_PIPELINES_LABEL : (line || '流水线1')
  const pipelineOptions = useMemo(() => ([
    { label: ALL_PIPELINES_LABEL, value: ALL_PIPELINES_VALUE },
    ...pipelines.map((item) => ({ label: item, value: item })),
  ]), [pipelines])
  const centerNodeId = useMemo(() => {
    if (transitionPhase !== 'idle') return null
    if (graphMode === 'structured') {
      const navLevel = structuredNav?.level || 'm'
      if (navLevel === 'rc' && structuredNav?.mKey && structuredNav?.pKey) return `p-${structuredNav.mKey}-${structuredNav.pKey}`
      if (navLevel === 'p' && structuredNav?.mKey) return `m-${structuredNav.mKey}`
      if (navLevel === 'm' && selectedPipelineId) return selectedPipelineId
    }
    return null
  }, [transitionPhase, structuredFocus, graphMode, structuredNav, selectedPipelineId])

  return (
    <div className="page-container">
      <div style={{ marginBottom: 16 }}>
        <Title level={3} className="page-title">数据云图</Title>
        <Space>
          <Text type="secondary">流水线：</Text>
          <Select
            size="small"
            style={{ width: 180 }}
            value={line}
            options={pipelineOptions}
            onChange={setLine}
          />
        </Space>
      </div>

      <Card className="glass-card" styles={{ body: { padding: 0 } }}>
        {nodes.length === 0 ? (
          <div style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              description={
                isPipelineOverview
                  ? `当前暂无可展示的流水线`
                  : graphMode === 'structured'
                  ? `当前${currentLineLabel}暂无可展示的结构化条目（请先“整理历史/清理无用”，并确保“问题”和“导致原因”不为空）`
                  : `当前${currentLineLabel}暂无可展示的设备图谱`
              }
            />
          </div>
        ) : (
          <div ref={flowWrapRef} style={{ height: 560 }}>
            <PixiCloudGraph
              nodes={nodes}
              edges={edges}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              height={560}
              freezeView={transitionPhase === 'focusing' || transitionPhase === 'faultFocusing' || transitionPhase === 'structuredFocusing' || transitionPhase === 'pipelineReturning' || transitionPhase === 'pipelineFocusing'}
              onFrameChange={(frame) => { pixiFrameRef.current = frame }}
              centerNodeId={centerNodeId}
            />
          </div>
        )}
      </Card>
    </div>
  )
}
