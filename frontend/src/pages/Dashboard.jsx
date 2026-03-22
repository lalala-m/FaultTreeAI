import React, { useEffect, useState } from 'react'
import { Row, Col, Statistic, Card, Progress, Typography, Button, List, Tag, Space } from 'antd'
import { FileTextOutlined, ApartmentOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import api from '../services/api.js'

const { Title } = Typography

export default function Dashboard({ onNavigate }) {
  const [stats, setStats] = useState({ total_docs: 0, total_chunks: 0, total_trees: 0, valid_rate: 0 })
  const [recentTrees, setRecentTrees] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      try {
        // 知识库统计
        const statsData = await api.get('/api/knowledge/stats')
        setStats(prev => ({
          ...prev,
          total_docs: statsData.total_docs || 0,
          total_chunks: statsData.total_chunks || 0,
        }))

        // 最近故障树列表
        const trees = await api.listFaultTrees()
        setRecentTrees((trees || []).slice(0, 5))
        
        // 计算故障树总数和有效率
        const totalTrees = trees?.length || 0
        const validTrees = trees?.filter(t => t.is_valid === true).length || 0
        const validRate = totalTrees > 0 ? Math.round((validTrees / totalTrees) * 100) : 0
        
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

  const statItems = [
    { title: '文档总数', value: stats.total_docs, icon: <FileTextOutlined />, color: '#1677ff' },
    { title: '已分块数', value: stats.total_chunks, icon: <ApartmentOutlined />, color: '#52c41a' },
    { title: '故障树', value: stats.total_trees, icon: <ApartmentOutlined />, color: '#fa8c16' },
    { title: '有效率', value: stats.valid_rate, suffix: '%', icon: <CheckCircleOutlined />, color: '#13c2c2' },
  ]

  const listData = recentTrees.map(t => ({
    id: t.tree_id,
    name: t.top_event,
    time: t.created_at ? new Date(t.created_at).toLocaleString('zh-CN') : '-',
    valid: t.is_valid === true,
    confidence: t.confidence || 0,
  }))

  return (
    <div>
      <Title level={4}>系统总览</Title>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        {statItems.map((s) => (
          <Col span={6} key={s.title}>
            <Card size="small">
              <Statistic
                title={s.title}
                value={loading ? '-' : s.value}
                suffix={s.suffix}
                prefix={<span style={{ color: s.color }}>{s.icon}</span>}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={16}>
        <Col span={14}>
          <Card 
            title="最近故障树" 
            extra={<Button type="link" onClick={() => onNavigate('history')}>查看全部</Button>}
            loading={loading}
          >
            {listData.length > 0 ? (
              <List
                size="small"
                dataSource={listData}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button key="view" size="small" type="link"
                        onClick={() => onNavigate('generate')}>查看</Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={item.name}
                      description={`置信度 ${(item.confidence * 100).toFixed(0)}% · ${item.time}`}
                    />
                    <Tag color={item.valid ? 'green' : 'red'} style={{ marginRight: 0 }}>
                      {item.valid ? '有效' : '需校验'}
                    </Tag>
                  </List.Item>
                )}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 24, color: '#888' }}>
                暂无故障树数据
              </div>
            )}
          </Card>
        </Col>

        <Col span={10}>
          <Card title="快速开始" size="small">
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Button type="primary" block icon={<FileTextOutlined />}
                onClick={() => onNavigate('knowledge')}>
                上传设备文档
              </Button>
              <Button block icon={<ApartmentOutlined />}
                onClick={() => onNavigate('generate')}>
                生成故障树
              </Button>
              <Button block icon={<CheckCircleOutlined />}>
                校验已有故障树
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
