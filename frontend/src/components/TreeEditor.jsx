import React, { useCallback, useState, useMemo } from 'react'
import ReactFlow, {
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  MarkerType,
  Handle,
  Position,
  MiniMap,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Card, Button, Space, message, Modal, Form, Input, Select, Tag, Typography, Alert, Divider } from 'antd'
import { PlusOutlined, DeleteOutlined, SaveOutlined, InfoCircleOutlined, DragOutlined } from '@ant-design/icons'

const { Text } = Typography

// 节点样式配置 - 深色主题
const NODE_COLORS = {
  top: '#1890ff',
  and: '#52c41a',
  or: '#faad14',
  xor: '#eb2f96',
  basic: '#8cbdff',
  intermediate: '#36cfc9',
}

// 自定义节点组件 - 逻辑门
function GateNode({ data, id }) {
  const color = NODE_COLORS[data.gate_type?.toLowerCase()] || '#999'
  return (
    <div style={{
      padding: '10px 20px',
      border: `2px solid ${color}`,
      borderRadius: 8,
      background: 'rgba(20, 27, 58, 0.95)',
      textAlign: 'center',
      minWidth: 120,
      fontSize: 12,
      boxShadow: `0 0 10px ${color}40`,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color, width: 8, height: 8 }} />
      <div style={{ fontWeight: 700, color, fontSize: 11, marginBottom: 4 }}>
        {data.gate_type?.toUpperCase() || 'GATE'}
      </div>
      <div style={{ fontSize: 13, color: '#e6f7ff' }}>{data.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: color, width: 8, height: 8 }} />
    </div>
  )
}

// 底事件节点
function BasicNode({ data, id }) {
  const color = NODE_COLORS.basic
  return (
    <div style={{
      padding: '12px 20px',
      border: `2px solid ${color}`,
      borderRadius: 20,
      background: 'rgba(20, 27, 58, 0.95)',
      textAlign: 'center',
      minWidth: 140,
      fontSize: 13,
      boxShadow: `0 0 10px ${color}30`,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color, width: 8, height: 8 }} />
      <div style={{ fontWeight: 600, color: '#e6f7ff' }}>{data.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: color, width: 8, height: 8 }} />
    </div>
  )
}

