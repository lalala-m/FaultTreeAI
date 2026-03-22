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
  // 修正：支持 fault_tree 嵌套结构和直接数据两种格式
  const nodes = useMemo(() => {
    const nodesData = tree.fault_tree?.nodes || tree.nodes_json || []
    return nodesData.map((n) => {
      const color = NODE_COLORS[n.type] || '#999'
      return {
        id: n.id,
        type: n.type === 'top' ? 'top' : n.type === 'basic' ? 'basic' : 'gate',
        position: n.position || { x: 0, y: 0 },
        data: {
          label: n.name,  // 修正：字段是 name 不是 label
          type: n.type,
          gate_type: n.gate_type,
          probability: n.probability,
        },
        style: { border: `2px solid ${color}` },
      }
    })
  }, [tree])

  // 修正：边方向 - 逻辑门是源（上游），子节点是目标（下游）
  // 同时修正字段名：g.input_nodes 或 g.children
  const edges = useMemo(() => {
    const gates = tree.fault_tree?.gates || tree.gates_json || []
    return gates.flatMap((g) => {
      // 兼容 input_nodes 或 children 字段
      const inputNodes = g.input_nodes || g.children || []
      return inputNodes.map((childId, i) => ({
        id: `${g.output_node}_${childId}_${i}`,
        source: g.output_node,   // 逻辑门是源（上游）
        target: childId,          // 子节点是目标（下游）
        animated: g.gate_type === 'or',
        label: g.gate_type,
        style: { stroke: NODE_COLORS[g.gate_type?.toLowerCase()] || '#999' },
        markerEnd: { 
          type: MarkerType.ArrowClosed, 
          color: NODE_COLORS[g.gate_type?.toLowerCase()] || '#999' 
        },
      }))
    })
  }, [tree])

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
