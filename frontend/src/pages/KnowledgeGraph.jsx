import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Typography, Space, Empty, Tag, AutoComplete, Button, message } from 'antd'
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow'
import 'reactflow/dist/style.css'
import './KnowledgeGraph.css'
import api from '../services/api.js'

const { Title, Text } = Typography
const FAULT_HINTS = ['故障', '异常', '报警', '失效', '损坏', '泄漏', '过热', '振动', '异响', '堵塞', '磨损', '卡滞', '偏差', '无法启动', '不启动', '无压力', '压力不足', '温度过高', '短路', '断路', '跳闸', '停机']
const SOLUTION_HINTS = ['检查', '更换', '清理', '维修', '修复', '调整', '校准', '紧固', '润滑', '复位', '重启', '测试', '确认', '处理', '排查']
const NOISE_TERMS = ['常见故障排查表', '技术参数', '定期保养计划', '安全须知', '产品结构图示', '分步维修指南', '每日', '每周', '每月', '每半年', '每年', '维修查询热线', '更新日期', '可能原因', '解决方法', '故障现象']

const norm = (s) => String(s || '').replace(/[\s，。,.、；;：:【】\[\]()（）\-—_]+/g, '')
const isNoise = (s) => {
  const t = norm(s)
  return !t || NOISE_TERMS.some(n => t.includes(norm(n)))
}
const isFault = (s) => {
  const v = String(s || '')
  if (isNoise(v)) return false
  return FAULT_HINTS.some(k => v.includes(k)) || ['无法开机', '吸力减弱', '异常噪音', '充电故障', '无法启动'].includes(v)
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
      <div className="cloud-node__puff cloud-node__puff--l" />
      <div className="cloud-node__puff cloud-node__puff--r" />
      <div className="cloud-node__label">{data.label}</div>
    </div>
  )
}

const nodeTypes = { cloud: CloudNode }
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
const getBaseDevicePos = (allDevices, deviceId) => {
  const total = Math.max((allDevices || []).length, 1)
  const devRing = ringRadius(total, DEVICE_NODE_W, 56, 280)
  const idx = (allDevices || []).findIndex((d) => `dev-${d.name}` === deviceId)
  const safeIdx = idx >= 0 ? idx : 0
  const angle = (Math.PI * 2 * safeIdx) / total - Math.PI / 2
  return {
    x: CENTER_X + Math.cos(angle) * devRing,
    y: CENTER_Y + Math.sin(angle) * devRing,
  }
}

