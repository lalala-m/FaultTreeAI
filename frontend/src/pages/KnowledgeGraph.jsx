import React, { useEffect, useMemo, useState } from 'react'
import { Card, Typography, Space, Empty, Tag, AutoComplete, Button, message } from 'antd'
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow'
import 'reactflow/dist/style.css'
import api from '../services/api.js'

const { Title, Text } = Typography

const sanitizeDevices = (arr) => {
  const devs = Array.isArray(arr) ? arr : []
  return devs
    .map(d => {
      const faults = (d.faults || [])
        .map(f => ({
          name: String(f?.name || '').trim(),
          causes: (Array.isArray(f?.solutions) ? f.solutions : [])
            .map(s => String(s || '').trim())
            .filter(s => s.length >= 2)
            .slice(0, 12),
        }))
        .filter(f => f.name.length >= 2 && f.causes.length > 0)
        .slice(0, 12)
      return { name: String(d?.name || '').trim(), faults }
    })
    .filter(d => d.name.length >= 2 && d.faults.length > 0)
}

const inferDeviceFromFilename = (name) => {
  const n = String(name || '').replace(/\.[^.]+$/, '')
  const m = n.match(/([\u4e00-\u9fff]{2,20})(维修保养手册|维修手册|保养手册)?/)
  return (m && m[1]) ? m[1] : (n || '设备')
}

