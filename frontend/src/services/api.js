import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
})

const _TOKEN_KEY = 'faulttreeai_token_v1'

export const getAuthToken = () => {
  try { return localStorage.getItem(_TOKEN_KEY) || '' } catch { return '' }
}

export const setAuthToken = (token) => {
  const t = String(token || '').trim()
  try {
    if (t) localStorage.setItem(_TOKEN_KEY, t)
    else localStorage.removeItem(_TOKEN_KEY)
  } catch {
  }
  if (t) api.defaults.headers.common.Authorization = `Bearer ${t}`
  else delete api.defaults.headers.common.Authorization
}

export const clearAuthToken = () => setAuthToken('')

setAuthToken(getAuthToken())

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status
    if (status === 401) {
      clearAuthToken()
      try { window.dispatchEvent(new CustomEvent('auth-expired')) } catch {
      }
    }
    return Promise.reject(err)
  }
)

api.clearAuthToken = clearAuthToken

const _cachePrefix = 'faulttreeai_api_cache_v1:'
const _memCache = new Map()

const _now = () => Date.now()

const _getCached = (key, ttlMs) => {
  const mem = _memCache.get(key)
  if (mem && _now() - mem.ts < ttlMs) return mem.value
  try {
    const raw = sessionStorage.getItem(_cachePrefix + key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.ts !== 'number') return undefined
    if (_now() - parsed.ts >= ttlMs) return undefined
    _memCache.set(key, parsed)
    return parsed.value
  } catch {
    return undefined
  }
}

const _setCached = (key, value) => {
  const payload = { ts: _now(), value }
  _memCache.set(key, payload)
  try {
    sessionStorage.setItem(_cachePrefix + key, JSON.stringify(payload))
  } catch {
  }
}

export const invalidateCache = (keys) => {
  const arr = Array.isArray(keys) ? keys : [keys]
  arr.filter(Boolean).forEach((k) => {
    _memCache.delete(k)
    try {
      sessionStorage.removeItem(_cachePrefix + k)
    } catch {
    }
  })
}

const _cached = async (key, ttlMs, fetcher) => {
  const hit = _getCached(key, ttlMs)
  if (hit !== undefined) return hit
  const value = await fetcher()
  _setCached(key, value)
  return value
}

// ── Auth ──────────────────────────────────────────

export const register = async (payload) => {
  const { data } = await api.post('/auth/register', payload)
  if (data?.token) setAuthToken(data.token)
  return data
}

export const login = async (payload) => {
  const { data } = await api.post('/auth/login', payload)
  if (data?.token) setAuthToken(data.token)
  return data
}

export const getMe = async () => {
  const { data } = await api.get('/auth/me')
  return data
}

export const updateMe = async (payload) => {
  const { data } = await api.put('/auth/me', payload)
  return data
}

export const uploadMyAvatar = async (file) => {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post('/auth/me/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } })
  return data
}

// ── 知识库 ──────────────────────────────────────────

export const uploadDocument = async (file, onProgress, pipeline = '流水线1', autoExtract = true) => {
  const form = new FormData()
  form.append('file', file)
  form.append('pipeline', pipeline)
  form.append('auto_extract', String(!!autoExtract))
  const { data } = await api.post('/knowledge/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => onProgress?.(Math.round((e.loaded * 100) / (e.total || 1))),
  })
  invalidateCache(['documents', 'knowledgeStats'])
  return data
}

export const listDocuments = async () => {
  return _cached('documents', 30_000, async () => {
    const { data } = await api.get('/knowledge/list')
    return data
  })
}

export const deleteDocument = async (docId) => {
  const { data } = await api.delete(`/knowledge/${docId}`)
  invalidateCache(['documents', 'knowledgeStats'])
  return data
}

export const updateDocumentPipeline = async (docId, pipeline) => {
  const { data } = await api.put(`/knowledge/${docId}/pipeline`, null, { params: { pipeline } })
  invalidateCache(['documents'])
  return data
}

export const searchKnowledge = async (query, topK = 5) => {
  const { data } = await api.post('/knowledge/search', null, {
    params: { query, top_k: topK }
  })
  return data
}

export const getKnowledgeStats = async () => {
  return _cached('knowledgeStats', 15_000, async () => {
    const { data } = await api.get('/knowledge/stats')
    return data
  })
}

export const getKnowledgeGraph = async (pipeline = '流水线1') => {
  const { data } = await api.get('/knowledge/graph', { params: { pipeline } })
  return data
}

export const listPipelines = async () => {
  return _cached('pipelines', 30_000, async () => {
    const { data } = await api.get('/knowledge/pipelines')
    return Array.isArray(data?.pipelines) ? data.pipelines : []
  })
}

export const createPipeline = async (pipeline) => {
  const { data } = await api.post('/knowledge/pipelines', { pipeline })
  invalidateCache(['pipelines'])
  return data
}

export const rebuildKnowledgeGraph = async (pipeline = '流水线1') => {
  const { data } = await api.post('/knowledge/graph/rebuild', null, { params: { pipeline } })
  invalidateCache(['documents'])
  return data
}

export const listKnowledgeItems = async (params = {}) => {
  const { data } = await api.get('/knowledge/items', { params })
  return data
}

export const createKnowledgeItem = async (payload, params = {}) => {
  const { data } = await api.post('/knowledge/items', payload, { params: params || {} })
  invalidateCache(['knowledgeItems'])
  return data
}

export const updateKnowledgeItem = async (itemId, payload) => {
  const { data } = await api.put(`/knowledge/items/${itemId}`, payload)
  invalidateCache(['knowledgeItems'])
  return data
}