export default function KnowledgeGraph() {
  const [line, setLine] = useState('流水线1')
  const [pipelines, setPipelines] = useState(['流水线1'])
  const [devices, setDevices] = useState([])
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
  const timersRef = useRef([])
  const clearTimers = () => {
    timersRef.current.forEach(t => clearTimeout(t))
    timersRef.current = []
  }

  const handleFlowInit = (instance) => {
    setRf(instance)
    setTimeout(() => {
      try {
        instance.fitView({ duration: 0, padding: 0.2 })
      } catch {}
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
        const p = Array.from(new Set(['流水线1', ...all.filter(Boolean)]))
        setPipelines(p)
        if (!p.includes(line)) setLine(p[0] || '流水线1')
        const data = await api.getKnowledgeGraph(line)
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
        setExpandDevices({})
        setExpandFaults({})
        setActiveDeviceId(null)
        setActiveFaultId(null)
        setFaultFocus(null)
        setFocusDeviceId(null)
        setPinnedDevicePos(null)
        setTransitionPhase('idle')
      } catch {
        setDevices([])
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
      setExpandDevices({})
      setExpandFaults({})
      setActiveDeviceId(null)
      setActiveFaultId(null)
      setFaultFocus(null)
      setFocusDeviceId(null)
      setPinnedDevicePos(null)
      setTransitionPhase('idle')
      message.info(`当前图谱：${data?.device_count || next.length || 0} 个设备，${data?.fault_count || 0} 条故障`)
    } catch (e) {
      message.error('重建失败: ' + (e.response?.data?.detail || e.message))
    }
    setRebuilding(false)
  }

  const { nodes, edges } = useMemo(() => {
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
          es.push({ id: `e-${devId}-${faultId}`, source: devId, target: faultId, animated: true, style: { stroke: '#faad14' } })
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
            es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' } })
          })
        }
      }
      return { nodes: ns, edges: es }
    }
    const total = Math.max(devices.length, 1)
    const devRing = ringRadius(total, DEVICE_NODE_W, 56, 280)
    const basePosById = new Map()
    devices.forEach((d, i) => {
      const angle = (Math.PI * 2 * i) / total - Math.PI / 2
      const x = CENTER_X + Math.cos(angle) * devRing
      const y = CENTER_Y + Math.sin(angle) * devRing
      basePosById.set(`dev-${d.name}`, { x, y })
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
          es.push({ id: `e-${devId}-${faultId}`, source: devId, target: faultId, animated: true, style: { stroke: '#faad14' } })
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
              es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' } })
            })
          }
        })
      }
    })
    return { nodes: ns, edges: es }
  }, [devices, activeDeviceId, activeFaultId, focusDeviceId, transitionPhase, faultFocus, pinnedDevicePos])

  const onNodeClick = (_, node) => {
    if (node.id.startsWith('dev-')) {
      const isSameExpandedDevice = transitionPhase === 'expanded' && activeDeviceId === node.id && !faultFocus
      if (isSameExpandedDevice) {
        clearTimers()
        setActiveDeviceId(null)
        setActiveFaultId(null)
        setFaultFocus(null)
        setFocusDeviceId(null)
        setPinnedDevicePos(null)
        setTransitionPhase('idle')
        if (rf) {
          rf.fitView({ duration: 720, padding: 0.2 })
        }
        return
      }
      const fromFaultScene = transitionPhase === 'faultFocusing' || transitionPhase === 'faultExpanded'
      const nextSelected = node.id
      if (rf) {
        if (nextSelected) {
          const p = node.positionAbsolute || node.position
          clearTimers()
          if (fromFaultScene) {
            rf.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { zoom: 1.04, duration: 520 })
            const t0 = setTimeout(() => {
              setFaultFocus(null)
              setActiveFaultId(null)
              setActiveDeviceId(null)
              setPinnedDevicePos({ deviceId: node.id, x: p.x, y: p.y })
              setFocusDeviceId(node.id)
              setTransitionPhase('focusing')
              rf.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { zoom: 1.06, duration: 640 })
              const t1 = setTimeout(() => {
                setActiveDeviceId(node.id)
                setActiveFaultId(null)
                setTransitionPhase('expanded')
                const device = devices.find(d => `dev-${d.name}` === node.id)
                const faultCount = Math.max((device?.faults || []).length, 1)
                const targetZoom = faultCount <= 3 ? 0.98 : faultCount <= 5 ? 0.9 : 0.82
                rf.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { zoom: targetZoom, duration: 680 })
              }, 660)
              timersRef.current = [t1]
            }, 520)
            timersRef.current = [t0]
          } else {
            setPinnedDevicePos(null)
            setFocusDeviceId(node.id)
            setTransitionPhase('focusing')
            rf.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { zoom: 1.06, duration: 760 })
            const t1 = setTimeout(() => {
              setActiveDeviceId(node.id)
              setActiveFaultId(null)
              setTransitionPhase('expanded')
              const device = devices.find(d => `dev-${d.name}` === node.id)
              const faultCount = Math.max((device?.faults || []).length, 1)
              const targetZoom = faultCount <= 3 ? 0.98 : faultCount <= 5 ? 0.9 : 0.82
              rf.setCenter(p.x + DEVICE_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { zoom: targetZoom, duration: 680 })
            }, 780)
            const t2 = setTimeout(() => {
              setTransitionPhase('expanded')
            }, 920)
            timersRef.current = [t1, t2]
          }
        }
      }
      if (!rf) {
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
      const sameFault = faultFocus && faultFocus.deviceId === node.data?.deviceId && faultFocus.faultIndex === node.data?.faultIndex
      if (sameFault) {
        setFaultFocus(null)
        setTransitionPhase('expanded')
        if (rf) {
          const p = node.positionAbsolute || node.position
          rf.setCenter(p.x + FAULT_NODE_W / 2, p.y + DEVICE_NODE_H / 2, { zoom: 0.94, duration: 520 })
        }
        return
      }
      const p = node.positionAbsolute || node.position
      setActiveFaultId(node.id)
      setFaultFocus({
        deviceId: node.data?.deviceId,
        faultIndex: node.data?.faultIndex,
        side: node.data?.side || 'right',
        anchorX: p.x,
        anchorY: p.y
      })
      setTransitionPhase('faultFocusing')
      if (rf) {
        rf.setCenter(p.x + FAULT_NODE_W / 2, p.y + CLOUD_CENTER_Y_OFFSET, { zoom: 1.1, duration: 620 })
        clearTimers()
        const t1 = setTimeout(() => {
          setTransitionPhase('faultExpanded')
        }, 650)
        timersRef.current = [t1]
      }
      return
    }
    if (rf) {
      const p = node.positionAbsolute || node.position
      const kind = node.data?.kind || 'device'
      const w = kind === 'solution' ? SOLUTION_NODE_W : DEVICE_NODE_W
      const h = kind === 'solution' ? SOLUTION_NODE_H : DEVICE_NODE_H
      if (!node.id.startsWith('dev-') && transitionPhase !== 'faultFocusing') {
        rf.setCenter(p.x + w / 2, p.y + (kind === 'solution' ? h / 2 : CLOUD_CENTER_Y_OFFSET), { zoom: 1.16, duration: 620 })
      }
    }
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 16 }}>
        <Title level={3} className="page-title">数据云图</Title>
        <Text type="secondary">先展示设备，点击设备展开故障，点击故障展开解决方案</Text>
      </div>

      <Card className="glass-card" style={{ marginBottom: 16 }}>
        <Space wrap align="start" style={{ width: '100%' }}>
          <div style={{ minWidth: 260 }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>查看流水线</Text>
            <AutoComplete
              style={{ width: 160 }}
              value={line}
              options={pipelines.map(p => ({ value: p }))}
              onChange={setLine}
              filterOption={(inputValue, option) => (option?.value || '').toLowerCase().includes(inputValue.toLowerCase())}
            />
            <div style={{ marginTop: 8 }}>
              <Tag color="blue">{line}</Tag>
              <Tag>{devices.length} 个设备</Tag>
            </div>
          </div>
          <Button type="primary" onClick={handleRebuild} loading={rebuilding}>
            重建当前流水线数据
          </Button>
        </Space>
      </Card>

      <Card className="glass-card" bodyStyle={{ padding: 0 }}>
        {devices.length === 0 ? (
          <div style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description={`当前${line}暂无可展示的设备图谱`} />
          </div>
        ) : (
          <div style={{ height: 560 }}>
            <ReactFlow nodes={nodes} edges={edges} onNodeClick={onNodeClick} onInit={handleFlowInit} nodeTypes={nodeTypes}>
              <MiniMap />
              <Controls />
              <Background />
            </ReactFlow>
          </div>
        )}
      </Card>
    </div>
  )
}
