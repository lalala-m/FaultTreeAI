import React, { useEffect, useMemo, useState, Suspense, lazy } from 'react'
import { Layout, Menu, Typography, Avatar, Dropdown, Space, message, Drawer, Button } from 'antd'
import { UploadOutlined, HistoryOutlined, DashboardOutlined, ThunderboltOutlined, ApartmentOutlined, BookOutlined, MenuOutlined, PhoneOutlined, PictureOutlined, VideoCameraOutlined } from '@ant-design/icons'
import api from './services/api.js'

const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase.jsx'))
const History = lazy(() => import('./pages/History.jsx'))
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'))
const VisionDetect = lazy(() => import('./pages/vision/VisionDetect.jsx'))
const KnowledgeGraph = lazy(() => import('./pages/KnowledgeGraph.jsx'))
const ManualBook = lazy(() => import('./pages/ManualBook.jsx'))
const Login = lazy(() => import('./pages/auth/Login.jsx'))
const Register = lazy(() => import('./pages/auth/Register.jsx'))
const Profile = lazy(() => import('./pages/auth/Profile.jsx'))

const { Header, Sider, Content } = Layout
const { Title } = Typography
 
export default function App() {
  const [active, setActive] = useState('dashboard')
  const [user, setUser] = useState(null)
  const [isMobile, setIsMobile] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const [mobileCallUI, setMobileCallUI] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.getMe()
        setUser(res?.user || null)
        setActive((prev) => (prev === 'login' || prev === 'register' ? 'dashboard' : prev))
      } catch {
        setUser(null)
        setActive('login')
      }
    }
    load()
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const apply = () => setIsMobile(!!mq.matches)
    apply()
    try {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    } catch {
      mq.addListener(apply)
      return () => mq.removeListener(apply)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    api.prefetchBootstrap?.({ role: user.role })
  }, [user?.role])

  useEffect(() => {
    const h = () => {
      setUser(null)
      setActive('login')
      message.warning('登录已过期，请重新登录')
    }
    window.addEventListener('auth-expired', h)
    return () => window.removeEventListener('auth-expired', h)
  }, [])

  useEffect(() => {
    const handler = () => setActive('dashboard')
    window.addEventListener('dashboard-inject', handler)
    return () => window.removeEventListener('dashboard-inject', handler)
  }, [])

  useEffect(() => {
    const h = () => setMobileActionsOpen(true)
    window.addEventListener('mobile-actions-open', h)
    return () => window.removeEventListener('mobile-actions-open', h)
  }, [])

  const items = useMemo(() => {
    const base = [
      { key: 'dashboard', icon: <DashboardOutlined />, label: '总览' },
      { key: 'manual', icon: <BookOutlined />, label: '规范手册' },
      { key: 'knowledgeGraph', icon: <ApartmentOutlined />, label: '数据云图' },
      { key: 'vision', icon: <ThunderboltOutlined />, label: '视觉识别' },
      { key: 'history', icon: <HistoryOutlined />, label: '历史记录' },
    ]
    if (user?.role === 'expert') {
      base.splice(1, 0, { key: 'knowledge', icon: <UploadOutlined />, label: '知识库' })
    }
    return base
  }, [user?.role])

  const handleAuthDone = async () => {
    try {
      const res = await api.getMe()
      setUser(res?.user || null)
      setActive('dashboard')
    } catch {
      setUser(null)
    }
  }

  const logout = () => {
    api.clearAuthToken?.()
    setUser(null)
    setActive('login')
    message.success('已退出登录')
  }

  const isAuth = !user && (active === 'login' || active === 'register')

  const activeLabel = items.find(i => i.key === active)?.label || ''

  const openVisionTab = (tab) => {
    try {
      window.__visionOpenTab = tab
      window.sessionStorage?.setItem?.('vision-open-tab', String(tab || ''))
    } catch {
    }
    setMobileCallUI(tab === 'call')
    setActive('vision')
    try {
      window.setTimeout(() => {
        try {
          window.dispatchEvent(new CustomEvent('vision-open', { detail: { tab } }))
        } catch {
        }
      }, 0)
    } catch {
    }
  }

  useEffect(() => {
    if (active !== 'vision') setMobileCallUI(false)
  }, [active])

  return (
    <Layout style={{ minHeight: '100dvh', height: '100dvh' }}>
      {isAuth ? (
        <div
          style={{
            minHeight: '100dvh',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background:
              'radial-gradient(1200px 800px at 15% 15%, rgba(22,119,255,0.16), rgba(255,255,255,0) 62%), radial-gradient(900px 600px at 85% 25%, rgba(82,196,26,0.10), rgba(255,255,255,0) 58%), linear-gradient(135deg, #f4f8ff 0%, #eef4ff 45%, #f7fbff 100%)',
          }}
        >
          <div style={{ width: '100%', maxWidth: 440 }}>
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <Title level={2} style={{ margin: 0, color: '#1f2d3d', letterSpacing: 2 }}>故障检修系统</Title>
              <div style={{ marginTop: 6, fontSize: 13, color: 'rgba(31,45,61,0.72)' }}>
                工业故障分析与知识助手
              </div>
            </div>
            <Suspense fallback={null}>
              {active === 'register' ? (
                <Register onDone={handleAuthDone} onGoLogin={() => setActive('login')} />
              ) : (
                <Login onDone={handleAuthDone} onGoRegister={() => setActive('register')} />
              )}
            </Suspense>
          </div>
        </div>
      ) : (
        <>
          {!isMobile && (
            <Sider
              breakpoint="lg"
              collapsedWidth="0"
              style={{ background: '#001529', position: 'sticky', top: 0, height: '100dvh', overflow: 'auto' }}
            >
            <div style={{
              height: 60, display: 'flex', alignItems: 'center',
              justifyContent: 'center', borderBottom: '1px solid #ffffff15'
            }}>
              <Title level={4} style={{ color: '#fff', margin: 0, letterSpacing: 1 }}>
                故障检修系统
              </Title>
            </div>
            {active !== 'login' && active !== 'register' && (
              <Menu
                theme="dark"
                mode="inline"
                selectedKeys={[active]}
                onClick={({ key }) => {
                  if (key === 'knowledge' && user?.role !== 'expert') {
                    message.warning('知识库仅专家可访问')
                    return
                  }
                  setActive(key)
                }}
                items={items}
              />
            )}
            </Sider>
          )}

          <Layout style={{ minHeight: 0 }}>
            <Header style={{
              background: '#fff', padding: isMobile ? '0 12px' : '0 24px',
              display: 'flex', alignItems: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
              position: 'sticky', top: 0, zIndex: 20,
              ...(isMobile && mobileCallUI && active === 'vision' ? { display: 'none' } : null)
            }}>
              {isMobile && (
                <Button
                  type="text"
                  icon={<MenuOutlined />}
                  onClick={() => setMobileMenuOpen(true)}
                  style={{ padding: 0, width: 36, height: 36 }}
                />
              )}
              <Title level={5} style={{ margin: 0, color: '#1f1f1f', flex: 1, textAlign: isMobile ? 'center' : 'left' }}>
                {activeLabel}
              </Title>
              {isMobile && (
                <Button
                  type="text"
                  icon={<PhoneOutlined />}
                  onClick={() => openVisionTab('call')}
                  style={{ padding: 0, width: 36, height: 36 }}
                />
              )}
              <div style={{ marginLeft: isMobile ? 0 : 'auto' }}>
                {user ? (
                  <Dropdown
                    menu={{
                      items: [
                        { key: 'profile', label: '个人中心', onClick: () => setActive('profile') },
                        { type: 'divider' },
                        { key: 'logout', label: '退出登录', onClick: logout },
                      ]
                    }}
                  >
                    <Space style={{ cursor: 'pointer' }}>
                      <Avatar
                        size={isMobile ? 28 : 32}
                        src={user?.avatar_base64 ? `data:image/*;base64,${user.avatar_base64}` : undefined}
                      >
                        {String(user?.full_name || user?.username || 'U').slice(0, 1).toUpperCase()}
                      </Avatar>
                      {!isMobile && <span style={{ fontSize: 13, color: '#111' }}>{user?.full_name || user?.username}</span>}
                    </Space>
                  </Dropdown>
                ) : (
                  <span style={{ fontSize: 13, color: '#888' }}>未登录</span>
                )}
              </div>
            </Header>

            <Content style={{ padding: isMobile ? (active === 'vision' ? 0 : 12) : 24, overflow: isMobile && active === 'dashboard' ? 'hidden' : 'auto', minHeight: 0, paddingBottom: isMobile && active === 'dashboard' ? 96 : undefined }}>
              <Suspense fallback={null}>
                {!user && active !== 'register' && (
                  <Login onDone={handleAuthDone} onGoRegister={() => setActive('register')} />
                )}
                {!user && active === 'register' && (
                  <Register onDone={handleAuthDone} onGoLogin={() => setActive('login')} />
                )}
                {user && active === 'profile' && <Profile user={user} onUserChange={setUser} />}
                {user && active === 'dashboard' && <Dashboard onNavigate={setActive} user={user} mobile={isMobile} />}
                {user && active === 'knowledge' && <KnowledgeBase />}
                {user && active === 'manual' && <ManualBook />}
                {user && active === 'knowledgeGraph' && <KnowledgeGraph />}
                {user && active === 'vision' && <VisionDetect onNavigate={setActive} />}
                {user && active === 'history' && <History />}
              </Suspense>
            </Content>
          </Layout>

          {isMobile && (
            <>
              <Drawer
                open={mobileMenuOpen}
                placement="left"
                width={260}
                onClose={() => setMobileMenuOpen(false)}
                title="故障检修系统"
              >
                <Menu
                  mode="inline"
                  selectedKeys={[active]}
                  onClick={({ key }) => {
                    if (key === 'knowledge' && user?.role !== 'expert') {
                      message.warning('知识库仅专家可访问')
                      return
                    }
                    setActive(key)
                    setMobileMenuOpen(false)
                  }}
                  items={items}
                />
              </Drawer>

              <Drawer
                open={mobileActionsOpen}
                placement="bottom"
                height={220}
                onClose={() => setMobileActionsOpen(false)}
                title="快捷操作"
              >
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Button
                    icon={<PictureOutlined />}
                    onClick={() => {
                      setMobileActionsOpen(false)
                      openVisionTab('image')
                    }}
                    block
                  >
                    图片识别
                  </Button>
                  <Button
                    icon={<VideoCameraOutlined />}
                    onClick={() => {
                      setMobileActionsOpen(false)
                      openVisionTab('video')
                    }}
                    block
                  >
                    视频识别
                  </Button>
                </Space>
              </Drawer>

            </>
          )}
        </>
      )}
    </Layout>
  )
}
