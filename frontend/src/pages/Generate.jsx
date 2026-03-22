import React, { useState } from 'react'
import { Card, Typography, Button, Space, Spin, message, Empty, Tag, Divider, Alert } from 'antd'
import { ThunderboltOutlined, SaveOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import api from '../services/api.js'
import FaultTreeViewer from '../components/FaultTreeViewer.jsx'

const { Title, Text } = Typography

export default function Generate() {
  const [topEvent, setTopEvent] = useState('')
  const [systemName, setSystemName] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const handleGenerate = async () => {
    if (!topEvent.trim()) {
      message.warning('请输入顶事件描述')
      return
    }
    setLoading(true)
    setResult(null)
    setError('')
    try {
      const data = await api.generateFaultTree({
        top_event: topEvent,
        system_name: systemName,
        user_prompt: '',
        rag_top_k: 5,
      })
      // 修正：后端返回 { fault_tree, mcs, importance, validation_issues }
      setResult({
        fault_tree: data.fault_tree,
        top_event: data.fault_tree?.top_event,
        nodes_json: data.fault_tree?.nodes,
        gates_json: data.fault_tree?.gates,
        confidence: data.fault_tree?.confidence,
        analysis_summary: data.fault_tree?.analysis_summary,
        mcs: data.mcs,
        importance: data.importance,
        validation_issues: data.validation_issues,
      })
      message.success('故障树生成成功！')
    } catch (err) {
      const detail = err.response?.data?.detail || err.message
      setError('生成失败: ' + detail)
      message.error('生成失败')
    }
    setLoading(false)
  }

  const handleValidate = async () => {
    if (!result?.fault_tree) return
    try {
      const validation = await api.validateFaultTree(result.fault_tree)
      setResult(prev => ({ ...prev, validation }))
      message.info('校验完成')
    } catch (err) {
      message.error('校验失败: ' + err.message)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>生成故障树</Title>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Text type="secondary">输入设备故障描述，系统将自动分析故障模式，生成完整的故障树结构。</Text>

          <textarea
            value={topEvent}
            onChange={e => setTopEvent(e.target.value)}
            placeholder="例如：某型号液压泵启动后压力无法建立，系统显示低压报警"
            rows={3}
            disabled={loading}
            style={{
              width: '100%', padding: '10px 12px', fontSize: 14,
              border: '1px solid #d9d9d9', borderRadius: 6,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit',
            }}
          />

          <Space wrap>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={handleGenerate}
              loading={loading}
              size="large"
            >
              生成故障树
            </Button>
            {result && (
              <>
                <Button icon={<CheckCircleOutlined />} onClick={handleValidate}>校验</Button>
                <Button icon={<SaveOutlined />}>保存结果</Button>
              </>
            )}
          </Space>
        </Space>
      </Card>

      {loading && (
        <Card style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16, color: '#888' }}>
            正在分析故障模式、检索知识库、生成故障树...
          </div>
        </Card>
      )}

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      {result && !loading && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <Space split={<Divider type="vertical" />} wrap>
              <Text strong>顶事件：</Text><Text>{result.top_event}</Text>
              {result.confidence != null && (
                <>
                  <Text strong>置信度：</Text>
                  <Tag color={result.confidence > 0.8 ? 'green' : result.confidence > 0.6 ? 'orange' : 'red'}>
                    {(result.confidence * 100).toFixed(1)}%
                  </Tag>
                </>
              )}
              {result.analysis_summary && (
                <>
                  <Text strong>分析摘要：</Text>
                  <Text type="secondary">{result.analysis_summary}</Text>
                </>
              )}
            </Space>

            {result.validation_issues && result.validation_issues.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Alert type="warning" showIcon
                  message="校验提示"
                  description={result.validation_issues.join('；')}
                />
              </div>
            )}
            {(!result.validation_issues || result.validation_issues.length === 0) && result.fault_tree && (
              <div style={{ marginTop: 16 }}>
                <Alert type="success" showIcon message="故障树结构校验通过！" />
              </div>
            )}
          </Card>

          {result.nodes_json && <FaultTreeViewer tree={result} />}
        </>
      )}

      {!result && !loading && !error && (
        <Card>
          <Empty
            image={<div style={{ fontSize: 64, color: '#d9d9d9' }}>⚠️</div>}
            description="暂无生成的故障树，请在上方输入顶事件开始生成"
          />
        </Card>
      )}
    </div>
  )
}
