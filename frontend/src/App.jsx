import React, { useEffect, useMemo, useState, Suspense, lazy } from 'react'
import { Layout, Menu, Typography } from 'antd'
import { UploadOutlined, ApiOutlined, HistoryOutlined, DashboardOutlined, ThunderboltOutlined, ApartmentOutlined } from '@ant-design/icons'
import api from './services/api.js'

const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase.jsx'))
const Generate = lazy(() => import('./pages/Generate.jsx'))
const History = lazy(() => import('./pages/History.jsx'))
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'))
const VisionDetect = lazy(() => import('./pages/vision/VisionDetect.jsx'))
const KnowledgeGraph = lazy(() => import('./pages/KnowledgeGraph.jsx'))

const { Header, Sider, Content } = Layout
const { Title } = Typography

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
    { key: 'knowledgeGraph', icon: <ApartmentOutlined />, label: '数据云图' },
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
            {active === 'generate' && <Generate />}
            {active === 'vision' && <VisionDetect />}
            {active === 'history' && <History />}
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  )
}
