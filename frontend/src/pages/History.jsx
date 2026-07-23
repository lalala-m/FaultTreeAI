import React, { useState, useEffect, Suspense, lazy } from 'react'
import { Card, Button, Space, Tag, Typography, Empty, Modal, message, Collapse, Divider } from 'antd'
import { MessageOutlined, EyeOutlined, ThunderboltOutlined, ReloadOutlined } from '@ant-design/icons'
import api from '../services/api.js'

const FaultTreeViewer = lazy(() => import('../components/FaultTreeViewer.jsx'))

const { Title, Text } = Typography
const { Panel } = Collapse

export default function History() {
  const [cases, setCases] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedKeys, setExpandedKeys] = useState([])
  const [selectedCase, setSelectedCase] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [treeDetail, setTreeDetail] = useState(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const [treeLoading, setTreeLoading] = useState(false)

  const loadCases = async () => {
    setLoading(true)
    try {
      api.invalidateCache?.(['diagnosisCases'])
      const data = await api.listDiagnosisCases()
      setCases(Array.isArray(data) ? data : [])
    } catch {
      setCases([])
    }
    setLoading(false)
  }

  useEffect(() => {
    loadCases()
  }, [])

  const grouped = React.useMemo(() => {
    const map = new Map()
    for (const c of cases) {
      const key = String(c?.top_event || '').trim()
      if (!key) continue
      if (!map.has(key)) {
        map.set(key, { top_event: key, cases: [], last_at: c.updated_at })
      }
      const g = map.get(key)
      g.cases.push(c)
      if (c.updated_at && c.updated_at > g.last_at) g.last_at = c.updated_at
    }
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.last_at || ''
      const tb = b.last_at || ''
      return tb.localeCompare(ta)
    })
  }, [cases])

  const openChat = (c) => {
    setSelectedCase(c)
    setChatOpen(true)
  }

  const handleViewTree = async (c) => {
    if (!c?.tree_id) return
    setTreeLoading(true)
    try {
      const detail = await api.getFaultTree(c.tree_id)
      setTreeDetail({
        tree_id: detail.tree_id || c.tree_id,
        fault_tree: detail.fault_tree,
        top_event: detail.fault_tree?.top_event,
        nodes_json: detail.fault_tree?.nodes,
        gates_json: detail.fault_tree?.gates,
        mcs: detail.mcs,
        importance: detail.importance,
        validation_issues: detail.validation_issues,
      })
      setTreeOpen(true)
    } catch (e) {
      message.error(e?.response?.data?.detail || '加载故障树失败')
    }
    setTreeLoading(false)
  }

  const handleGenerateTree = async (c) => {
    if (!c) return
    setTreeLoading(true)
    try {
      const questions = Array.isArray(c.questions) ? c.questions : []
      const answers = c.answers || {}
      const answerLines = []
      for (const q of questions) {
        const qid = q?.id || q
        const qtext = q?.text || qid
        const ans = String(answers[qid] || '').trim()
        if (!ans) continue
        answerLines.push(`- ${qtext}\n  回答：${ans}`)
      }
      const enrichedPrompt = answerLines.length
        ? `原始描述：${c.top_event}\n\n补充信息：\n${answerLines.join('\n')}`
        : ''

      const data = await api.generateFaultTree({
        top_event: c.top_event,
        user_prompt: enrichedPrompt,
        clarify_questions: questions,
        clarify_answers: answers,
        rag_top_k: 5,
        use_fallback: true,
      })

      // 更新本地 case 数据
      setCases(prev => prev.map(x => x.case_id === c.case_id ? { ...x, tree_id: data?.tree_id } : x))

      // 打开故障树查看
      setTreeDetail({
        tree_id: data.tree_id,
        fault_tree: data.fault_tree,
        top_event: data.fault_tree?.top_event,
        nodes_json: data.fault_tree?.nodes,
        gates_json: data.fault_tree?.gates,
        mcs: data.mcs,
        importance: data.importance,
        validation_issues: data.validation_issues,
      })
      setTreeOpen(true)
      message.success('已生成故障树')
    } catch (e) {
      message.error(e?.response?.data?.detail || e?.message || '生成失败')
    }
    setTreeLoading(false)
  }

  const loadToDashboard = (c) => {
    try {
      const msgs = Array.isArray(c.messages) ? c.messages : []
      sessionStorage.setItem('dashboard_chat_inject', JSON.stringify({ messages: msgs, ts: Date.now() }))
      window.dispatchEvent(new Event('dashboard-inject'))
      message.success('已加载到主页继续对话')
    } catch {}
  }

  const formatDate = (t) => t ? new Date(t).toLocaleString('zh-CN') : '-'

  const renderChatMessage = (m, i) => {
    const isUser = m.role === 'user'
    const bubbleBase = {
      maxWidth: '86%',
      padding: 10,
      borderRadius: 10,
      background: isUser ? '#e6f7ff' : '#fff',
      border: '1px solid #f0f0f0',
    }

    if (m.kind === 'clarification') {
      const submitted = m.submittedAnswers || {}
      return (
        <div key={i} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
          <div style={bubbleBase}>
            <Text strong>澄清问题</Text>
            <div style={{ marginTop: 4, marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>针对「{m.top_event}」</Text>
            </div>
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              {(Array.isArray(m.questions) ? m.questions : []).map(q => {
                const ans = String(submitted[q.id] || '')
                return (
                  <div key={q.id} style={{ padding: 8, background: '#f6ffed', borderRadius: 6, border: '1px solid #b7eb8f' }}>
                    <Text style={{ fontSize: 12 }}>{q.text}</Text>
                    <div style={{ marginTop: 4 }}>
                      <Tag color={ans ? 'green' : 'default'}>{ans || '未回答'}</Tag>
                    </div>
                  </div>
                )
              })}
            </Space>
          </div>
        </div>
      )
    }

    if (m.kind === 'steps') {
      return (
        <div key={i} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
          <div style={bubbleBase}>
            <Text strong>排查步骤</Text>
            <div style={{ marginTop: 6 }}>
              {(Array.isArray(m.steps) ? m.steps : []).map((s, idx) => (
                <div key={idx} style={{ marginBottom: 6, padding: 8, background: '#fafafa', borderRadius: 6 }}>
                  <Text style={{ fontSize: 12, fontWeight: 500 }}>步骤{s.step || idx + 1}：{s.title}</Text>
                  <div style={{ fontSize: 12, marginTop: 2 }}>{s.action}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }

    if (m.kind === 'troubleshooting' || m.kind === 'troubleshooting_done') {
      return (
        <div key={i} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
          <div style={bubbleBase}>
            <Text strong>连续排查</Text>
            <div style={{ fontSize: 12, marginTop: 4 }}>{m.question ? m.question.title : '排查结束'}</div>
          </div>
        </div>
      )
    }

    if (m.result) {
      return (
        <div key={i} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
          <div style={bubbleBase}>
            <Text strong>故障树结果</Text>
            <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{String(m.text || '已生成故障树')}</div>
            <div style={{ marginTop: 8 }}>
              <Tag color="purple">模型: {String(m.result.provider || '').toUpperCase()}</Tag>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div key={i} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
        <div style={bubbleBase}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{String(m.text || '')}</div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>历史记录</Title>
        <Button icon={<ReloadOutlined />} onClick={loadCases} loading={loading}>刷新</Button>
      </div>

      {grouped.length === 0 ? (
        <Empty description="暂无历史对话" />
      ) : (
        <Collapse
          activeKey={expandedKeys}
          onChange={setExpandedKeys}
          ghost
        >
          {grouped.map((g) => (
            <Panel
              key={g.top_event}
              header={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingRight: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <MessageOutlined style={{ color: '#1677ff' }} />
                    <Text strong style={{ fontSize: 15 }}>{g.top_event}</Text>
                    <Tag color="blue">{g.cases.length} 条路径</Tag>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>最近：{formatDate(g.last_at)}</Text>
                </div>
              }
            >
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {g.cases.map(c => {
                  const hasTree = !!c.tree_id
                  const answerCount = Object.keys(c.answers || {}).length
                  const stepCount = Array.isArray(c.steps) ? c.steps.length : 0
                  return (
                    <Card
                      key={c.case_id}
                      size="small"
                      style={{ borderRadius: 8 }}
                      bodyStyle={{ padding: 12 }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ marginBottom: 6 }}>
                            <Tag color={hasTree ? 'green' : 'orange'}>{hasTree ? '已生成故障树' : '未生成故障树'}</Tag>
                            <Tag>Clarify 答案 {answerCount} 项</Tag>
                            {stepCount > 0 && <Tag>排查步骤 {stepCount} 步</Tag>}
                            <Tag color="blue">命中 {c.hit_count || 0} 次</Tag>
                          </div>
                          {answerCount > 0 && (
                            <div style={{ fontSize: 12, color: '#555' }}>
                              <Text type="secondary">答案摘要：</Text>
                              {Object.entries(c.answers || {}).slice(0, 3).map(([k, v], idx) => {
                                const q = (c.questions || []).find(qx => qx?.id === k)
                                const qtext = q?.text || k
                                return <span key={k} style={{ marginRight: 12 }}>{qtext} → {String(v)}</span>
                              })}
                            </div>
                          )}
                          <div style={{ marginTop: 4, fontSize: 12, color: '#888' }}>更新时间：{formatDate(c.updated_at)}</div>
                        </div>
                        <Space direction="vertical" size="small" style={{ minWidth: 120 }}>
                          <Button size="small" icon={<MessageOutlined />} onClick={() => openChat(c)}>查看聊天记录</Button>
                          {hasTree ? (
                            <Button size="small" icon={<EyeOutlined />} loading={treeLoading} onClick={() => handleViewTree(c)}>查看故障树</Button>
                          ) : (
                            <Button size="small" icon={<ThunderboltOutlined />} type="primary" loading={treeLoading} onClick={() => handleGenerateTree(c)}>生成故障树</Button>
                          )}
                          <Button size="small" onClick={() => loadToDashboard(c)}>加载到主页</Button>
                        </Space>
                      </div>
                    </Card>
                  )
                })}
              </Space>
            </Panel>
          ))}
        </Collapse>
      )}

      <Modal
        open={chatOpen}
        title={selectedCase ? `聊天记录 · ${selectedCase.top_event}` : '聊天记录'}
        onCancel={() => setChatOpen(false)}
        footer={[
          <Button key="close" onClick={() => setChatOpen(false)}>关闭</Button>,
          selectedCase && !selectedCase.tree_id && (
            <Button key="gen" type="primary" icon={<ThunderboltOutlined />} loading={treeLoading} onClick={() => { setChatOpen(false); handleGenerateTree(selectedCase) }}>
              生成故障树
            </Button>
          ),
          selectedCase && selectedCase.tree_id && (
            <Button key="view" type="primary" icon={<EyeOutlined />} loading={treeLoading} onClick={() => { setChatOpen(false); handleViewTree(selectedCase) }}>
              查看故障树
            </Button>
          ),
          <Button key="load" onClick={() => loadToDashboard(selectedCase)}>加载到主页继续对话</Button>,
        ].filter(Boolean)}
        width={760}
      >
        <div style={{ maxHeight: '60vh', overflow: 'auto', padding: '4px 4px 12px 4px' }}>
          {selectedCase && (Array.isArray(selectedCase.messages) && selectedCase.messages.length > 0 ? (
            selectedCase.messages.map((m, i) => renderChatMessage(m, i))
          ) : (
            <Empty description="暂无聊天记录" />
          ))}
        </div>
      </Modal>

      <Modal
        open={treeOpen}
        title={treeDetail?.top_event || '故障树'}
        onCancel={() => setTreeOpen(false)}
        width="90vw"
        style={{ top: 16 }}
        footer={[
          <Button key="close" onClick={() => setTreeOpen(false)}>关闭</Button>,
        ]}
      >
        <Suspense fallback={null}>
          {treeDetail && <FaultTreeViewer tree={treeDetail} />}
        </Suspense>
      </Modal>
    </div>
  )
}
