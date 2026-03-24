import React, { useEffect, useState } from 'react'
import { Row, Col, Card, Typography, Button, List, Tag, Space, Steps, Alert, Divider } from 'antd'
import { 
  FileTextOutlined, 
  ApartmentOutlined, 
  CheckCircleOutlined, 
  ThunderboltOutlined,
  ArrowRightOutlined,
  BookOutlined,
  ToolOutlined,
  RocketOutlined,
  SmileOutlined
} from '@ant-design/icons'
import api from '../services/api.js'

const { Title, Text, Paragraph } = Typography

export default function Dashboard({ onNavigate }) {
  const [stats, setStats] = useState({ total_docs: 0, total_chunks: 0, total_trees: 0, valid_rate: 0 })
  const [recentTrees, setRecentTrees] = useState([])
  const [loading, setLoading] = useState(true)
  const [isFirstTime, setIsFirstTime] = useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        const statsData = await api.getKnowledgeStats()
        setStats(prev => ({
          ...prev,
          total_docs: statsData.total_docs || 0,
          total_chunks: statsData.total_chunks || 0,
        }))

        const trees = await api.listFaultTrees()
        setRecentTrees((trees || []).slice(0, 5))
        
        const totalTrees = trees?.length || 0
        const validTrees = trees?.filter(t => t.is_valid === true).length || 0
        const validRate = totalTrees > 0 ? Math.round((validTrees / totalTrees) * 100) : 0
        
        // 首次使用判断
        setIsFirstTime(totalTrees === 0 && (statsData.total_docs || 0) === 0)
        
        setStats(prev => ({
          ...prev,
          total_trees: totalTrees,
          valid_rate: validRate,
        }))
      } catch (e) {
        console.error('Dashboard load failed:', e)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  // 操作步骤
  const guideSteps = [
    { 
      icon: <BookOutlined />, 
      title: '上传知识', 
      desc: '上传设备手册、维修记录',
      action: () => onNavigate('knowledge'),
      buttonText: '去上传'
    },
    { 
      icon: <ThunderboltOutlined />, 
      title: '生成故障树', 
      desc: '描述故障现象，AI自动生成',
      action: () => onNavigate('generate'),
      buttonText: '去生成'
    },
    { 
      icon: <ToolOutlined />, 
      title: '专家编辑', 
      desc: '手动调整优化故障树',
      action: () => onNavigate('generate'),
      buttonText: '去编辑'
    },
    { 
      icon: <CheckCircleOutlined />, 
      title: '导出报告', 
      desc: '生成分析报告',
      action: () => onNavigate('generate'),
      buttonText: '去导出'
    },
  ]

  // 快速输入示例
  const quickExamples = [
    '电机无法启动',
    '液压系统无压力',
    '控制系统通讯中断',
  ]

  const statItems = [
    { title: '文档总数', value: stats.total_docs, icon: <FileTextOutlined />, color: '#1890ff', desc: '已上传的设备手册' },
    { title: '知识分块', value: stats.total_chunks, icon: <ApartmentOutlined />, color: '#36cfc9', desc: '已向量化的知识' },
    { title: '故障树', value: stats.total_trees, icon: <ThunderboltOutlined />, color: '#faad14', desc: '已生成的故障树' },
    { title: '有效率', value: stats.valid_rate, suffix: '%', icon: <CheckCircleOutlined />, color: '#52c41a', desc: '校验通过率' },
  ]

  const listData = recentTrees.map(t => ({
    id: t.tree_id,
    name: t.top_event,
    time: t.created_at ? new Date(t.created_at).toLocaleString('zh-CN') : '-',
    valid: t.is_valid === true,
    confidence: t.confidence || 0,
  }))

  return (
    <div className="page-container">
      {/* 页面标题 */}
      <div style={{ marginBottom: 24 }}>
        <Title level={3} className="page-title">
          <SmileOutlined style={{ marginRight: 12, color: '#1890ff' }} />
          欢迎使用故障树智能分析系统
        </Title>
        <Text type="secondary" style={{ fontSize: 15 }}>
          基于 MiniMax 大模型，自动生成工业设备故障树
        </Text>
      </div>

      {/* 首次使用引导 */}
      {isFirstTime && !loading && (
        <Card className="glass-card" style={{ marginBottom: 24, border: '1px solid rgba(24,144,255,0.3)' }}>
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <RocketOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 16 }} />
            <Title level={4} style={{ marginBottom: 8 }}>第一次使用？跟着步骤来</Title>
            <Text type="secondary" style={{ fontSize: 14 }}>
              只需3步，就能完成故障树分析
            </Text>
          </div>
          
          <Steps 
            current={0} 
            size="small" 
            style={{ marginTop: 24 }}
            items={guideSteps.map(s => ({
              title: s.title,
              description: s.desc,
              icon: s.icon,
            }))}
          />
          
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Button type="primary" size="large" icon={<BookOutlined />} onClick={() => onNavigate('knowledge')}>
              开始第一步：上传设备手册
            </Button>
          </div>
        </Card>
      )}

      {/* 统计数据 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {statItems.map((s) => (
          <Col xs={12} sm={12} md={6} key={s.title}>
            <Card className="glass-card" size="small" hoverable>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 28, color: s.color, marginBottom: 8 }}>
                  {s.icon}
                </div>
                <div style={{ fontSize: 24, fontWeight: 600, color: '#1a1a1a' }}>
                  {loading ? '-' : s.value}{s.suffix || ''}
                </div>
                <div style={{ fontSize: 12, color: '#595959', marginTop: 4 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: '#8c8c8c' }}>{s.desc}</div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        {/* 最近故障树 */}
        <Col xs={24} lg={14}>
          <Card 
            className="glass-card"
            title={<Space><ApartmentOutlined />最近生成的故障树</Space>}
            extra={<Button type="link" onClick={() => onNavigate('history')} style={{ color: '#1890ff' }}>查看全部</Button>}
          >
            {listData.length > 0 ? (
              <List
                size="small"
                dataSource={listData}
                renderItem={(item) => (
                  <List.Item
                    style={{ borderBottom: '1px solid rgba(24,144,255,0.1)' }}
                    actions={[
                      <Button 
                        key="view" 
                        size="small" 
                        type="link"
                        onClick={() => onNavigate('generate')}
                        style={{ color: '#1890ff' }}
                      >
                        查看 <ArrowRightOutlined />
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={<Text style={{ color: '#1a1a1a' }}>{item.name}</Text>}
                      description={
                        <Space>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {item.time}
                          </Text>
                          <Tag color={item.valid ? 'green' : 'orange'}>
                            {item.valid ? '有效' : '待校验'}
                          </Tag>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 32 }}>
                <ThunderboltOutlined style={{ fontSize: 40, color: '#8c8c8c', marginBottom: 12 }} />
                <div>
                  <Text type="secondary">还没有故障树</Text>
                  <Button 
                    type="link" 
                    onClick={() => onNavigate('generate')}
                    style={{ color: '#1890ff', padding: '0 4px' }}
                  >
                    立即生成
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </Col>

        {/* 快速操作 */}
        <Col xs={24} lg={10}>
          <Card className="glass-card" title={<Space><ToolOutlined />快速开始</Space>}>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              {/* 步骤1 */}
              <div className="flex-between" style={{ padding: '12px 16px', background: 'rgba(24,144,255,0.08)', borderRadius: 8 }}>
                <Space>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1890ff', color: '#fff', textAlign: 'center', lineHeight: '28px', fontSize: 14 }}>1</div>
                  <div>
                    <div style={{ color: '#1a1a1a', fontWeight: 500 }}>上传设备手册</div>
                    <div style={{ color: '#8c8c8c', fontSize: 12 }}>支持 PDF/Word/TXT</div>
                  </div>
                </Space>
                <Button size="small" type="primary" onClick={() => onNavigate('knowledge')}>
                  上传
                </Button>
              </div>

              {/* 步骤2 */}
              <div className="flex-between" style={{ padding: '12px 16px', background: 'rgba(24,144,255,0.08)', borderRadius: 8 }}>
                <Space>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#36cfc9', color: '#fff', textAlign: 'center', lineHeight: '28px', fontSize: 14 }}>2</div>
                  <div>
                    <div style={{ color: '#1a1a1a', fontWeight: 500 }}>描述故障现象</div>
                    <div style={{ color: '#8c8c8c', fontSize: 12 }}>AI 自动生成故障树</div>
                  </div>
                </Space>
                <Button size="small" type="primary" onClick={() => onNavigate('generate')}>
                  生成
                </Button>
              </div>

              {/* 步骤3 */}
              <div className="flex-between" style={{ padding: '12px 16px', background: 'rgba(24,144,255,0.08)', borderRadius: 8 }}>
                <Space>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#faad14', color: '#fff', textAlign: 'center', lineHeight: '28px', fontSize: 14 }}>3</div>
                  <div>
                    <div style={{ color: '#1a1a1a', fontWeight: 500 }}>专家编辑优化</div>
                    <div style={{ color: '#8c8c8c', fontSize: 12 }}>手动调整，导出报告</div>
                  </div>
                </Space>
                <Button size="small" onClick={() => onNavigate('generate')}>
                  编辑
                </Button>
              </div>

              <Divider style={{ margin: '8px 0', borderColor: 'rgba(24,144,255,0.1)' }} />

              {/* 快速示例 */}
              <div>
                <Text type="secondary" style={{ fontSize: 13 }}>试试这样说：</Text>
                <div className="flex-wrap" style={{ marginTop: 8, gap: 8 }}>
                  {quickExamples.map((ex, i) => (
                    <Button 
                      key={i} 
                      size="small" 
                      className="btn-secondary"
                      onClick={() => onNavigate('generate')}
                    >
                      {ex}
                    </Button>
                  ))}
                </div>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
