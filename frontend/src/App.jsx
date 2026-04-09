import React, { useEffect, useMemo, useState, Suspense, lazy } from 'react'
import { Layout, Menu, Typography, Card, Space, Tag, Button, Empty, message } from 'antd'
import { UploadOutlined, ApiOutlined, HistoryOutlined, DashboardOutlined, ThunderboltOutlined, ApartmentOutlined, CloudOutlined, ReloadOutlined } from '@ant-design/icons'
import api from './services/api.js'

const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase.jsx'))
const Generate = lazy(() => import('./pages/Generate.jsx'))
const History = lazy(() => import('./pages/History.jsx'))
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'))
const VisionDetect = lazy(() => import('./pages/vision/VisionDetect.jsx'))
const KnowledgeGraph = lazy(() => import('./pages/KnowledgeGraph.jsx'))

const { Header, Sider, Content } = Layout
const { Title } = Typography

function DataCloud() {
  const [loading, setLoading] = useState(false)
  const [docs, setDocs] = useState([])

  const load = async () => {
    setLoading(true)
    try {
      const data = await api.listDocuments()
      setDocs(Array.isArray(data) ? data.filter(d => d && d.status !== 'deleted') : [])
    } catch (e) {
      setDocs([])
      message.error(e.response?.data?.detail || e.message || '加载失败')
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const tags = useMemo(() => {
    return (docs || [])
      .map(d => {
        const weight = Number(d.current_weight)
        const w = Number.isFinite(weight) ? weight : 0.5
        const size = 12 + Math.round(w * 16)
        const count = Number(d.feedback_count || 0)
        const color = w >= 0.7 ? 'green' : w >= 0.5 ? 'blue' : 'orange'
        return {
          key: d.doc_id,
          label: d.filename || String(d.doc_id),
          weight: w,
          size,
          color,
          count,
        }
      })
      .sort((a, b) => b.weight - a.weight)
  }, [docs])

  return (
    <div className="page-container">
      <div style={{ marginBottom: 16 }}>
        <Title level={3} className="page-title">数据云图</Title>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
          <Tag>文档 {docs.length}</Tag>
        </Space>
      </div>

      <Card className="glass-card">
        {tags.length === 0 ? (
          <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description="暂无数据（请先上传文档或检查后端接口）" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, lineHeight: 1.2 }}>
            {tags.map(t => (
              <Tag key={t.key} color={t.color} style={{ fontSize: t.size, padding: '6px 10px' }}>
                {t.label} {t.count ? `(${t.count})` : ''}
              </Tag>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

export default function App() {
  const [active, setActive] = useState('dashboard')

  useEffect(() => {
    api.prefetchBootstrap?.()
  }, [])

  useEffect(() => {
    const handler = () => setActive('dashboard')
    window.addEventListener('dashboard-inject', handler)
    return () => window.removeEventListener('dashboard-inject', handler)
  }, [])

  const items = useMemo(() => ([
    { key: 'dashboard', icon: <DashboardOutlined />, label: '总览' },
    { key: 'knowledge', icon: <UploadOutlined />, label: '知识库' },
    { key: 'knowledgeGraph', icon: <ApartmentOutlined />, label: '知识图谱' },
    { key: 'dataCloud', icon: <CloudOutlined />, label: '数据云图' },
    { key: 'generate', icon: <ApiOutlined />, label: '生成故障树' },
    { key: 'vision', icon: <ThunderboltOutlined />, label: '视觉识别' },
    { key: 'history', icon: <HistoryOutlined />, label: '历史记录' },
  ]), [])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" style={{ background: '#001529' }}>
        <div style={{
          height: 60, display: 'flex', alignItems: 'center',
          justifyContent: 'center', borderBottom: '1px solid #ffffff15'
        }}>
          <Title level={4} style={{ color: '#fff', margin: 0, letterSpacing: 1 }}>
            故障树AI
          </Title>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[active]}
          onClick={({ key }) => setActive(key)}
          items={items}
        />
      </Sider>

      <Layout>
        <Header style={{
          background: '#fff', padding: '0 24px',
          display: 'flex', alignItems: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.1)'
        }}>
          <Title level={5} style={{ margin: 0, color: '#1f1f1f' }}>
            {items.find(i => i.key === active)?.label}
          </Title>
          <div style={{ marginLeft: 'auto', fontSize: 13, color: '#888' }}>
            MiniMax + PostgreSQL + pgvector
          </div>
        </Header>

        <Content style={{ padding: 24, overflow: 'auto' }}>
          <Suspense fallback={null}>
            {active === 'dashboard' && <Dashboard onNavigate={setActive} />}
            {active === 'knowledge' && <KnowledgeBase />}
            {active === 'knowledgeGraph' && <KnowledgeGraph />}
            {active === 'dataCloud' && <DataCloud />}
            {active === 'generate' && <Generate />}
            {active === 'vision' && <VisionDetect />}
            {active === 'history' && <History />}
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  )
}
