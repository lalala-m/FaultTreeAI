import React, { useState, useEffect } from 'react'
import { Card, Table, Tag, Typography, Button, Space, Empty, Modal } from 'antd'
import { EyeOutlined, DeleteOutlined, FileWordOutlined } from '@ant-design/icons'
import api from '../services/api.js'
import FaultTreeViewer from '../components/FaultTreeViewer.jsx'

const { Title } = Typography

export default function History() {
  const [trees, setTrees] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  const loadTrees = async () => {
    setLoading(true)
    try {
      const data = await api.listFaultTrees()
      setTrees(Array.isArray(data) ? data : [])
    } catch {
      setTrees([])
    }
    setLoading(false)
  }

  useEffect(() => { loadTrees() }, [])

  const handleExport = async (tree) => {
    try {
      const blob = await api.exportWord(tree)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `故障树_${tree.top_event}.docx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error(err)
    }
  }

  const columns = [
    {
      title: '顶事件', dataIndex: 'top_event', key: 'top_event',
      ellipsis: true,
    },
    {
      title: '置信度', dataIndex: 'confidence', key: 'confidence',
      render: (v) => v != null
        ? <Tag color={v > 0.8 ? 'green' : v > 0.6 ? 'orange' : 'red'}>
            {(v * 100).toFixed(1)}%
          </Tag>
        : '-',
    },
    {
      title: '有效性', dataIndex: 'is_valid', key: 'is_valid',
      render: (v) => v === true
        ? <Tag color="green">有效</Tag>
        : v === false
        ? <Tag color="red">无效</Tag>
        : <Tag>未校验</Tag>,
    },
    {
      title: '生成时间', dataIndex: 'created_at', key: 'created_at',
      render: (t) => t ? new Date(t).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作', key: 'action', width: 180,
      render: (_, row) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />}
            onClick={() => setSelected(row)}>查看</Button>
          <Button size="small" icon={<FileWordOutlined />}
            onClick={() => handleExport(row)}>导出</Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>历史记录</Title>
        <Button onClick={loadTrees}>刷新</Button>
      </div>

      <Card>
        <Table
          rowKey="tree_id"
          columns={columns}
          dataSource={trees}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无历史记录" /> }}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        open={!!selected}
        title={selected?.top_event}
        onCancel={() => setSelected(null)}
        footer={null}
        width={900}
      >
        {selected && <FaultTreeViewer tree={selected} />}
      </Modal>
    </div>
  )
}
