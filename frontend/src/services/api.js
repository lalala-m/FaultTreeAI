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
  const { data } = await api.get('/knowledge/documents')
  return data
}

export const deleteDocument = async (docId) => {
  const { data } = await api.delete(`/knowledge/documents/${docId}`)
  return data
}

export const searchKnowledge = async (query) => {
  const { data } = await api.post('/knowledge/search', { query })
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

export default api
