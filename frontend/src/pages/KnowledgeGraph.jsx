import React, { useEffect, useMemo, useState } from 'react'
import { Card, Typography, Space, Empty, Tag, AutoComplete, Button, message } from 'antd'
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow'
import 'reactflow/dist/style.css'
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

export default function KnowledgeGraph() {
  const [line, setLine] = useState('流水线1')
  const [pipelines, setPipelines] = useState(['流水线1'])
  const [devices, setDevices] = useState([])
  const [expandDevices, setExpandDevices] = useState({})
  const [expandFaults, setExpandFaults] = useState({})
  const [rf, setRf] = useState(null)
  const [rebuilding, setRebuilding] = useState(false)

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
      message.info(`当前图谱：${data?.device_count || next.length || 0} 个设备，${data?.fault_count || 0} 条故障`)
    } catch (e) {
      message.error('重建失败: ' + (e.response?.data?.detail || e.message))
    }
    setRebuilding(false)
  }

  const { nodes, edges } = useMemo(() => {
    const ns = []
    const es = []
    devices.forEach((d, i) => {
      const x = 120 + (i % 6) * 210
      const y = 120 + Math.floor(i / 6) * 120
      const devId = `dev-${d.name}`
      ns.push({
        id: devId,
        data: { label: d.name },
        position: { x, y },
        style: { border: '1px solid #91caff', background: '#f0f5ff', borderRadius: 10, width: 180, padding: 8 }
      })
      if (expandDevices[devId]) {
        ;(d.faults || []).forEach((f, fi) => {
          const fx = x - 130 + (fi % 3) * 130
          const fy = y + 160 + Math.floor(fi / 3) * 90
          const faultId = `fault-${d.name}-${fi}`
          ns.push({
            id: faultId,
            data: { label: f.name },
            position: { x: fx, y: fy },
            style: { border: '1px dashed #faad14', background: '#fffbe6', borderRadius: 16, width: 160, padding: '6px 10px' }
          })
          es.push({ id: `e-${devId}-${faultId}`, source: devId, target: faultId, animated: true, style: { stroke: '#faad14' } })
          if (expandFaults[faultId]) {
            ;(f.solutions || []).forEach((s, si) => {
              const sx = fx - 100 + (si % 2) * 180
              const sy = fy + 130 + Math.floor(si / 2) * 78
              const solId = `sol-${d.name}-${fi}-${si}`
              ns.push({
                id: solId,
                data: { label: s },
                position: { x: sx, y: sy },
                style: { border: '1px solid #95de64', background: '#f6ffed', borderRadius: 16, width: 200, padding: '6px 10px' }
              })
              es.push({ id: `e-${faultId}-${solId}`, source: faultId, target: solId, style: { stroke: '#95de64' } })
            })
          }
        })
      }
    })
    return { nodes: ns, edges: es }
  }, [devices, expandDevices, expandFaults])

  const onNodeClick = (_, node) => {
    if (node.id.startsWith('dev-')) {
      setExpandDevices((prev) => ({ ...prev, [node.id]: !prev[node.id] }))
    }
    if (node.id.startsWith('fault-')) {
      setExpandFaults((prev) => ({ ...prev, [node.id]: !prev[node.id] }))
    }
    if (rf) {
      const p = node.position
      rf.setCenter(p.x + 90, p.y + 30, { zoom: 1.2, duration: 350 })
    }
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 16 }}>
        <Title level={3} className="page-title">知识图谱</Title>
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
            重建当前流水线图谱
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
            <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={onNodeClick} onInit={setRf}>
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
