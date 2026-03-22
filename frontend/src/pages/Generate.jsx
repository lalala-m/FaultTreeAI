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
      setResult(data)
      message.success('故障树生成成功！')
    } catch (err) {
      const detail = err.response?.data?.detail || err.message
      setError('生成失败: ' + detail)
      message.error('生成失败')
    }
    setLoading(false)
  }

  const handleValidate = async () => {
    if (!result?.tree_id) return
    try {
      const data = await api.getFaultTree(result.tree_id)
      const validation = await api.validateFaultTree(data)
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

            {result.validation && (
              <div style={{ marginTop: 16 }}>
                {result.validation.errors?.length > 0 && (
                  <Alert type="error" showIcon
                    message="存在错误"
                    description={result.validation.errors.join('；')}
                    style={{ marginBottom: 8 }}
                  />
                )}
                {result.validation.warnings?.length > 0 && (
                  <Alert type="warning" showIcon
                    message="存在警告"
                    description={result.validation.warnings.join('；')}
                  />
                )}
                {result.validation.errors?.length === 0 && result.validation.warnings?.length === 0 && (
                  <Alert type="success" showIcon message="故障树结构校验通过！" />
                )}
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