export const deleteKnowledgeItem = async (itemId) => {
  const { data } = await api.delete(`/knowledge/items/${itemId}`)
  invalidateCache(['knowledgeItems'])
  return data
}

export const searchKnowledgeItems = async (payload) => {
  const { data } = await api.post('/knowledge/items/search', payload)
  return data
}

export const feedbackKnowledgeItemWeight = async (payload) => {
  const { data } = await api.post('/knowledge/items/feedback-weight', payload)
  invalidateCache(['knowledgeItems'])
  return data
}

export const setKnowledgeItemExpertWeight = async (itemId, expertWeight) => {
  const { data } = await api.post('/knowledge/items/expert-weight', { item_id: itemId, expert_weight: expertWeight })
  invalidateCache(['knowledgeItems'])
  return data
}

export const listKnowledgeItemSuggestions = async (pipeline, limit = 8) => {
  const { data } = await api.get('/knowledge/items/suggestions', { params: { pipeline, limit } })
  return Array.isArray(data?.suggestions) ? data.suggestions : []
}

export const listManualEntries = async (pipeline = '流水线1', params = {}) => {
  const { data } = await api.get('/knowledge/manual/entries', { params: { pipeline, ...(params || {}) } })
  return data
}

export const exportManualWord = async (pipeline = '流水线1', params = {}) => {
  return api.get('/knowledge/manual/export/word', { params: { pipeline, ...(params || {}) }, responseType: 'blob' })
}

export const reextractKnowledgeItems = async (pipeline = '流水线1', mode = 'replace', docIds = null) => {
  const payload = { pipeline, mode }
  if (Array.isArray(docIds) && docIds.length) payload.doc_ids = docIds
  const { data } = await api.post('/knowledge/items/reextract', payload)
  invalidateCache(['knowledgeItems', 'documents', 'knowledgeStats'])
  return data
}

export const cleanupKnowledgeItems = async (pipeline = '流水线1', opts = {}) => {
  const payload = { pipeline, ...(opts || {}) }
  const { data } = await api.post('/knowledge/items/cleanup', payload)
  invalidateCache(['knowledgeItems', 'documents', 'knowledgeStats'])
  return data
}

// ── 故障树生成 ──────────────────────────────────────

export const generateFaultTree = async (params) => {
  const { data } = await api.post('/generate/', params)
  invalidateCache(['faultTrees'])
  return data
}

export const getFaultTree = async (treeId) => {
  const { data } = await api.get(`/generate/${treeId}`)
  return data
}

export const getSessionByTree = async (treeId) => {
  const { data } = await api.get(`/generate/${treeId}/session`)
  return data
}
export const listFaultTrees = async () => {
  return _cached('faultTrees', 15_000, async () => {
    const { data } = await api.get('/generate/')
    return data
  })
}

// ── 故障树编辑 ──────────────────────────────────────

export const saveFaultTree = async (treeId, data) => {
  const { data: result } = await api.put(`/edit/${treeId}`, data)
  invalidateCache(['faultTrees'])
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
  return _cached('providers', 60_000, async () => {
    const { data } = await api.get('/llm/providers')
    return data
  })
}

// ── 模板管理 ────────────────────────────────────────

export const listTemplates = async () => {
  return _cached('templates', 300_000, async () => {
    const { data } = await api.get('/template/list')
    return data
  })
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

export const prefetchBootstrap = async (opts = {}) => {
  const role = String(opts?.role || '').trim()
  const isExpert = role === 'expert'
  try {
    const tasks = [
      listFaultTrees(),
      listTemplates(),
      getProviders(),
    ]
    if (isExpert) {
      tasks.push(getKnowledgeStats(), listDocuments())
    }
    await Promise.all(tasks)
  } catch {
  }
}

// 将所有函数绑定到 api 对象上，方便直接通过 api 调用
api.uploadDocument = uploadDocument
api.listDocuments = listDocuments
api.deleteDocument = deleteDocument
api.updateDocumentPipeline = updateDocumentPipeline
api.searchKnowledge = searchKnowledge
api.getKnowledgeStats = getKnowledgeStats
api.getKnowledgeGraph = getKnowledgeGraph
api.listPipelines = listPipelines
api.createPipeline = createPipeline
api.rebuildKnowledgeGraph = rebuildKnowledgeGraph
api.listKnowledgeItems = listKnowledgeItems
api.createKnowledgeItem = createKnowledgeItem
api.updateKnowledgeItem = updateKnowledgeItem
api.deleteKnowledgeItem = deleteKnowledgeItem
api.searchKnowledgeItems = searchKnowledgeItems
api.feedbackKnowledgeItemWeight = feedbackKnowledgeItemWeight
api.setKnowledgeItemExpertWeight = setKnowledgeItemExpertWeight
api.listKnowledgeItemSuggestions = listKnowledgeItemSuggestions
api.listManualEntries = listManualEntries
api.exportManualWord = exportManualWord
api.reextractKnowledgeItems = reextractKnowledgeItems
api.cleanupKnowledgeItems = cleanupKnowledgeItems
api.generateFaultTree = generateFaultTree
api.getFaultTree = getFaultTree
api.getSessionByTree = getSessionByTree
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
api.prefetchBootstrap = prefetchBootstrap
api.invalidateCache = invalidateCache
api.register = register
api.login = login
api.getMe = getMe
api.updateMe = updateMe
api.uploadMyAvatar = uploadMyAvatar

export default api
