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
      minWidth: 100,
      fontSize: 12,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ fontWeight: 700, color, fontSize: 11, marginBottom: 4 }}>
        {data.gate_type?.toUpperCase() || 'GATE'}
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
      minWidth: 120,
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
      minWidth: 140,
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

export default function FaultTreeViewer({ tree }) {
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
      childrenByParent.get(parent).push(...inputNodes)
    })

    const topNode = nodesData.find(n => n.type === 'top') || nodesData[0]
    const topId = topNode?.id

    const depthById = new Map()
    const queue = []
    if (topId) {
      depthById.set(topId, 0)
      queue.push(topId)
    }
    while (queue.length) {
      const cur = queue.shift()
      const curDepth = depthById.get(cur) ?? 0
      const children = childrenByParent.get(cur) || []
      for (const child of children) {
        const nextDepth = curDepth + 1
        const prev = depthById.get(child)
        if (prev == null || nextDepth < prev) {
          depthById.set(child, nextDepth)
          queue.push(child)
        }
      }
    }

    const groups = new Map()
    nodesData.forEach(n => {
      const d = depthById.get(n.id)
      const depth = d == null ? 9999 : d
      if (!groups.has(depth)) groups.set(depth, [])
      groups.get(depth).push(n)
    })

    const sortedDepths = Array.from(groups.keys()).sort((a, b) => a - b)
    const maxCount = Math.max(1, ...sortedDepths.map(d => groups.get(d).length))

    const nodeWidth = 220
    const nodeGapX = 70
    const nodeGapY = 140
    const layoutMap = new Map()

    sortedDepths.forEach((depth, depthIndex) => {
      const arr = groups.get(depth)
      const ordered = [...arr].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      const levelWidth = ordered.length * nodeWidth + Math.max(0, ordered.length - 1) * nodeGapX
      const maxWidth = maxCount * nodeWidth + Math.max(0, maxCount - 1) * nodeGapX
      const xStart = (maxWidth - levelWidth) / 2
      const y = depthIndex * nodeGapY + 40
      ordered.forEach((n, i) => {
        const x = xStart + i * (nodeWidth + nodeGapX)
        layoutMap.set(n.id, { x, y })
      })
    })

    return { nodesData, gatesData, layoutMap }
  }, [tree])

  // 修正：支持 fault_tree 嵌套结构和直接数据两种格式
  const nodes = useMemo(() => {
    const nodesData = layouted.nodesData
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
          gate_type: n.gate_type,
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
      return inputNodes.map((childId, i) => ({
        id: `${g.output_node}_${childId}_${i}`,
        source: g.output_node,   // 逻辑门是源（上游）
        target: childId,          // 子节点是目标（下游）
        animated: String(g.gate_type || '').toUpperCase() === 'OR',
        label: g.gate_type,
        style: { stroke: NODE_COLORS[g.gate_type?.toLowerCase()] || '#999' },
        markerEnd: { 
          type: MarkerType.ArrowClosed, 
          color: NODE_COLORS[g.gate_type?.toLowerCase()] || '#999' 
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
      bodyStyle={{ padding: 0 }}
    >
      <div style={{ height: 500, background: '#fafafa' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </Card>
  )
}
