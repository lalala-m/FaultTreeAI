import React, { useMemo } from 'react'
import ReactFlow, {
  MarkerType,
  Handle,
  Position,
  Background,
  Controls,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Card, Tag, Typography, Space } from 'antd'

const { Text } = Typography

// ── 节点样式配置 ──────────────────────────────────────

const NODE_COLORS = {
  top: '#1677ff',
  and: '#52c41a',
  or: '#fa8c16',
  xor: '#eb2f96',
  basic: '#d9d9d9',
  intermediate: '#13c2c2',
  undeveloped: '#722ed1',
  inhibit: '#cf1322',
}

function GateNode({ data }) {
  const color = NODE_COLORS[data.type] || '#999'
  return (
    <div style={{
      padding: '8px 16px',
      border: `2px solid ${color}`,
      borderRadius: 8,
      background: '#fff',
      textAlign: 'center',
      minWidth: 90,
      fontSize: 12,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ fontWeight: 700, color, fontSize: 11, marginBottom: 4 }}>
        {String(data.gate_type || '').toUpperCase() || 'EVENT'}
      </div>
      <div style={{ fontSize: 13 }}>{data.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  )
}

function BasicNode({ data }) {
  const color = NODE_COLORS[data.type] || '#999'
  return (
    <div style={{
      padding: '10px 16px',
      border: `2px solid ${color}`,
      borderRadius: 20,
      background: '#fff',
      textAlign: 'center',
      minWidth: 105,
      fontSize: 13,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ fontWeight: 600, color }}>{data.label}</div>
      {data.probability != null && (
        <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
          P={data.probability}
        </div>
      )}
    </div>
  )
}

function TopEventNode({ data }) {
  const color = NODE_COLORS.top
  return (
    <div style={{
      padding: '12px 20px',
      border: `3px solid ${color}`,
      borderRadius: 4,
      background: '#e6f4ff',
      textAlign: 'center',
      minWidth: 125,
      fontWeight: 700,
    }}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div style={{ color, fontSize: 14 }}>{data.label}</div>
      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>顶事件</div>
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  )
}

const nodeTypes = { gate: GateNode, basic: BasicNode, top: TopEventNode }

// ── 主组件 ─────────────────────────────────────────────

export default function FaultTreeViewer({ tree, height }) {
  const layouted = useMemo(() => {
    const nodesData = tree.fault_tree?.nodes || tree.nodes_json || []
    const gatesData = tree.fault_tree?.gates || tree.gates_json || []

    const nodeById = new Map()
    nodesData.forEach(n => nodeById.set(n.id, n))

    const childrenByParent = new Map()
    gatesData.forEach(g => {
      const inputNodes = g.input_nodes || g.children || []
      const parent = g.output_node
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
      inputNodes.forEach((cid) => {
        const arr = childrenByParent.get(parent)
        if (!arr.includes(cid)) arr.push(cid)
      })
    })

    const topNode = nodesData.find(n => n.type === 'top') || nodesData.find(n => n && n.id) || null
    const topId = topNode?.id

    const nodeWidth = 180
    const nodeGapX = 40
    const nodeGapY = 120
    const layoutMap = new Map()
    const visited = new Set()
    let cursorX = 0

    const getNodeName = (id) => {
      const n = nodeById.get(id)
      return (n?.name || '').toString()
    }

    const layoutDfs = (id, depth) => {
      if (!id) return null
      if (visited.has(id)) return layoutMap.get(id) || null
      visited.add(id)

      const children = (childrenByParent.get(id) || []).slice().sort((a, b) => getNodeName(a).localeCompare(getNodeName(b)))
      const childPositions = []
      for (const cid of children) {
        const cp = layoutDfs(cid, depth + 1)
        if (cp) childPositions.push(cp)
      }

      let x = cursorX
      if (childPositions.length === 0) {
        x = cursorX
        cursorX += nodeWidth + nodeGapX
      } else {
        const minX = Math.min(...childPositions.map(p => p.x))
        const maxX = Math.max(...childPositions.map(p => p.x))
        x = (minX + maxX) / 2
      }

      const pos = { x, y: depth * nodeGapY + 40 }
      layoutMap.set(id, pos)
      return pos
    }

    if (topId) layoutDfs(topId, 0)
    nodesData.forEach((n) => {
      if (!layoutMap.has(n.id)) {
        cursorX += nodeWidth + nodeGapX
        layoutDfs(n.id, 0)
      }
    })

    const xs = Array.from(layoutMap.values()).map(p => p.x)
    const minX = xs.length ? Math.min(...xs) : 0
    const shiftX = -minX + 40
    layoutMap.forEach((p, id) => {
      layoutMap.set(id, { x: p.x + shiftX, y: p.y })
    })

    return { nodesData, gatesData, layoutMap }
  }, [tree])

  // 修正：支持 fault_tree 嵌套结构和直接数据两种格式
  const nodes = useMemo(() => {
    const nodesData = layouted.nodesData
    const gatesData = layouted.gatesData
    const gateTypeByOutput = new Map()
    gatesData.forEach((g) => {
      const t = g.type || g.gate_type
      if (t) gateTypeByOutput.set(g.output_node, String(t).toUpperCase())
    })
    return nodesData.map((n) => {
      const color = NODE_COLORS[n.type] || '#999'
      const hasPos = n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number'
      const pos = hasPos ? n.position : (layouted.layoutMap.get(n.id) || { x: 0, y: 0 })
      return {
        id: n.id,
        type: n.type === 'top' ? 'top' : n.type === 'basic' ? 'basic' : 'gate',
        position: pos,
        data: {
          label: n.name,  // 修正：字段是 name 不是 label
          type: n.type,
          gate_type: gateTypeByOutput.get(n.id),
          probability: n.probability,
        },
        style: { border: `2px solid ${color}` },
      }
    })
  }, [layouted])

  // 修正：边方向 - 逻辑门是源（上游），子节点是目标（下游）
  // 同时修正字段名：g.input_nodes 或 g.children
  const edges = useMemo(() => {
    const gates = layouted.gatesData
    return gates.flatMap((g) => {
      // 兼容 input_nodes 或 children 字段
      const inputNodes = g.input_nodes || g.children || []
      const gateType = String(g.type || g.gate_type || '').toUpperCase()
      return inputNodes.map((childId, i) => ({
        id: `${g.output_node}_${childId}_${i}`,
        source: g.output_node,   // 逻辑门是源（上游）
        target: childId,          // 子节点是目标（下游）
        animated: gateType === 'OR',
        label: gateType,
        style: { stroke: NODE_COLORS[gateType.toLowerCase()] || '#999' },
        markerEnd: { 
          type: MarkerType.ArrowClosed, 
          color: NODE_COLORS[gateType.toLowerCase()] || '#999' 
        },
      }))
    })
  }, [layouted])

  if (!nodes.length) {
    return (
      <Card>
        <Text type="secondary">暂无故障树数据</Text>
      </Card>
    )
  }

  const containerHeight = (typeof height === 'number' ? `${height}px` : (height || '500px'))

  return (
    <Card
      title="故障树结构图"
      extra={
        <Space>
          {['and', 'or', 'xor'].map(t => (
            <Tag key={t} color={NODE_COLORS[t]} style={{ fontSize: 11 }}>
              {t.toUpperCase()}
            </Tag>
          ))}
          <Tag color={NODE_COLORS.basic}>底事件</Tag>
          <Tag color={NODE_COLORS.top}>顶事件</Tag>
        </Space>
      }
      style={{ height: containerHeight }}
      styles={{ body: { padding: 0, height: '100%' } }}
    >
      <div style={{ height: '100%', width: '100%', background: '#fafafa' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          style={{ width: '100%', height: '100%' }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </Card>
  )
}
