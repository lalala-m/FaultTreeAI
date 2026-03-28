import React, { useRef, useState, useEffect, Suspense, lazy } from 'react'
import { Card, Table, Tag, Typography, Button, Space, Empty, Modal, message } from 'antd'
import { EyeOutlined, DeleteOutlined, FileWordOutlined } from '@ant-design/icons'
import api from '../services/api.js'

const FaultTreeViewer = lazy(() => import('../components/FaultTreeViewer.jsx'))
const TreeEditor = lazy(() => import('../components/TreeEditor.jsx'))

const { Title } = Typography

export default function History() {
  const [trees, setTrees] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [mode, setMode] = useState('view')
  const [saving, setSaving] = useState(false)
  const editorRef = useRef(null)

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
      const detail = await api.getFaultTree(tree.tree_id)
      const blob = await api.exportWord(detail.fault_tree)
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

  const handleView = async (row) => {
    setDetailLoading(true)
    try {
      const detail = await api.getFaultTree(row.tree_id)
      setMode('view')
      setSelected({
        tree_id: detail.tree_id || row.tree_id,
        fault_tree: detail.fault_tree,
        top_event: detail.fault_tree?.top_event,
        nodes_json: detail.fault_tree?.nodes,
        gates_json: detail.fault_tree?.gates,
        confidence: detail.fault_tree?.confidence,
        analysis_summary: detail.fault_tree?.analysis_summary,
        mcs: detail.mcs,
        importance: detail.importance,
        validation_issues: detail.validation_issues,
      })
    } catch (e) {
      message.error(e.response?.data?.detail || '加载详情失败')
    }
    setDetailLoading(false)
  }

  const handleSaveEdited = async (editedData) => {
    if (!selected?.tree_id) return
    setSaving(true)
    try {
      const payload = {
        nodes: editedData.nodes,
        gates: editedData.gates,
        fault_tree: editedData.fault_tree,
        mcs: selected.mcs,
        importance: selected.importance,
        validation_issues: selected.validation_issues,
      }
      await api.saveFaultTree(selected.tree_id, payload)
      setSelected(prev => ({
        ...prev,
        fault_tree: editedData.fault_tree,
        nodes_json: editedData.nodes,
        gates_json: editedData.gates,
      }))
      message.success('已保存到数据库')
      setMode('view')
      await loadTrees()
    } catch (e) {
      message.error(e.response?.data?.detail || '保存失败')
    }
    setSaving(false)
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
            onClick={() => handleView(row)} loading={detailLoading && selected?.tree_id === row.tree_id}>查看</Button>
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
        onCancel={() => { setSelected(null); setMode('view') }}
        footer={
          mode === 'view'
            ? [
                <Button key="close" onClick={() => setSelected(null)}>关闭</Button>,
                <Button key="edit" type="primary" onClick={() => setMode('edit')}>编辑</Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setMode('view')}>取消</Button>,
                <Button key="save" type="primary" loading={saving} onClick={() => editorRef.current?.save?.()}>保存</Button>,
              ]
        }
        width={900}
      >
        <Suspense fallback={null}>
          {selected && mode === 'view' && <FaultTreeViewer tree={selected} />}
          {selected && mode === 'edit' && (
            <TreeEditor
              ref={editorRef}
              initialTree={selected}
              onSave={handleSaveEdited}
              onCancel={() => setMode('view')}
            />
          )}
        </Suspense>
      </Modal>
    </div>
  )
}