// 顶事件节点
function TopEventNode({ data, id }) {
  const color = NODE_COLORS.top
  return (
    <div style={{
      padding: '14px 24px',
      border: `3px solid ${color}`,
      borderRadius: 4,
      background: 'rgba(24, 144, 255, 0.15)',
      textAlign: 'center',
      minWidth: 160,
      fontWeight: 700,
      boxShadow: `0 0 20px ${color}50`,
    }}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div style={{ color: '#1890ff', fontSize: 15 }}>{data.label}</div>
      <div style={{ fontSize: 11, color: '#5c7a99', marginTop: 4 }}>顶事件</div>
      <Handle type="source" position={Position.Bottom} style={{ background: color, width: 8, height: 8 }} />
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
    return nodesData.map((n, idx) => ({
      id: n.id,
      type: n.type === 'top' ? 'top' : n.type === 'basic' ? 'basic' : 'gate',
      position: n.position || { x: 200 + (idx % 4) * 180, y: 50 + Math.floor(idx / 4) * 120 },
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
        style: { stroke: NODE_COLORS[g.gate_type?.toLowerCase()] || '#999', strokeWidth: 2 },
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
    if (nodes.length < 2) {
      message.warning('需要至少2个节点才能创建连接')
      return
    }
    setModalType('addEdge')
    form.resetFields()
    setModalVisible(true)
  }

  // 删除选中节点
  const handleDeleteNode = () => {
    if (!selectedNode) {
      message.warning('请先点击选择要删除的节点')
      return
    }
    if (selectedNode.type === 'top') {
      message.warning('顶事件不能删除')
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
        // 检查边是否已存在
        const exists = edges.some(e => e.source === values.sourceNode && e.target === values.targetNode)
        if (exists) {
          message.warning('这条连接已存在')
          return
        }
        
        const sourceNode = nodes.find(n => n.id === values.sourceNode)
        const newEdge = {
          id: `edge_${Date.now()}`,
          source: values.sourceNode,
          target: values.targetNode,
          animated: sourceNode?.data?.gate_type === 'OR',
          label: sourceNode?.data?.gate_type,
          style: { stroke: NODE_COLORS[sourceNode?.data?.gate_type?.toLowerCase()] || '#999', strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: NODE_COLORS[sourceNode?.data?.gate_type?.toLowerCase()] || '#999' },
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
    if (nodes.length === 0) {
      message.warning('没有可保存的节点')
      return
    }

    // 将 nodes/edges 转换回故障树结构
    const ftNodes = nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.data.label,
      description: '',
      gate_type: n.data.gate_type,
    }))

    const ftGates = []
    edges.forEach((e) => {
      const existingGate = ftGates.find((g) => g.output_node === e.source)
      if (existingGate) {
        if (!existingGate.input_nodes.includes(e.target)) {
          existingGate.input_nodes.push(e.target)
        }
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
      confidence: 0.85,
      analysis_summary: '经专家编辑优化',
    }

    await onSave({
      nodes: ftNodes,
      gates: ftGates,
      fault_tree: faultTree,
    })
    message.success('保存成功！')
  }

  return (
    <div>
      {/* 操作提示 */}
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        message="专家编辑模式"
        description={
          <div>
            <div>• <Text strong>点击节点</Text> 选中节点</div>
            <div>• <Text strong>拖拽节点</Text> 调整位置</div>
            <div>• <Text strong>下方按钮</Text> 添加/删除 节点和连接</div>
          </div>
        }
        style={{ marginBottom: 16 }}
      />

      {/* 工具栏 */}
      <Card size="small" className="glass-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Button 
            icon={<PlusOutlined />} 
            onClick={handleAddNode}
            className="btn-primary"
          >
            添加节点
          </Button>
          <Button 
            icon={<DragOutlined />} 
            onClick={handleAddEdge}
            disabled={nodes.length < 2}
          >
            添加连接
          </Button>
          <Divider type="vertical" />
          <Button 
            icon={<DeleteOutlined />} 
            onClick={handleDeleteNode} 
            danger
            disabled={!selectedNode}
          >
            删除选中
          </Button>
          <Divider type="vertical" />
          <Button 
            type="primary" 
            icon={<SaveOutlined />} 
            onClick={handleSave}
            className="btn-primary"
          >
            保存修改
          </Button>
          {onCancel && (
            <Button onClick={onCancel}>
              取消
            </Button>
          )}
        </Space>

        {/* 选中节点信息 */}
        {selectedNode && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(24,144,255,0.1)', borderRadius: 4 }}>
            <Text strong style={{ color: '#1890ff' }}>当前选中：</Text>
            <Text style={{ color: '#e6f7ff', marginLeft: 8 }}>
              {selectedNode.data.label} 
              <Tag style={{ marginLeft: 8 }} color={NODE_COLORS[selectedNode.type]}>
                {selectedNode.type === 'top' ? '顶事件' : selectedNode.type === 'basic' ? '底事件' : '中间事件'}
              </Tag>
            </Text>
          </div>
        )}
      </Card>

      {/* 画布 */}
      <div style={{ 
        height: 500, 
        border: '1px solid rgba(24,144,255,0.2)', 
        borderRadius: 8,
        overflow: 'hidden',
        background: 'rgba(10, 14, 39, 0.8)',
      }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          style={{ background: 'transparent' }}
        >
          <Controls style={{ background: '#141b3a', border: '1px solid rgba(24,144,255,0.2)' }} />
          <Background color="#1890ff" gap={20} style={{ opacity: 0.1 }} />
          <MiniMap 
            nodeColor={(n) => NODE_COLORS[n.type]}
            maskColor="rgba(10, 14, 39, 0.8)"
            style={{ background: '#141b3a' }}
          />
        </ReactFlow>
      </div>

      {/* 添加节点/边的弹窗 */}
      <Modal
        title={modalType === 'addNode' ? '添加节点' : '添加连接'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="确认"
        cancelText="取消"
      >
        {modalType === 'addNode' ? (
          <Form form={form} layout="vertical">
            <Form.Item name="nodeType" label="节点类型" rules={[{ required: true, message: '请选择节点类型' }]}>
              <Select placeholder="选择节点类型">
                <Select.Option value="basic">
                  <Tag color={NODE_COLORS.basic}>底事件</Tag> 最底层的故障原因
                </Select.Option>
                <Select.Option value="intermediate">
                  <Tag color={NODE_COLORS.intermediate}>中间事件</Tag> 连接上层和底层的中间层
                </Select.Option>
                <Select.Option value="top">
                  <Tag color={NODE_COLORS.top}>顶事件</Tag> 整个故障树的起点
                </Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="label" label="节点名称" rules={[{ required: true, message: '请输入节点名称' }]}>
              <Input placeholder="请输入节点名称，如：电源断开" />
            </Form.Item>
            <Form.Item name="gateType" label="逻辑门类型" dependencies={['nodeType']}>
              {({ getFieldValue }) => (
                getFieldValue('nodeType') === 'gate' || getFieldValue('nodeType') === 'intermediate' ? (
                  <Form.Item name="gateType" rules={[{ required: true, message: '请选择逻辑门类型' }]}>
                    <Select placeholder="选择逻辑门类型">
                      <Select.Option value="AND">
                        <Tag color={NODE_COLORS.and}>AND 与门</Tag> 所有输入都发生才触发
                      </Select.Option>
                      <Select.Option value="OR">
                        <Tag color={NODE_COLORS.or}>OR 或门</Tag> 任一输入发生即触发
                      </Select.Option>
                    </Select>
                  </Form.Item>
                ) : null
              )}
            </Form.Item>
          </Form>
        ) : (
          <Form form={form} layout="vertical">
            <Form.Item name="sourceNode" label="源节点（父节点）" rules={[{ required: true, message: '请选择源节点' }]}>
              <Select placeholder="选择源节点">
                {nodes.map((n) => (
                  <Select.Option key={n.id} value={n.id}>
                    {n.data.label} 
                    <Tag style={{ marginLeft: 8 }} color={NODE_COLORS[n.type]}>
                      {n.type === 'top' ? '顶事件' : n.type === 'basic' ? '底事件' : n.data.gate_type}
                    </Tag>
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
            <Form.Item name="targetNode" label="目标节点（子节点）" rules={[{ required: true, message: '请选择目标节点' }]}>
              <Select placeholder="选择目标节点">
                {nodes.map((n) => (
                  <Select.Option key={n.id} value={n.id}>
                    {n.data.label}
                    <Tag style={{ marginLeft: 8 }} color={NODE_COLORS[n.type]}>
                      {n.type === 'top' ? '顶事件' : n.type === 'basic' ? '底事件' : n.data.gate_type}
                    </Tag>
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  )
}
