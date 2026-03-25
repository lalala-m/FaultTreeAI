import React, { useMemo, useState } from 'react'
import { Card, Button, Space, Tag, Typography, Radio, Divider, List, Badge } from 'antd'

const { Text } = Typography

function DiagnosisPanel({ tree }) {
  const nodes = tree?.nodes_json || []
  const gates = tree?.gates_json || []
  const nodeMap = useMemo(() => {
    const m = new Map()
    nodes.forEach(n => m.set(n.id, n))
    return m
  }, [nodes])

  const gateByOutput = useMemo(() => {
    const m = new Map()
    gates.forEach(g => m.set(g.output_node, g))
    return m
  }, [gates])

  const leafIds = useMemo(() => {
    const outputs = new Set(gates.map(g => g.output_node))
    const ids = nodes
      .filter(n => n.type === 'basic' || !outputs.has(n.id))
      .map(n => n.id)
    return ids
  }, [nodes, gates])

  const [answers, setAnswers] = useState({})
  const setAnswer = (id, val) => {
    setAnswers(prev => ({ ...prev, [id]: val }))
  }

  const evalNode = (id) => {
    const gate = gateByOutput.get(id)
    if (!gate) {
      const v = answers[id] === true
      return { value: v, leaves: v ? new Set([id]) : new Set() }
    }
    const childIds = Array.isArray(gate.input_nodes) ? gate.input_nodes : (gate.children || [])
    if (gate.type === 'AND') {
      let allTrue = true
      const leaves = new Set()
      for (const cid of childIds) {
        const r = evalNode(cid)
        allTrue = allTrue && r.value
        r.leaves.forEach(l => leaves.add(l))
      }
      return { value: allTrue, leaves: allTrue ? leaves : new Set() }
    } else {
      let anyTrue = false
      const leaves = new Set()
      for (const cid of childIds) {
        const r = evalNode(cid)
        if (r.value) {
          anyTrue = true
          r.leaves.forEach(l => leaves.add(l))
        }
      }
      return { value: anyTrue, leaves }
    }
  }

  const topId = useMemo(() => {
    const top = nodes.find(n => n.type === 'top') || nodes[0]
    return top?.id
  }, [nodes])

  const result = useMemo(() => {
    if (!topId) return { ok: false, leaves: [] }
    const r = evalNode(topId)
    const leaves = Array.from(r.leaves || []).map(id => nodeMap.get(id)).filter(Boolean)
    return { ok: r.value, leaves }
  }, [answers, topId, gates, nodes])

  const leafItems = leafIds.map(id => {
    const n = nodeMap.get(id)
    const val = answers[id]
    return {
      id,
      name: n?.name || id,
      description: n?.description || '',
      value: val
    }
  })

  return (
    <Card className="glass-card" title={<Space>诊断排查</Space>}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>底事件判断</Text>
          <List
            dataSource={leafItems}
            renderItem={(item) => (
              <List.Item
                style={{ alignItems: 'flex-start' }}
                actions={[
                  <Radio.Group
                    key="rg"
                    value={item.value === true ? 'yes' : item.value === false ? 'no' : 'unknown'}
                    onChange={e => {
                      const v = e.target.value
                      setAnswer(item.id, v === 'yes' ? true : v === 'no' ? false : undefined)
                    }}
                  >
                    <Radio.Button value="yes">是</Radio.Button>
                    <Radio.Button value="no">否</Radio.Button>
                    <Radio.Button value="unknown">未知</Radio.Button>
                  </Radio.Group>
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Text>{item.name}</Text>
                      {item.value === true && <Tag color="red">发生</Tag>}
                      {item.value === false && <Tag>未发生</Tag>}
                      {item.value === undefined && <Tag color="default">未知</Tag>}
                    </Space>
                  }
                  description={item.description || '无检查提示'}
                />
              </List.Item>
            )}
          />
        </div>
        <div style={{ width: 320 }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>推理结果</Text>
          <Card>
            <div style={{ marginBottom: 8 }}>
              <Space>
                <Text>顶事件</Text>
                <Badge status={result.ok ? 'error' : 'default'} text={result.ok ? '成立' : '不成立'} />
              </Space>
            </div>
            <Divider style={{ margin: '8px 0' }} />
            <Text strong style={{ display: 'block', marginBottom: 8 }}>可能的根因</Text>
            {result.leaves.length === 0 ? (
              <Text type="secondary">尚未定位到根因</Text>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {result.leaves.map(l => (
                  <Tag key={l.id} color="red">{l.name}</Tag>
                ))}
              </div>
            )}
            <Divider style={{ margin: '8px 0' }} />
            <Space>
              <Button onClick={() => setAnswers({})}>重置</Button>
            </Space>
          </Card>
        </div>
      </div>
    </Card>
  )
}

export default DiagnosisPanel

