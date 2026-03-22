import React, { useCallback, useState, useMemo } from 'react'
import ReactFlow, {
  addNode,
  removeNodes,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  MarkerType,
  Handle,
  Position,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Card, Button, Space, message, Modal, Form, Input, Select, Tag, Typography } from 'antd'
import { PlusOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons'

const { Text } = Typography

// 节点样式配置
const NODE_COLORS = {
  top: '#1677ff',
  and: '#52c41a',
  or: '#fa8c16',
  xor: '#eb2f96',
  basic: '#d9d9d9',
  intermediate: '#13c2c2',
}

// 自定义节点组件
function GateNode({ data, id }) {
  const color = NODE_COLORS[data.gate_type?.toLowerCase()] || '#999'
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

function BasicNode({ data, id }) {
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
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  )
}

function TopEventNode({ data, id }) {
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

const nodeTypes = {
  gate: GateNode,
  basic: BasicNode,
  top: TopEventNode,
}

export default function TreeEditor({ initialTree, onSave, onCancel }) {
  // 转换初始数据到 ReactFlow 格式
  const initialNodes = useMemo(() => {
    if (!initialTree) return []
    const nodesData = initialTree.fault_tree?.nodes || initialTree.nodes_json || []
    return nodesData.map((n) => ({
      id: n.id,
      type: n.type === 'top' ? 'top' : n.type === 'basic' ? 'basic' : 'gate',
      position: n.position || { x: Math.random() * 400, y: Math.random() * 400 },
      data: {
        label: n.name,
        type: n.type,
        gate_type: n.gate_type,
      },
    }))
  }, [initialTree])

  const initialEdges = useMemo(() => {
    if (!initialTree) return []
    const gates = initialTree.fault_tree?.gates || initialTree.gates_json || []
    return gates.flatMap((g) => {
      const inputNodes = g.input_nodes || g.children || []
      return inputNodes.map((childId, i) => ({
        id: `${g.id}_${childId}_${i}`,
        source: g.output_node,
        target: childId,
        animated: g.gate_type === 'OR',
        label: g.gate_type,
        style: { stroke: NODE_COLORS[g.gate_type?.toLowerCase()] || '#999' },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: NODE_COLORS[g.gate_type?.toLowerCase()] || '#999',
        },
      }))
    })
  }, [initialTree])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [modalVisible, setModalVisible] = useState(false)
  const [modalType, setModalType] = useState('addNode')
  const [selectedNode, setSelectedNode] = useState(null)
  const [form] = Form.useForm()

  // 处理节点点击
  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node)
  }, [])

  // 添加节点
  const handleAddNode = () => {
    setModalType('addNode')
    setSelectedNode(null)
    form.resetFields()
    setModalVisible(true)
  }

  // 添加边（连接两个节点）
  const handleAddEdge = () => {
    setModalType('addEdge')
    form.resetFields()
    setModalVisible(true)
  }

  // 删除选中节点
  const handleDeleteNode = () => {
    if (!selectedNode) {
      message.warning('请先选择要删除的节点')
      return
    }
    setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id))
    setEdges((eds) => eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id))
    setSelectedNode(null)
    message.success('节点已删除')
  }

  // 提交表单
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      
      if (modalType === 'addNode') {
        const newNode = {
          id: `node_${Date.now()}`,
          type: values.nodeType === 'basic' ? 'basic' : values.nodeType === 'top' ? 'top' : 'gate',
          position: { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 },
          data: {
            label: values.label,
            type: values.nodeType,
            gate_type: values.gateType,
          },
        }
        setNodes((nds) => [...nds, newNode])
        message.success('节点已添加')
      } else if (modalType === 'addEdge') {
        const newEdge = {
          id: `edge_${Date.now()}`,
          source: values.sourceNode,
          target: values.targetNode,
          animated: true,
          style: { stroke: '#999' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#999' },
        }
        setEdges((eds) => [...eds, newEdge])
        message.success('连接已添加')
      }
      
      setModalVisible(false)
    } catch (err) {
      console.error(err)
    }
  }

  // 保存编辑结果
  const handleSave = async () => {
    // 将 nodes/edges 转换回故障树结构
    const ftNodes = nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.data.label,
      description: '',
    }))

    const ftGates = []
    edges.forEach((e) => {
      const existingGate = ftGates.find((g) => g.output_node === e.source)
      if (existingGate) {
        existingGate.input_nodes.push(e.target)
      } else {
        const sourceNode = nodes.find((n) => n.id === e.source)
        ftGates.push({
          id: `gate_${e.source}`,
          type: sourceNode?.data?.gate_type || 'OR',
          output_node: e.source,
          input_nodes: [e.target],
        })
      }
    })

    const faultTree = {
      top_event: nodes.find((n) => n.type === 'top')?.data?.label || '顶事件',
      nodes: ftNodes,
      gates: ftGates,
      confidence: 0.9,
      analysis_summary: '用户编辑',
    }

    await onSave({
      nodes: ftNodes,
      gates: ftGates,
      fault_tree: faultTree,
    })
    message.success('保存成功')
  }

  return (
    <Card
      title="故障树编辑器"
      extra={
        <Space>
          <Button icon={<PlusOutlined />} onClick={handleAddNode}>添加节点</Button>
          <Button icon={<PlusOutlined />} onClick={handleAddEdge}>添加连接</Button>
          <Button icon={<DeleteOutlined />} onClick={handleDeleteNode} danger>删除选中</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave}>保存</Button>
          {onCancel && <Button onClick={onCancel}>取消</Button>}
        </Space>
      }
    >
      <div style={{ height: 500, border: '1px solid #d9d9d9', borderRadius: 6 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
        >
          <Controls />
          <Background />
        </ReactFlow>
      </div>

      <Modal
        title={modalType === 'addNode' ? '添加节点' : '添加连接'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
      >
        {modalType === 'addNode' ? (
          <Form form={form} layout="vertical">
            <Form.Item name="nodeType" label="节点类型" rules={[{ required: true }]}>
              <Select onChange={(v) => form.setFieldValue('nodeType', v)}>
                <Select.Option value="basic">底事件</Select.Option>
                <Select.Option value="intermediate">中间事件</Select.Option>
                <Select.Option value="top">顶事件</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="label" label="节点名称" rules={[{ required: true }]}>
              <Input placeholder="请输入节点名称" />
            </Form.Item>
            <Form.Item name="gateType" label="逻辑门类型" dependencies={['nodeType']}>
              {({ getFieldValue }) => (
                getFieldValue('nodeType') === 'gate' || getFieldValue('nodeType') === 'intermediate' ? (
                  <Select placeholder="选择逻辑门类型">
                    <Select.Option value="AND">AND 与门</Select.Option>
                    <Select.Option value="OR">OR 或门</Select.Option>
                  </Select>
                ) : null
              )}
            </Form.Item>
          </Form>
        ) : (
          <Form form={form} layout="vertical">
            <Form.Item name="sourceNode" label="源节点（父节点）" rules={[{ required: true }]}>
              <Select placeholder="选择源节点">
                {nodes.map((n) => (
                  <Select.Option key={n.id} value={n.id}>
                    {n.data.label} ({n.type})
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
            <Form.Item name="targetNode" label="目标节点（子节点）" rules={[{ required: true }]}>
              <Select placeholder="选择目标节点">
                {nodes.map((n) => (
                  <Select.Option key={n.id} value={n.id}>
                    {n.data.label} ({n.type})
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Card>
  )
}