export default function KnowledgeGraph() {
  const [line, setLine] = useState('')
  const [pipelines, setPipelines] = useState([])
  const [devices, setDevices] = useState([])
  const [rf, setRf] = useState(null)
  const [rebuilding, setRebuilding] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const all = await api.listPipelines()
        const p = Array.from(new Set((all || []).filter(Boolean)))
        if (p.length === 0) p.push('流水线1')
        setPipelines(p)
        const activeLine = p.includes(line) && String(line || '').trim() ? line : (p[0] || '流水线1')
        if (activeLine !== line) setLine(activeLine)

        const data = await api.getKnowledgeGraph(activeLine)
        let next = sanitizeDevices(data?.devices)
        if ((!next || next.length === 0) && (data?.doc_count || 0) > 0) {
          const docs = await api.listDocuments()
          const byPipe = (Array.isArray(docs) ? docs : []).filter(d => (d.pipeline || '流水线1') === activeLine && d.status === 'active')
          next = byPipe.slice(0, 8).map(d => ({
            name: inferDeviceFromFilename(d.filename),
            faults: [{ name: '设备运行异常', causes: ['请在知识库中补充“故障-原因”结构化知识后重建图谱'] }]
          }))
        }
        setDevices(next)
      } catch {
        setDevices([])
      }
    }
    load()
  }, [line])

  const handleRebuild = async () => {
    try {
      setRebuilding(true)
      const activeLine = (line || pipelines[0] || '流水线1').trim() || '流水线1'
      const ret = await api.rebuildKnowledgeGraph({ pipeline: activeLine, mode: 'auto' })
      message.success(`重建完成：成功 ${ret.rebuilt || 0}，失败 ${ret.failed || 0}`)
      if (Array.isArray(ret.ai_errors) && ret.ai_errors.length > 0) {
        message.warning(`AI 抽取部分失败：${ret.ai_errors[0]}`)
      }
      const data = await api.getKnowledgeGraph(activeLine)
      let next = sanitizeDevices(data?.devices)
      if ((!next || next.length === 0) && (data?.doc_count || 0) > 0) {
        const docs = await api.listDocuments()
        const byPipe = (Array.isArray(docs) ? docs : []).filter(d => (d.pipeline || '流水线1') === activeLine && d.status === 'active')
        next = byPipe.slice(0, 8).map(d => ({
          name: inferDeviceFromFilename(d.filename),
          faults: [{ name: '设备运行异常', causes: ['请在知识库中补充“故障-原因”结构化知识后重建图谱'] }]
        }))
      }
      setDevices(next)
      message.info(`当前图谱：${data?.device_count || next.length || 0} 个设备，${data?.fault_count || 0} 条故障`)
    } catch (e) {
      message.error('重建失败: ' + (e.response?.data?.detail || e.message))
    }
    setRebuilding(false)
  }

  const stats = useMemo(() => {
    const deviceCount = devices.length
    const faultCount = devices.reduce((sum, d) => sum + (d.faults?.length || 0), 0)
    const causeCount = devices.reduce((sum, d) => sum + (d.faults || []).reduce((s2, f) => s2 + (f.causes?.length || 0), 0), 0)
    return { deviceCount, faultCount, causeCount }
  }, [devices])

  const { nodes, edges } = useMemo(() => {
    const ns = []
    const es = []

    const deviceWidth = 240
    const faultWidth = 190
    const causeWidth = 300
    const deviceGap = 140
    const faultGap = 240
    const causeGapY = 76
    const level1GapY = 130
    const level2GapY = 120

    let cursorX = 120
    const baseY = 80

    devices.forEach((d) => {
      const devId = `dev-${d.name}`
      ns.push({
        id: devId,
        data: { label: d.name },
        position: { x: cursorX, y: baseY },
        style: { border: '1px solid #91caff', background: '#f0f5ff', borderRadius: 10, width: deviceWidth, padding: 10, fontWeight: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.2 }
      })

      const faults = Array.isArray(d.faults) ? d.faults : []
      const faultCount = faults.length
      const rootCenterX = cursorX + deviceWidth / 2
      const faultStartX = rootCenterX - ((faultCount - 1) * faultGap) / 2 - faultWidth / 2
      const faultY = baseY + level1GapY

      faults.forEach((f, fi) => {
        const faultId = `fault-${d.name}-${fi}`
        const fx = faultStartX + fi * faultGap
        ns.push({
          id: faultId,
          data: { label: f.name },
          position: { x: fx, y: faultY },
          style: { border: '1px dashed #faad14', background: '#fffbe6', borderRadius: 18, width: faultWidth, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.2 }
        })
        es.push({
          id: `e-${devId}-${faultId}`,
          source: devId,
          target: faultId,
          animated: true,
          style: { stroke: '#faad14' }
        })

        const causes = Array.isArray(f.causes) ? f.causes : []
        const baseCauseY = faultY + level2GapY
        causes.forEach((c, ci) => {
          const causeId = `cause-${d.name}-${fi}-${ci}`
          const cx = fx - (causeWidth - faultWidth) / 2
          const cy = baseCauseY + ci * causeGapY
          ns.push({
            id: causeId,
            data: { label: c },
            position: { x: cx, y: cy },
            style: { border: '1px solid #95de64', background: '#f6ffed', borderRadius: 16, width: causeWidth, padding: '8px 10px', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.25 }
          })
          es.push({ id: `e-${faultId}-${causeId}`, source: faultId, target: causeId, style: { stroke: '#95de64' } })
        })
      })

      const subWidth = Math.max(deviceWidth, (faultCount - 1) * faultGap + faultWidth)
      cursorX += subWidth + deviceGap
    })
    return { nodes: ns, edges: es }
  }, [devices])

  const onNodeClick = (_, node) => {
    if (rf) {
      const p = node.position
      rf.setCenter(p.x + 120, p.y + 30, { zoom: 1.15, duration: 350 })
    }
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 16 }}>
        <Title level={3} className="page-title">知识图谱</Title>
        <Text type="secondary">按流水线展示：机械 → 故障 → 导致原因</Text>
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
              <Tag>{stats.deviceCount} 个设备</Tag>
              <Tag>{stats.faultCount} 个故障</Tag>
              <Tag>{stats.causeCount} 条原因</Tag>
            </div>
          </div>
          <Button type="primary" onClick={handleRebuild} loading={rebuilding}>
            重建当前流水线图谱
          </Button>
        </Space>
      </Card>

      <Card className="glass-card" styles={{ body: { padding: 0 } }}>
        {devices.length === 0 ? (
          <div style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description={`当前${line}暂无可展示的设备图谱`} />
          </div>
        ) : (
          <div style={{ height: 560, width: '100%' }}>
            <ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={onNodeClick} onInit={setRf} style={{ width: '100%', height: '100%' }}>
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
