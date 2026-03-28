import React, { useMemo, useState } from 'react'
import { Card, Button, Space, Tag, Typography, Radio, Divider, List, Badge, Alert } from 'antd'

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

  const parentsByChild = useMemo(() => {
    const m = new Map()
    gates.forEach(g => {
      const childIds = Array.isArray(g.input_nodes) ? g.input_nodes : (g.children || [])
      childIds.forEach(c => {
        if (!m.has(c)) m.set(c, [])
        m.get(c).push({ parent: g.output_node, gate: g })
      })
    })
    return m
  }, [gates])

  const depthById = useMemo(() => {
    // 计算节点深度（越小越靠近顶层）
    const outputs = new Set(gates.map(g => g.output_node))
    const top = nodes.find(n => n.type === 'top') || nodes.find(n => !parentsByChild.has(n.id)) || nodes[0]
    const topId = top?.id
    const dmap = new Map()
    if (!topId) return dmap
    const queue = [{ id: topId, d: 0 }]
    while (queue.length) {
      const cur = queue.shift()
      dmap.set(cur.id, cur.d)
      const g = gateByOutput.get(cur.id)
      if (!g) continue
      const childIds = Array.isArray(g.input_nodes) ? g.input_nodes : (g.children || [])
      childIds.forEach(cid => !dmap.has(cid) && queue.push({ id: cid, d: cur.d + 1 }))
    }
    return dmap
  }, [nodes, gates, gateByOutput, parentsByChild])

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

  const nextSuggestion = useMemo(() => {
    // 推荐“下一步检查”：优先选择离顶层最近、且能快速排除的检查
    // 规则：
    // 1) 仅在未判定（unknown）的底事件中选择
    // 2) 优先处于 AND 上层链路的子项（任何一个为否即可排除该分支）
    // 3) 同优先级按深度升序（更靠近顶层优先）
    const candidates = leafIds
      .filter(id => answers[id] === undefined)
      .map(id => {
        const parents = parentsByChild.get(id) || []
        const hasAndAncestor = parents.some(p => String(p.gate?.type || p.gate?.gate_type || '').toUpperCase() === 'AND')
        const depth = depthById.get(id) ?? 999
        const n = nodeMap.get(id)
        return {
          id,
          name: n?.name || id,
          description: n?.description || '',
          depth,
          score: (hasAndAncestor ? 1 : 0),
        }
      })
    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      // 分数高的优先；分数相同按深度小的优先
      if (b.score !== a.score) return b.score - a.score
      return a.depth - b.depth
    })
    return candidates[0]
  }, [leafIds, answers, parentsByChild, depthById, nodeMap])

  return (
    <Card className="glass-card" title={<Space>诊断排查</Space>}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 360 }}>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>逐项询问</Text>
          <Card>
            {nextSuggestion ? (
              <>
                <div style={{ marginBottom: 8 }}>
                  <Space>
                    <Text strong style={{ fontSize: 16 }}>{nextSuggestion.name}</Text>
                    <Tag color="blue">待判断</Tag>
                    <Tag>{`层级：${depthById.get(nextSuggestion.id) ?? '-'}`}</Tag>
                    {nextSuggestion.score ? <Tag color="orange">AND链路优先</Tag> : null}
                  </Space>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <Text type="secondary">判断方法：</Text>
                  <span>{nextSuggestion.description || '无检查提示'}</span>
                </div>
                <Space wrap>
                  <Button type="primary" onClick={() => setAnswer(nextSuggestion.id, true)}>是（发生）</Button>
                  <Button onClick={() => setAnswer(nextSuggestion.id, false)}>否（未发生）</Button>
                  <Button onClick={() => setAnswer(nextSuggestion.id, undefined)}>跳过/未知</Button>
                  <Button onClick={() => setAnswers({})}>重置</Button>
                </Space>
                <Divider style={{ margin: '12px 0' }} />
                <Text type="secondary">
                  已回答 {leafItems.filter(i => i.value !== undefined).length} / {leafItems.length} 项
                </Text>
              </>
            ) : (
              <div>
                <Alert type="success" showIcon message="已完成所有询问" description="右侧显示综合推理结果与可能根因" />
                <div style={{ marginTop: 12 }}>
                  <Space>
                    <Button onClick={() => setAnswers({})}>重新开始</Button>
                  </Space>
                </div>
              </div>
            )}
          </Card>
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
            <Text strong style={{ display: 'block', marginBottom: 8 }}>可能的根因（当前判断为“是”的底事件）</Text>
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
            <Text strong style={{ display: 'block', marginBottom: 8 }}>推荐下一步检查</Text>
            {nextSuggestion ? (
              <Alert
                type="info"
                showIcon
                message={nextSuggestion.name}
                description={
                  <div>
                    <div>优先级依据：{`位于 ${depthById.get(nextSuggestion.id) ?? '-'} 层`}，{`上层${' '}`}<b>AND</b>{' '}链路{nextSuggestion.score ? '（任一否可快速排除）' : '（信息增益一般）'}</div>
                    <div style={{ marginTop: 6 }}>
                      <Text type="secondary">判断方法：</Text>
                      {nextSuggestion.description || '无检查提示'}
                    </div>
                  </div>
                }
              />
            ) : (
              <Text type="secondary">已没有待检查项</Text>
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
