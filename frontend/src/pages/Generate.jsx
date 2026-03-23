import React, { useState } from 'react'
import { Card, Typography, Button, Space, Spin, message, Empty, Tag, Divider, Alert, Steps, Progress, Tabs, Modal } from 'antd'
import { ThunderboltOutlined, SaveOutlined, CheckCircleOutlined, WarningOutlined, RocketOutlined, BookOutlined, ApiOutlined, FileTextOutlined, EditOutlined, EyeOutlined, UndoOutlined } from '@ant-design/icons'
import api from '../services/api.js'
import FaultTreeViewer from '../components/FaultTreeViewer.jsx'
import TreeEditor from '../components/TreeEditor.jsx'
import MCSView from '../components/MCSView.jsx'

const { Title, Text, Paragraph } = Typography

export default function Generate() {
  const [topEvent, setTopEvent] = useState('')
  const [systemName, setSystemName] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [currentStep, setCurrentStep] = useState(0)
  const [viewMode, setViewMode] = useState('view') // 'view' | 'edit'
  const [saving, setSaving] = useState(false)

  const handleGenerate = async () => {
    if (!topEvent.trim()) {
      message.warning('请输入顶事件描述')
      return
    }
    setLoading(true)
    setResult(null)
    setError('')
    setCurrentStep(0)
    setViewMode('view')
    
    try {
      // 步骤1: 知识检索
      setCurrentStep(1)
      await new Promise(r => setTimeout(r, 500))
      
      // 步骤2: AI分析生成
      setCurrentStep(2)
      
      const data = await api.generateFaultTree({
        top_event: topEvent,
        system_name: systemName,
        user_prompt: '',
        rag_top_k: 5,
      })
      
      // 步骤3: 计算完成
      setCurrentStep(3)
      
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

  // 保存编辑结果
  const handleSaveEdit = async (editedData) => {
    if (!result) return
    setSaving(true)
    try {
      // 更新本地状态
      setResult({
        ...result,
        fault_tree: editedData.fault_tree,
        nodes_json: editedData.nodes,
        gates_json: editedData.gates,
      })
      message.success('保存成功！')
      setViewMode('view')
    } catch (err) {
      message.error('保存失败: ' + err.message)
    }
    setSaving(false)
  }

  // 切换到编辑模式
  const handleEnterEdit = () => {
    Modal.confirm({
      title: '进入专家编辑模式',
      icon: <EditOutlined />,
      content: '进入编辑模式后，您可以手动调整故障树结构、添加或删除节点、修改逻辑门。是否继续？',
      okText: '进入编辑',
      cancelText: '取消',
      onOk() {
        setViewMode('edit')
      },
    })
  }

  // 取消编辑
  const handleCancelEdit = () => {
    Modal.confirm({
      title: '放弃修改',
      icon: <WarningOutlined />,
      content: '确定要放弃所有修改吗？',
      okText: '放弃修改',
      cancelText: '继续编辑',
      onOk() {
        setViewMode('view')
        message.info('已放弃修改')
      },
    })
  }

  // 示例输入
  const examples = [
    { text: '电机无法启动', desc: '电动机故障' },
    { text: '液压系统无压力', desc: '液压系统故障' },
    { text: '控制系统通讯中断', desc: '工业网络故障' },
    { text: 'PLC控制器死机', desc: '控制系统故障' },
  ]

  return (
    <div className="page-container">
      {/* 页面标题 */}
      <div className="flex-between" style={{ marginBottom: 24 }}>
        <div>
          <Title level={3} className="page-title" style={{ marginBottom: 4 }}>
            <RocketOutlined style={{ marginRight: 12, color: '#1890ff' }} />
            智能故障树生成
          </Title>
          <Text type="secondary">基于 MiniMax 大模型 + RAG 知识检索，自动生成工业设备故障树</Text>
        </div>
        
        {/* 专家编辑按钮 */}
        {result && !loading && (
          <Space>
            {viewMode === 'view' ? (
              <Button 
                type="primary" 
                icon={<EditOutlined />} 
                onClick={handleEnterEdit}
                className="btn-primary"
              >
                专家编辑
              </Button>
            ) : (
              <>
                <Button 
                  icon={<UndoOutlined />} 
                  onClick={handleCancelEdit}
                >
                  取消编辑
                </Button>
                <Button 
                  type="primary" 
                  icon={<SaveOutlined />} 
                  loading={saving}
                  onClick={() => {
                    // TreeEditor 内部会处理保存
                  }}
                  className="btn-primary"
                >
                  保存修改
                </Button>
              </>
            )}
          </Space>
        )}
      </div>

      {/* 步骤指示器 */}
      {loading && (
        <Card className="glass-card" style={{ marginBottom: 24 }}>
          <Steps current={currentStep} size="small" status="process">
            <Steps.Step title="准备分析" icon={<BookOutlined />} />
            <Steps.Step title="知识检索" icon={<ApiOutlined />} />
            <Steps.Step title="AI 生成" icon={<ThunderboltOutlined />} />
            <Steps.Step title="计算完成" icon={<CheckCircleOutlined />} />
          </Steps>
          <div style={{ marginTop: 16 }}>
            {currentStep === 1 && <Text>正在从知识库中检索相关故障信息...</Text>}
            {currentStep === 2 && <Text>正在调用 AI 分析故障模式，生成故障树...</Text>}
            {currentStep === 3 && <Text>正在计算最小割集和重要度...</Text>}
          </div>
          <Progress percent={currentStep * 33} status="active" strokeColor="#1890ff" style={{ marginTop: 12 }} />
        </Card>
      )}

      {/* 输入区域 */}
      <Card className="glass-card" style={{ marginBottom: 24 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          {/* 引导文字 */}
          <div>
            <Text strong style={{ fontSize: 15, color: '#e6f7ff', display: 'block', marginBottom: 8 }}>
              <FileTextOutlined style={{ marginRight: 8 }} />
              请描述设备故障现象
            </Text>
            <Text type="secondary" style={{ fontSize: 13 }}>
              输入越详细的故障描述，生成的故障树越准确
            </Text>
          </div>

          {/* 输入框 */}
          <textarea
            value={topEvent}
            onChange={e => setTopEvent(e.target.value)}
            placeholder="例如：某型号液压泵启动后压力无法建立，系统显示低压报警；电机无法启动等"
            rows={4}
            disabled={loading}
            className="input-glass"
            style={{
              width: '100%', padding: '14px 16px', fontSize: 15,
              borderRadius: 8, resize: 'vertical', outline: 'none', 
              fontFamily: 'inherit', minHeight: 100,
            }}
          />

          {/* 示例按钮 */}
          <div className="flex-wrap" style={{ gap: 8 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>快速输入：</Text>
            {examples.map((ex, i) => (
              <Button 
                key={i} 
                size="small" 
                className="btn-secondary"
                onClick={() => setTopEvent(ex.text)}
                disabled={loading}
              >
                {ex.text}
              </Button>
            ))}
          </div>

          {/* 操作按钮 */}
          <div className="flex-between">
            <Text type="secondary" style={{ fontSize: 13 }}>
              {topEvent.length > 0 && `已输入 ${topEvent.length} 个字符`}
            </Text>
            <Space wrap>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={handleGenerate}
                loading={loading}
                size="large"
                className="btn-primary"
              >
                {loading ? '生成中...' : '生成故障树'}
              </Button>
            </Space>
          </div>
        </Space>
      </Card>

      {/* 错误提示 */}
      {error && (
        <Alert 
          type="error" 
          message="生成失败" 
          description={error} 
          showIcon 
          style={{ marginBottom: 24 }} 
          className="animate-fadeIn"
        />
      )}

      {/* 结果展示 */}
      {result && !loading && (
        <div className="animate-fadeIn">
          {/* 结果概览 */}
          <Card className="glass-card" style={{ marginBottom: 24 }}>
            {/* 模式提示 */}
            {viewMode === 'edit' && (
              <Alert 
                type="info" 
                showIcon 
                icon={<EditOutlined />}
                message="专家编辑模式" 
                description="点击节点可查看详情；可拖拽调整位置；点击上方「保存修改」保存编辑结果"
                style={{ marginBottom: 16 }}
              />
            )}

            <div className="flex-between" style={{ marginBottom: 16 }}>
              <Space>
                <Text strong style={{ fontSize: 16 }}>顶事件：</Text>
                <Text style={{ fontSize: 16, color: '#1890ff' }}>{result.top_event}</Text>
                {viewMode === 'edit' && (
                  <Tag color="orange"><EditOutlined /> 编辑模式</Tag>
                )}
              </Space>
              <Space>
                <Button icon={<CheckCircleOutlined />} onClick={handleValidate}>重新校验</Button>
                <Button type="primary" icon={<SaveOutlined />}>保存结果</Button>
              </Space>
            </div>

            <div className="flex-gap" style={{ flexWrap: 'wrap', gap: 24 }}>
              {/* 置信度 */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 4 }}>
                  <Tag color={result.confidence > 0.8 ? 'green' : result.confidence > 0.6 ? 'orange' : 'red'} 
                       style={{ fontSize: 16, padding: '4px 12px' }}>
                    {result.confidence != null ? (result.confidence * 100).toFixed(1) + '%' : '-'}
                  </Tag>
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>置信度</Text>
              </div>
              
              {/* 节点数 */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 4, color: '#e6f7ff', fontSize: 18, fontWeight: 500 }}>
                  {result.nodes_json?.length || 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>节点数量</Text>
              </div>
              
              {/* 逻辑门 */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 4, color: '#e6f7ff', fontSize: 18, fontWeight: 500 }}>
                  {result.gates_json?.length || 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>逻辑门</Text>
              </div>
              
              {/* 最小割集 */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 4, color: '#e6f7ff', fontSize: 18, fontWeight: 500 }}>
                  {result.mcs?.length || 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>最小割集</Text>
              </div>
            </div>

            {/* 分析摘要 */}
            {result.analysis_summary && (
              <div style={{ marginTop: 16, padding: '12px 16px', background: 'rgba(24,144,255,0.08)', borderRadius: 8, borderLeft: '3px solid #1890ff' }}>
                <Text strong style={{ color: '#8cbdff' }}>分析摘要：</Text>
                <Text style={{ color: '#e6f7ff', marginLeft: 8 }}>{result.analysis_summary}</Text>
              </div>
            )}

            {/* 校验提示 */}
            {result.validation_issues && result.validation_issues.length > 0 && (
              <Alert 
                type="warning" 
                showIcon 
                message="校验提示" 
                description={result.validation_issues.join('；')}
                style={{ marginTop: 16 }}
              />
            )}
            {(!result.validation_issues || result.validation_issues.length === 0) && result.fault_tree && (
              <Alert 
                type="success" 
                showIcon 
                message="故障树结构校验通过！" 
                style={{ marginTop: 16 }}
              />
            )}
          </Card>

          {/* 故障树可视化 / 编辑器 */}
          {result.nodes_json && (
            <Card 
              className="glass-card" 
              title={
                <Space>
                  {viewMode === 'view' ? <ApiOutlined /> : <EditOutlined />}
                  {viewMode === 'view' ? '故障树结构' : '专家编辑模式'}
                </Space>
              }
              style={{ marginBottom: 24 }}
            >
              {viewMode === 'view' ? (
                <FaultTreeViewer tree={result} />
              ) : (
                <TreeEditor 
                  initialTree={result}
                  onSave={handleSaveEdit}
                  onCancel={handleCancelEdit}
                />
              )}
            </Card>
          )}

          {/* MCS 最小割集 - 编辑模式下不显示 */}
          {result.mcs && result.mcs.length > 0 && viewMode === 'view' && (
            <Card className="glass-card" title={<Space><FileTextOutlined />最小割集分析</Space>}>
              <MCSView mcs={result.mcs} importance={result.importance} />
            </Card>
          )}
        </div>
      )}

      {/* 空状态 */}
      {!result && !loading && !error && (
        <Card className="glass-card" style={{ textAlign: 'center', padding: 48 }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>🔍</div>
          <Text type="secondary" style={{ fontSize: 15 }}>
            在上方输入设备故障现象，开始生成故障树
          </Text>
        </Card>
      )}
    </div>
  )
}
