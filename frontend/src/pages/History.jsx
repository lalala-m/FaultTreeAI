import React, { useRef, useState, useEffect, Suspense, lazy } from 'react'
import { Card, Table, Tag, Typography, Button, Space, Empty, Modal, message } from 'antd'
import { EyeOutlined, FileWordOutlined } from '@ant-design/icons'
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
  const [sessionMsgs, setSessionMsgs] = useState([])
  const [fsOpen, setFsOpen] = useState(false)
  const [fsMode, setFsMode] = useState('view')
  const [fsTree, setFsTree] = useState(null)
  const [fsSaving, setFsSaving] = useState(false)
  const fsEditorRef = useRef(null)
  const fsWrapRef = useRef(null)
  const [fsNativeOpen, setFsNativeOpen] = useState(false)
  const fsLayerRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => {
      if (fsNativeOpen && e.key === 'Escape') {
        try { document.fullscreenElement && document.exitFullscreen() } catch {}
        setFsNativeOpen(false)
      }
    }
    if (fsNativeOpen) {
      window.addEventListener('keydown', onKey)
    }
    return () => window.removeEventListener('keydown', onKey)
  }, [fsNativeOpen])

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
      const sess = await api.getSessionByTree(row.tree_id).catch(()=>({messages: []}))
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
      setSessionMsgs(Array.isArray(sess?.messages) ? sess.messages : [])
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
                <Button key="fsview" onClick={() => { setFsTree(selected); setFsMode('view'); setFsOpen(true) }}>全屏查看</Button>,
                <Button key="fsedit" type="dashed" onClick={() => { setFsTree(selected); setFsMode('edit'); setFsOpen(true) }}>全屏编辑</Button>,
              <Button key="nativefs" type="primary" onClick={() => { setFsTree(selected); setFsMode('view'); setFsNativeOpen(true); setTimeout(()=>{ try{ fsLayerRef.current?.requestFullscreen?.() }catch{} },50) }}>系统全屏</Button>,
              <Button key="loadchat" onClick={() => {
                try {
                  sessionStorage.setItem('dashboard_chat_inject', JSON.stringify({ messages: sessionMsgs, ts: Date.now() }))
                  window.dispatchEvent(new Event('dashboard-inject'))
                  message.success('已加载到主页对话');
                } catch {}
              }}>加载到主页继续对话</Button>,
                <Button key="edit" type="primary" onClick={() => setMode('edit')}>编辑</Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setMode('view')}>取消</Button>,
                <Button key="save" type="primary" loading={saving} onClick={() => editorRef.current?.save?.()}>保存</Button>,
              ]
        }
        width={900}
      >
        {mode === 'view' && (
          <Card size="small" title="对话内容" style={{ marginBottom: 12 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {sessionMsgs && sessionMsgs.length > 0 ? sessionMsgs.map((m, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '80%',
                    padding: 8,
                    borderRadius: 8,
                    background: m.role === 'user' ? '#e6f7ff' : '#fafafa',
                    border: '1px solid #f0f0f0'
                  }}>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{String(m.text || '')}</div>
                  </div>
                </div>
              )) : <Empty description="暂无对话记录" />}
            </Space>
          </Card>
        )}
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
      <Modal
        open={fsOpen}
        title={fsTree?.top_event || '故障树'}
        onCancel={() => setFsOpen(false)}
        width="96vw"
        style={{ top: 8 }}
        bodyStyle={{ height: '78vh', overflow: 'auto' }}
        footer={
          fsMode === 'view'
            ? [
                <Button key="exitfs" onClick={() => { try { document.fullscreenElement && document.exitFullscreen() } catch {} setFsOpen(false) }}>退出全屏</Button>,
                <Button key="close" onClick={() => setFsOpen(false)}>关闭</Button>,
                <Button key="edit" type="primary" onClick={() => setFsMode('edit')}>专家编辑</Button>,
              ]
            : [
                <Button key="exitfs" onClick={() => { try { document.fullscreenElement && document.exitFullscreen() } catch {} setFsOpen(false) }}>退出全屏</Button>,
                <Button key="cancel" onClick={() => setFsMode('view')}>取消</Button>,
                <Button key="save" type="primary" loading={fsSaving} onClick={async () => {
                  if (!fsTree?.tree_id || !fsEditorRef.current) return
                  setFsSaving(true)
                  try {
                    const edited = await fsEditorRef.current.save()
                    await api.saveFaultTree(fsTree.tree_id, {
                      nodes: edited.nodes,
                      gates: edited.gates,
                      fault_tree: edited.fault_tree,
                      mcs: fsTree.mcs,
                      importance: fsTree.importance,
                      validation_issues: fsTree.validation_issues,
                    })
                    message.success('已保存到数据库')
                    setFsMode('view')
                  } catch (e) {
                    message.error(e?.message || '保存失败')
                  }
                  setFsSaving(false)
                }}>保存</Button>,
              ]
        }
      >
        <Suspense fallback={null}>
          <div ref={fsWrapRef} style={{ width: '100%', height: '100%', background: '#fff' }}>
            {fsTree && fsMode === 'view' && <FaultTreeViewer tree={fsTree} />}
            {fsTree && fsMode === 'edit' && (
              <TreeEditor
                ref={fsEditorRef}
                initialTree={fsTree}
                onSave={() => {}}
                onCancel={() => setFsMode('view')}
              />
            )}
          </div>
        </Suspense>
      </Modal>
      {fsNativeOpen && (
        <div 
          ref={fsLayerRef}
          style={{
            position: 'fixed', inset: 0, background: '#fff', zIndex: 9999,
            display: 'flex', flexDirection: 'column'
          }}
        >
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 600 }}>{fsTree?.top_event || '故障树'}</div>
            <Space>
              {fsMode === 'view' ? (
                <Button type="primary" onClick={() => setFsMode('edit')}>专家编辑</Button>
              ) : (
                <Button type="primary" loading={fsSaving} onClick={async () => {
                  if (!fsTree?.tree_id || !fsEditorRef.current) return
                  setFsSaving(true)
                  try {
                    const edited = await fsEditorRef.current.save()
                    await api.saveFaultTree(fsTree.tree_id, {
                      nodes: edited.nodes,
                      gates: edited.gates,
                      fault_tree: edited.fault_tree,
                      mcs: fsTree.mcs,
                      importance: fsTree.importance,
                      validation_issues: fsTree.validation_issues,
                    })
                    message.success('已保存到数据库')
                    setFsMode('view')
                  } catch (e) {
                    message.error(e?.message || '保存失败')
                  }
                  setFsSaving(false)
                }}>保存</Button>
              )}
              <Button onClick={() => { try { document.fullscreenElement && document.exitFullscreen() } catch {} setFsNativeOpen(false) }}>退出全屏</Button>
            </Space>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Suspense fallback={null}>
              {fsTree && fsMode === 'view' && <FaultTreeViewer tree={fsTree} height="calc(100vh - 56px)" />}
              {fsTree && fsMode === 'edit' && (
                <TreeEditor
                  ref={fsEditorRef}
                  initialTree={fsTree}
                  onSave={() => {}}
                  onCancel={() => setFsMode('view')}
                />
              )}
            </Suspense>
          </div>
        </div>
      )}
    </div>
  )
}
