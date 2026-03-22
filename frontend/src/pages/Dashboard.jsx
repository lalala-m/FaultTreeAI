import React from 'react'
import { Row, Col, Statistic, Card, Progress, Typography, Button, List, Tag, Space } from 'antd'
import { FileTextOutlined, ApartmentOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'

const { Title } = Typography

const stats = [
  { title: '文档总数', value: 0, icon: <FileTextOutlined />, color: '#1677ff' },
  { title: '已分块数', value: 0, icon: <ApartmentOutlined />, color: '#52c41a' },
  { title: '故障树', value: 0, icon: <ApartmentOutlined />, color: '#fa8c16' },
  { title: '有效率', value: 0, suffix: '%', icon: <CheckCircleOutlined />, color: '#13c2c2' },
]

const recentTrees = [
  { id: 1, name: '某设备液压系统故障', time: '2小时前', valid: true, confidence: 0.92 },
  { id: 2, name: '电机启动失败', time: '昨天', valid: true, confidence: 0.88 },
  { id: 3, name: '控制系统失灵', time: '3天前', valid: false, confidence: 0.65 },
]

export default function Dashboard({ onNavigate }) {
  return (
    <div>
      <Title level={4}>系统总览</Title>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        {stats.map((s) => (
          <Col span={6} key={s.title}>
            <Card size="small">
              <Statistic
                title={s.title}
                value={s.value}
                suffix={s.suffix}
                prefix={<span style={{ color: s.color }}>{s.icon}</span>}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={16}>
        <Col span={14}>
          <Card title="最近故障树" extra={<Button type="link" onClick={() => onNavigate('history')}>查看全部</Button>}>
            <List
              size="small"
              dataSource={recentTrees}
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
