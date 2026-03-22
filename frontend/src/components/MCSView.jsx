import React from 'react'
import { Card, Table, Tag, Typography, Space, Row, Col, Statistic } from 'antd'

const { Text } = Typography

export default function MCSView({ mcs, importance }) {
  if (!mcs || mcs.length === 0) {
    return (
      <Card>
        <Text type="secondary">暂无最小割集数据</Text>
      </Card>
    )
  }

  // 最小割集表格列
  const mcsColumns = [
    { 
      title: '序号', 
      dataIndex: 'key', 
      key: 'key',
      width: 60,
      render: (_, record) => record.key + 1,
    },
    {
      title: '最小割集（底事件组合）',
      dataIndex: 'events',
      key: 'events',
      render: (events) => (
        <Space wrap>
          {events.map((event, idx) => (
            <Tag key={idx} color="blue">{event}</Tag>
          ))}
        </Space>
      ),
    },
    { 
      title: '割集阶数', 
      dataIndex: 'order', 
      key: 'order',
      width: 100,
      render: (order) => <Tag color={order === 1 ? 'red' : order === 2 ? 'orange' : 'default'}>{order}</Tag>,
    },
  ]

  // 准备最小割集数据
  const mcsDataSource = mcs.map((cutSet, index) => ({
    key: index,
    events: cutSet,
    order: cutSet.length,
  }))

  // 重要度表格列
  const importanceColumns = [
    { 
      title: '排名', 
      dataIndex: 'rank', 
      key: 'rank',
      width: 60,
    },
    {
      title: '底事件',
      dataIndex: 'node_id',
      key: 'node_id',
      render: (nodeId) => <Tag>{nodeId}</Tag>,
    },
    { 
      title: 'Birnbaum 重要度', 
      dataIndex: 'importance', 
      key: 'importance',
      render: (val) => <Text strong>{val?.toFixed(4) || '-'}</Text>,
    },
  ]

  // 准备重要度数据
  const importanceDataSource = (importance || []).map((item, index) => ({
    key: index,
    rank: index + 1,
    node_id: item.node_id || item.id || '-',
    importance: item.importance || item.value || 0,
  }))

  // 计算统计信息
  const totalMCS = mcs.length
  const firstOrderMCS = mcs.filter(cut => cut.length === 1).length
  const secondOrderMCS = mcs.filter(cut => cut.length === 2).length

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* 统计信息 */}
      <Card size="small">
        <Row gutter={16}>
          <Col span={6}>
            <Statistic title="最小割集总数" value={totalMCS} />
          </Col>
          <Col span={6}>
            <Statistic title="一阶割集" value={firstOrderMCS} valueStyle={{ color: '#ff4d4f' }} />
          </Col>
          <Col span={6}>
            <Statistic title="二阶割集" value={secondOrderMCS} valueStyle={{ color: '#fa8c16' }} />
          </Col>
          <Col span={6}>
            <Statistic title="高阶割集" value={totalMCS - firstOrderMCS - secondOrderMCS} valueStyle={{ color: '#52c41a' }} />
          </Col>
        </Row>
      </Card>

      {/* 最小割集表格 */}
      <Card title="最小割集（MOCUS）">
        <Table
          dataSource={mcsDataSource}
          columns={mcsColumns}
          pagination={{ pageSize: 10 }}
          size="small"
          scroll={{ x: true }}
        />
        <Text type="secondary" style={{ marginTop: 8, display: 'block' }}>
          说明：最小割集数量 = {totalMCS} 个 | 顶事件失效 = 任意割集内所有底事件同时发生时触发
        </Text>
      </Card>

      {/* 重要度表格 */}
      {importanceDataSource.length > 0 && (
        <Card title="Birnbaum 重要度排序">
          <Table
            dataSource={importanceDataSource}
            columns={importanceColumns}
            pagination={false}
            size="small"
            scroll={{ x: true }}
          />
          <Text type="secondary" style={{ marginTop: 8, display: 'block' }}>
            说明：重要度越高表示该底事件对顶事件发生的影响越大
          </Text>
        </Card>
      )}
    </Space>
  )
}
