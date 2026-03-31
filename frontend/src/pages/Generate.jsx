import React, { useState, useEffect, useRef, Suspense, lazy } from 'react'
import { Card, Typography, Button, Space, message, Tag, Divider, Alert, Steps, Progress, Modal, Select, Row, Col, Upload, Progress as ProgressBar, Badge, Slider, Tooltip, Layout, Input, Collapse } from 'antd'
import { ThunderboltOutlined, SaveOutlined, CheckCircleOutlined, WarningOutlined, RocketOutlined, BookOutlined, ApiOutlined, FileTextOutlined, EditOutlined, EyeOutlined, UndoOutlined, AppstoreOutlined, UploadOutlined, InboxOutlined, FilePdfOutlined, FileWordOutlined, DeleteOutlined } from '@ant-design/icons'
import api from '../services/api.js'
import DiagnosisPanel from '../components/DiagnosisPanel.jsx'

const FaultTreeViewer = lazy(() => import('../components/FaultTreeViewer.jsx'))
const TreeEditor = lazy(() => import('../components/TreeEditor.jsx'))

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
  const [histories, setHistories] = useState([])
  const [loadingHistories, setLoadingHistories] = useState(false)
  
  // 模板相关状态
  const [templates, setTemplates] = useState([])
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [templateTopEvents, setTemplateTopEvents] = useState([])
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  
  // 文档相关状态
  const [docs, setDocs] = useState([])
  const [selectedDoc, setSelectedDoc] = useState(null)
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [manualWeight, setManualWeight] = useState(50) // 0~100，控制文档权重（向量占比）
  
  // LLM Provider 状态
  const [providers, setProviders] = useState([])
  const [selectedProvider, setSelectedProvider] = useState(null)
  const [providerInfo, setProviderInfo] = useState({ primary: '', fallback: '' })
  const [savingResult, setSavingResult] = useState(false)
  const editorRef = useRef(null)
  const generateCacheKey = 'faulttreeai_generate_state_v1'

  // 视觉识别传入的数据
  const [visionData, setVisionData] = useState(null)
  
  // 从 URL 参数初始化（支持视觉识别传入的数据）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    
    const visionResult = params.get('vision_result')
    const faultDescription = params.get('fault_description')
    const equipmentType = params.get('equipment_type')
    const source = params.get('source')
    
    if (source === 'vision' && (faultDescription || visionResult)) {
      let parsedVisionResult = null
      try {
        if (visionResult) parsedVisionResult = JSON.parse(visionResult)
      } catch (e) {
        console.error('解析视觉识别结果失败:', e)
      }
      
      setVisionData({
        result: parsedVisionResult,
        faultDescription: faultDescription || '',
        equipmentType: equipmentType || 'other'
      })
      
      if (faultDescription) {
        setTopEvent(faultDescription)
        message.info('已从视觉识别结果填充故障描述')
      }
      
      // 根据设备类型自动选择模板
      if (equipmentType) {
        const templateMap = {
          'motor': 'motor', 'pump': 'pump', 'valve': 'valve',
          'pipe': 'pipe', 'bearing': 'bearing', 'hydraulic': 'hydraulic', 'plc': 'plc'
        }
        const templateId = templateMap[equipmentType.toLowerCase()]
        if (templateId) setSelectedTemplate(templateId)
      }
      
      window.history.replaceState({}, document.title, window.location.pathname)
    }
  }, [])

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(generateCacheKey)
      if (!raw) return
      const data = JSON.parse(raw)
      if (typeof data?.topEvent === 'string') setTopEvent(data.topEvent)
      if (typeof data?.systemName === 'string') setSystemName(data.systemName)
      if (typeof data?.selectedDoc === 'string' || data?.selectedDoc === null) setSelectedDoc(data.selectedDoc)
      if (typeof data?.selectedProvider === 'string' || data?.selectedProvider === null) setSelectedProvider(data.selectedProvider)
      if (data?.result) setResult(data.result)
      if (data?.viewMode === 'view' || data?.viewMode === 'edit') setViewMode(data.viewMode)
    } catch {
    }
  }, [])

  useEffect(() => {
    try {
      const payload = {
        topEvent,
        systemName,
        selectedDoc,
        selectedProvider,
        result,
        viewMode,
        savedAt: Date.now(),
      }
      sessionStorage.setItem(generateCacheKey, JSON.stringify(payload))
    } catch {
    }
  }, [topEvent, systemName, selectedDoc, selectedProvider, result, viewMode])

  // 加载模板列表
  useEffect(() => {
    const loadTemplates = async () => {
      try {
        setLoadingTemplates(true)
        const data = await api.listTemplates()
        setTemplates(data.templates || [])
      } catch (err) {
        console.error('加载模板失败:', err)
      } finally {
        setLoadingTemplates(false)
      }
    }
    loadTemplates()
  }, [])
  
  // 加载 Provider 列表
  useEffect(() => {
    const loadProviders = async () => {
      try {
        const data = await api.getProviders()
        setProviders(data.providers || [])
        setProviderInfo({ primary: data.primary, fallback: data.fallback })
        const firstAvailable = (data.providers || []).find(p => p.available)
        setSelectedProvider(firstAvailable?.name || data.primary || 'minimax')
      } catch (e) {
        console.error('加载模型列表失败', e)
      }
    }
    loadProviders()
  }, [])

  // 加载文档列表
  useEffect(() => {
    const loadDocs = async () => {
      try {
        setLoadingDocs(true)
        const data = await api.listDocuments()
        setDocs(Array.isArray(data) ? data : [])
      } catch (err) {
        console.error('加载文档失败:', err)
        setDocs([])
      } finally {
        setLoadingDocs(false)
      }
    }
    loadDocs()
  }, [])
  
  // 加载历史记录
  useEffect(() => {
    const loadHist = async () => {
      try {
        setLoadingHistories(true)
        const data = await api.listFaultTrees()
        setHistories(Array.isArray(data) ? data : [])
      } catch {
        setHistories([])
      } finally {
        setLoadingHistories(false)
      }
    }
    loadHist()
  }, [])
  
  // 当选择模板时，加载预设顶事件
  const handleTemplateChange = async (templateId) => {
    setSelectedTemplate(templateId)
    if (templateId) {
      try {
        const topEvents = await api.getTemplateTopEvents(templateId)
        setTemplateTopEvents(topEvents)
      } catch (err) {
        console.error('加载模板顶事件失败:', err)
        setTemplateTopEvents([])
      }
    } else {
      setTemplateTopEvents([])
    }
  }
  
  // 选择预设顶事件
  const handleTopEventSelect = (event) => {
    setTopEvent(event)
  }
  
  // 处理文档上传
  const handleUpload = async ({ file }) => {
    setUploading(true)
    setUploadProgress(0)
    
    try {
      await api.uploadDocument(file, setUploadProgress)
      message.success('文档上传成功！')
      // 刷新文档列表
      const data = await api.listDocuments()
      setDocs(Array.isArray(data) ? data : [])
    } catch (err) {
      message.error('上传失败: ' + (err.response?.data?.detail || err.message))
    }
    setUploading(false)
    setUploadProgress(0)
  }
  
  // 处理文档删除
  const handleDeleteDoc = async (docId, e) => {
    e.stopPropagation()
    try {
      await api.deleteDocument(docId)
      message.success('已删除')
      // 刷新文档列表
      const data = await api.listDocuments()
      setDocs(Array.isArray(data) ? data : [])
      // 如果删除的是当前选中的文档，清除选择
      if (selectedDoc === docId) {
        setSelectedDoc(null)
      }
    } catch (err) {
      message.error('删除失败')
    }
  }

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
      
      // 传递选中的文档ID
      const data = await api.generateFaultTree({
        top_event: topEvent,
        system_name: systemName,
        user_prompt: '',
        rag_top_k: 5,
        template_id: selectedTemplate || undefined,
        doc_ids: selectedDoc ? [selectedDoc] : undefined,
        provider: selectedProvider || undefined,
        use_fallback: true,
        manual_weight: Math.max(0, Math.min(100, manualWeight)) / 100.0,
      })
      
      // 步骤3: 计算完成
      setCurrentStep(3)
      
      setResult({
        tree_id: data.tree_id,
        fault_tree: data.fault_tree,
        top_event: data.fault_tree?.top_event,
        nodes_json: data.fault_tree?.nodes,
        gates_json: data.fault_tree?.gates,
        confidence: data.fault_tree?.confidence,
        analysis_summary: data.fault_tree?.analysis_summary,
        mcs: data.mcs,
        importance: data.importance,
        validation_issues: data.validation_issues,
        provider: data.provider,
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

  const handleSaveResult = async () => {
    if (!result?.tree_id) {
      message.error('缺少 tree_id，无法保存')
      return
    }
    if (!result?.fault_tree || !result?.nodes_json || !result?.gates_json) {
      message.error('缺少故障树数据，无法保存')
      return
    }
    setSavingResult(true)
    try {
      const payload = {
        nodes: result.nodes_json,
        gates: result.gates_json,
        fault_tree: result.fault_tree,
        mcs: result.mcs,
        importance: result.importance,
        validation_issues: result.validation_issues,
      }
      await api.saveFaultTree(result.tree_id, payload)
      message.success('已保存到数据库')
    } catch (err) {
      message.error(err.response?.data?.detail || '保存失败')
    }
    setSavingResult(false)
  }

  // 保存编辑结果
  const handleSaveEdit = async (editedData) => {
    if (!result) return
    setSaving(true)
    try {
      const next = {
        ...result,
        fault_tree: editedData.fault_tree,
        nodes_json: editedData.nodes,
        gates_json: editedData.gates,
      }
      setResult(next)
      if (result.tree_id) {
        await api.saveFaultTree(result.tree_id, {
          nodes: next.nodes_json,
          gates: next.gates_json,
          fault_tree: next.fault_tree,
          mcs: next.mcs,
          importance: next.importance,
          validation_issues: next.validation_issues,
        })
      }
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
  
  // 获取文件图标
  const getFileIcon = (filename) => {
    if (filename?.endsWith('.pdf')) return <FilePdfOutlined style={{ color: '#ff4d4f' }} />
    if (filename?.endsWith('.docx') || filename?.endsWith('.doc')) return <FileWordOutlined style={{ color: '#1890ff' }} />
    return <FileTextOutlined style={{ color: '#52c41a' }} />
  }

  return (
    <Layout style={{ minHeight: 'calc(100vh - 0px)' }}>
      <Layout.Sider width={300} theme="light" style={{ padding: 12, borderRight: '1px solid #f0f0f0' }}>
        <Card size="small" title="目录" bordered={false} className="glass-card" bodyStyle={{ padding: 12, maxHeight: '35vh', overflow: 'auto' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button type="text">总览</Button>
            <Button type="text">知识库</Button>
            <Button type="text" type="primary">生成故障树</Button>
            <Button type="text">历史记录</Button>
          </Space>
        </Card>
        <Card size="small" title="历史记录" bordered={false} className="glass-card" style={{ marginTop: 12 }} bodyStyle={{ padding: 12, maxHeight: '45vh', overflow: 'auto' }}>
          <Collapse accordion ghost>
            {(histories || []).map(h => (
              <Collapse.Panel header={
                <Space>
                  <Text strong ellipsis style={{ maxWidth: 180 }}>{h.top_event}</Text>
                  <Tag color={h.is_valid ? 'green' : 'orange'}>{h.is_valid ? '已校验' : '待校验'}</Tag>
                </Space>
              } key={h.tree_id}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{(h.created_at || '').slice(0, 19)}</Text>
                  <Button size="small" onClick={async () => {
                    try {
                      const data = await api.getFaultTree(h.tree_id)
                      setResult({
                        tree_id: data.tree_id,
                        fault_tree: data.fault_tree,
                        top_event: data.fault_tree?.top_event,
                        nodes_json: data.fault_tree?.nodes,
                        gates_json: data.fault_tree?.gates,
                        confidence: data.fault_tree?.confidence,
                        analysis_summary: data.analysis_summary || data.fault_tree?.analysis_summary,
                        mcs: data.mcs,
                        importance: data.importance,
                        validation_issues: data.validation_issues || [],
                        provider: data.provider,
                      })
                      message.success('已载入历史记录')
                    } catch {
                      message.error('载入失败')
                    }
                  }}>载入查看</Button>
                </Space>
              </Collapse.Panel>
            ))}
          </Collapse>
        </Card>
        <Card size="small" title="视觉识别" bordered={false} className="glass-card" style={{ marginTop: 12 }} bodyStyle={{ padding: 12 }}>
          <Upload accept=".jpg,.jpeg,.png,.webp" showUploadList={false} beforeUpload={() => false} onChange={() => message.info('视觉识别功能保持不变')}>
            <Button block>上传设备图片（占位）</Button>
          </Upload>
        </Card>
      </Layout.Sider>
      <Layout.Content style={{ padding: '16px 16px 96px 16px' }}>
        <div className="page-container">
      {/* 页面标题 */}
      <div style={{ marginBottom: 24 }}>
        <Title level={3} className="page-title" style={{ marginBottom: 4 }}>
          <RocketOutlined style={{ marginRight: 12, color: '#1890ff' }} />
          智能故障树生成
        </Title>
        <Text type="secondary">基于 MiniMax 大模型 + RAG 知识检索，自动生成工业设备故障树</Text>
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

      {/* 输入区域（删除设备类型选择） */}
      <Card className="glass-card" style={{ marginBottom: 24 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          {/* 模型选择移动到底部输入区，此处不再显示 */}

          {/* 第二行：文档选择（与模板等宽） */}
          <Row gutter={[16, 8]}>
            <Col xs={24} md={24}>
              <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 8 }}>
                <BookOutlined style={{ marginRight: 8 }} />
                选择操作手册（可选）
              </Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                选择已上传的操作手册，让 AI 基于特定文档生成更贴合的故障树
              </Text>
              {/* 上传进度 */}
              {uploading && (
                <div style={{ marginBottom: 12 }}>
                  <ProgressBar percent={uploadProgress} status="active" strokeColor="#1890ff" />
                  <Text type="secondary" style={{ fontSize: 12 }}>正在上传文档...</Text>
                </div>
              )}
              
              {/* 文档选择器 */}
              <Select
                style={{ width: '100%' }}
                placeholder="选择已上传的操作手册..."
                value={selectedDoc}
                onChange={setSelectedDoc}
                loading={loadingDocs}
                allowClear
                popupRender={(menu) => (
                  <>
                    {menu}
                    <Divider style={{ margin: '8px 0' }} />
                    <div style={{ padding: '8px' }}>
                      <Upload
                        accept=".pdf,.docx,.doc,.txt"
                        showUploadList={false}
                        beforeUpload={() => false}
                        onChange={handleUpload}
                        disabled={uploading}
                      >
                        <Button 
                          type="primary" 
                          icon={<UploadOutlined />} 
                          loading={uploading}
                          block
                          style={{ marginBottom: 8 }}
                        >
                          {uploading ? '上传中...' : '上传新文档'}
                        </Button>
                      </Upload>
                      <Text type="secondary" style={{ fontSize: 12, display: 'block', textAlign: 'center' }}>
                        支持 PDF、Word、TXT 格式
                      </Text>
                    </div>
                  </>
                )}
                options={docs
                  .filter(d => d.status === 'active')
                  .map(d => ({
                    value: d.doc_id,
                    label: (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <Space>
                          {getFileIcon(d.filename)}
                          <Text>{d.filename}</Text>
                        </Space>
                        <Button 
                          size="small" 
                          type="text" 
                          danger 
                          icon={<DeleteOutlined />}
                          onClick={(e) => handleDeleteDoc(d.doc_id, e)}
                        />
                      </div>
                    ),
                  }))}
              />
              {selectedDoc && (
                <div style={{ marginTop: 8 }}>
                  <Tag color="blue">已选择: {docs.find(d => d.doc_id === selectedDoc)?.filename}</Tag>
                </div>
              )}
              {/* 文档权重调节 */}
              <div style={{ marginTop: 12 }}>
                <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 6 }}>
                  文档权重（向量检索占比）
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
                  <div style={{ flex: 1, minWidth: 600 }}>
                    <Slider
                      style={{ width: '100%' }}
                      value={manualWeight}
                      onChange={setManualWeight}
                      min={0}
                      max={100}
                      step={1}
                      marks={{0:'0%',25:'25%',50:'50%',75:'75%',100:'100%'}}
                      tooltip={{ formatter: (v) => `${v}%` }}
                    />
                  </div>
                  <Tag color="geekblue" style={{ minWidth: 64, textAlign: 'center' }}>{manualWeight}%</Tag>
                </div>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  0% 使用纯 BM25；100% 使用纯向量；默认 50% 混合
                </Text>
              </div>
            </Col>
          </Row>

          {/* 分割线 */}
          <Divider style={{ margin: '8px 0' }} />

          {/* 引导文字 */}
          <div>
            <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 8 }}>
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
              {selectedDoc && <span style={{ marginLeft: 16 }}>📚 已选择操作手册</span>}
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
                {result.provider && (
                  <Tag color="purple">
                    使用模型: {String(result.provider).toUpperCase()}
                  </Tag>
                )}
              </Space>
              <Space>
                <Button icon={<CheckCircleOutlined />} onClick={handleValidate}>重新校验</Button>
                <Button type="primary" icon={<SaveOutlined />} loading={savingResult} onClick={handleSaveResult}>保存结果</Button>
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
                <div style={{ marginBottom: 4, fontSize: 18, fontWeight: 500 }}>
                  {result.nodes_json?.length || 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>节点数量</Text>
              </div>
              
              {/* 逻辑门 */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 4, fontSize: 18, fontWeight: 500 }}>
                  {result.gates_json?.length || 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>逻辑门</Text>
              </div>
              
              {/* 最小割集 */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 4, fontSize: 18, fontWeight: 500 }}>
                  {result.mcs?.length || 0}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>最小割集</Text>
              </div>
            </div>

            {/* 分析摘要 */}
            {result.analysis_summary && (
              <div style={{ marginTop: 16, padding: '12px 16px', background: '#f0f5ff', borderRadius: 8, borderLeft: '3px solid #1890ff' }}>
                <Text strong>分析摘要：</Text>
                <Text style={{ marginLeft: 8 }}>{result.analysis_summary}</Text>
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
              extra={
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
                      <Button icon={<UndoOutlined />} onClick={handleCancelEdit}>
                        取消
                      </Button>
                      <Button
                        type="primary"
                        icon={<SaveOutlined />}
                        loading={saving}
                        onClick={() => editorRef.current?.save?.()}
                        className="btn-primary"
                      >
                        保存
                      </Button>
                    </>
                  )}
                </Space>
              }
              style={{ marginBottom: 24 }}
            >
              {viewMode === 'view' ? (
                <Suspense fallback={null}>
                  <FaultTreeViewer tree={result} />
                </Suspense>
              ) : (
                <Suspense fallback={null}>
                  <TreeEditor 
                    ref={editorRef}
                    initialTree={result}
                    onSave={handleSaveEdit}
                    onCancel={handleCancelEdit}
                  />
                </Suspense>
              )}
            </Card>
          )}

          {result.nodes_json && viewMode === 'view' && (
            <DiagnosisPanel tree={result} />
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
      
      {/* 底部：对话框（模型+手册+权重+输入+发送） */}
      <div style={{ position: 'fixed', left: 300, right: 0, bottom: 0, background: '#fff', borderTop: '1px solid #f0f0f0', padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <Select
            style={{ width: 420 }}
            placeholder="选择已上传的操作手册..."
            value={selectedDoc}
            onChange={setSelectedDoc}
            loading={loadingDocs}
            allowClear
            options={docs.filter(d=>d.status==='active').map(d=>({value:d.doc_id,label:d.filename}))}
          />
          <Select
            style={{ width: 180 }}
            value={selectedProvider}
            onChange={setSelectedProvider}
            options={providers.map(p => {
              const unavailableText = p.reason || '不可用'
              return {
                value: p.name,
                disabled: !p.available,
                label: (
                  <Space>
                    <span style={{ textTransform: 'capitalize' }}>{p.name}</span>
                    <Badge status={p.available ? 'success' : 'error'} text={p.available ? '可用' : unavailableText} />
                  </Space>
                )
              }
            })}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>文档权重</span>
            <Slider style={{ flex: 1, minWidth: 300 }} value={manualWeight} onChange={setManualWeight} min={0} max={100} step={1} marks={{0:'0%',50:'50%',100:'100%'}} />
            <Tag color="geekblue" style={{ minWidth: 48, textAlign: 'center' }}>{manualWeight}%</Tag>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Input.TextArea
            value={topEvent}
            onChange={e=>setTopEvent(e.target.value)}
            placeholder="请描述设备故障现象（例如：电机接通电源后无法启动，伴随异响）"
            autoSize={{ minRows: 2, maxRows: 4 }}
            disabled={loading}
          />
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={handleGenerate} loading={loading}>生成故障树</Button>
        </div>
      </div>
      </div>
      </Layout.Content>
    </Layout>
  )
}
