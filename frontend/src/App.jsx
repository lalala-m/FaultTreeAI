import React, { useEffect, useMemo, useState, Suspense, lazy } from 'react'
import { Layout, Menu, Typography, Collapse, Space, Tag, Button } from 'antd'
import { UploadOutlined, ApiOutlined, HistoryOutlined, DashboardOutlined, ThunderboltOutlined } from '@ant-design/icons'
import api from './services/api.js'

const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase.jsx'))
const Generate = lazy(() => import('./pages/Generate.jsx'))
const History = lazy(() => import('./pages/History.jsx'))
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'))
const VisionDetect = lazy(() => import('./pages/vision/VisionDetect.jsx'))

const { Header, Sider, Content } = Layout
const { Title } = Typography

export default function App() {
  const [active, setActive] = useState('dashboard')
  const [histories, setHistories] = useState([])

  useEffect(() => {
    api.prefetchBootstrap?.()
  }, [])

  useEffect(() => {
    const handler = () => setActive('dashboard')
    window.addEventListener('dashboard-inject', handler)
    return () => window.removeEventListener('dashboard-inject', handler)
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.listFaultTrees()
        setHistories(Array.isArray(data) ? data.slice(0, 20) : [])
      } catch {
        setHistories([])
      }
    }
    if (active === 'dashboard') load()
  }, [active])

  const items = useMemo(() => ([
    { key: 'dashboard', icon: <DashboardOutlined />, label: '总览' },
    { key: 'knowledge', icon: <UploadOutlined />, label: '知识库' },
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
        {active === 'dashboard' && (
          <div style={{ padding: 12, color: '#d9d9d9' }}>
            <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.85 }}>历史记录</div>
            <Collapse accordion ghost style={{ background: 'transparent' }}>
              {histories.map((h) => (
                <Collapse.Panel 
                  header={
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%' }}>
                      <div style={{
                        flex: 1,
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                        lineHeight: 1.3
                      }}>
                        {h.top_event}
                      </div>
                      <Tag color={h.is_valid ? 'green' : 'orange'} style={{ flexShrink: 0 }}>
                        {h.is_valid ? '有效' : '待校验'}
                      </Tag>
                    </div>
                  }
                  key={h.tree_id}
                  style={{ color: '#d9d9d9' }}
                >
                  <div style={{ fontSize: 12, marginBottom: 8 }}>{(h.created_at || '').slice(0, 19)}</div>
                  <Button size="small" onClick={() => setActive('history')}>查看详情</Button>
                </Collapse.Panel>
              ))}
            </Collapse>
          </div>
        )}
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
            {active === 'generate' && <Generate />}
            {active === 'vision' && <VisionDetect />}
            {active === 'history' && <History />}
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  )
}
