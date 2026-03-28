import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
})

// ── 知识库 ──────────────────────────────────────────

export const uploadDocument = async (file, onProgress) => {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post('/knowledge/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => onProgress?.(Math.round((e.loaded * 100) / (e.total || 1))),
  })
  return data
}

export const listDocuments = async () => {
  const { data } = await api.get('/knowledge/list')
  return data
}

export const deleteDocument = async (docId) => {
  const { data } = await api.delete(`/knowledge/${docId}`)
  return data
}

export const searchKnowledge = async (query, topK = 5) => {
  const { data } = await api.post('/knowledge/search', null, {
    params: { query, top_k: topK }
  })
  return data
}

export const getKnowledgeStats = async () => {
  const { data } = await api.get('/knowledge/stats')
  return data
}

// ── 故障树生成 ──────────────────────────────────────

export const generateFaultTree = async (params) => {
  const { data } = await api.post('/generate/', params)
  return data
}

export const getFaultTree = async (treeId) => {
  const { data } = await api.get(`/generate/${treeId}`)
  return data
}

export const listFaultTrees = async () => {
  const { data } = await api.get('/generate/')
  return data
}

// ── 故障树编辑 ──────────────────────────────────────

export const saveFaultTree = async (treeId, data) => {
  const { data: result } = await api.put(`/edit/${treeId}`, data)
  return result
}

// ── 校验 ────────────────────────────────────────────

export const validateFaultTree = async (faultTree) => {
  const { data } = await api.post('/validate/', faultTree)
  return data
}

// ── 导出 ────────────────────────────────────────────

export const exportWord = async (faultTree) => {
  const { data } = await api.post('/export/word', faultTree, {
    responseType: 'blob',
  })
  return data
}

export const exportPDF = async (faultTree, mcs) => {
  const { data } = await api.post('/export/pdf', {
    fault_tree: faultTree,
    mcs: mcs,
  }, {
    responseType: 'blob',
  })
  return data
}

// ── LLM Provider 管理 ─────────────────────────────────
export const getProviders = async () => {
  const { data } = await api.get('/llm/providers')
  return data
}

// ── 模板管理 ────────────────────────────────────────

export const listTemplates = async () => {
  const { data } = await api.get('/template/list')
  return data
}

export const getTemplate = async (templateId) => {
  const { data } = await api.get(`/template/${templateId}`)
  return data
}

export const getTemplateTopEvents = async (templateId) => {
  const { data } = await api.get(`/template/${templateId}/top-events`)
  return data
}

export const getTemplateBasicEvents = async (templateId) => {
  const { data } = await api.get(`/template/${templateId}/basic-events`)
  return data
}

// 将所有函数绑定到 api 对象上，方便直接通过 api 调用
api.uploadDocument = uploadDocument
api.listDocuments = listDocuments
api.deleteDocument = deleteDocument
api.searchKnowledge = searchKnowledge
api.getKnowledgeStats = getKnowledgeStats
api.generateFaultTree = generateFaultTree
api.getFaultTree = getFaultTree
api.listFaultTrees = listFaultTrees
api.saveFaultTree = saveFaultTree
api.validateFaultTree = validateFaultTree
api.exportWord = exportWord
api.exportPDF = exportPDF
api.getProviders = getProviders
api.listTemplates = listTemplates
api.getTemplate = getTemplate
api.getTemplateTopEvents = getTemplateTopEvents
api.getTemplateBasicEvents = getTemplateBasicEvents

export default api
