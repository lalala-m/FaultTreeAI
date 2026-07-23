/**
 * 全局上传任务存储（内存）
 *
 * 设计原则：
 * - 同一浏览器标签页内切换路由时保留上传任务进度和状态
 * - 刷新页面或重启项目后自动清空，不保留历史任务
 */

import { listDocuments, invalidateCache } from './api.js'

const POLL_INTERVAL_MS = 2000
const MAX_POLL_ATTEMPTS = 300 // 约 10 分钟

class UploadStore {
  constructor() {
    this.tasks = []
    this._snapshot = this.tasks
    this.listeners = new Set()
    this.pollTimer = null
    this.pollAttempts = 0
  }

  subscribe(listener) {
    this.listeners.add(listener)
    listener(this._snapshot)
    return () => this.listeners.delete(listener)
  }

  _notify() {
    // 生成新数组引用，确保 React useSyncExternalStore 能检测到变化
    this._snapshot = this.tasks.slice()
    this.listeners.forEach((fn) => {
      try {
        fn(this._snapshot)
      } catch {
      }
    })
  }

  getTasks() {
    return this.tasks.slice()
  }

  getSnapshot() {
    return this._snapshot
  }

  addTask(file, pipeline = '流水线1', autoExtract = true) {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const task = {
      id,
      filename: file.name || '未知文件',
      pipeline,
      autoExtract,
      file,
      docId: null,
      status: 'pending', // pending / uploading / processing / completed / failed
      progress: 0,
      step: 0,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.tasks = [...this.tasks, task]
    this._notify()
    return task
  }

  updateTask(id, updates) {
    const idx = this.tasks.findIndex((t) => t.id === id)
    if (idx < 0) return null
    const task = { ...this.tasks[idx], ...updates, updatedAt: Date.now() }
    this.tasks = [...this.tasks.slice(0, idx), task, ...this.tasks.slice(idx + 1)]
    this._notify()
    return task
  }

  removeTask(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id)
    this._notify()
  }

  clearCompleted() {
    this.tasks = this.tasks.filter((t) => t.status !== 'completed')
    this._notify()
  }

  async startUpload(id, uploadPromiseFactory) {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return
    this.updateTask(id, { status: 'uploading', progress: 0, step: 1, error: '' })
    this._startPolling()

    try {
      const onProgress = (p) => {
        this.updateTask(id, { progress: p, step: p < 100 ? 1 : 2 })
      }
      const result = await uploadPromiseFactory(task.file, onProgress, task.pipeline, task.autoExtract)
      this.updateTask(id, {
        docId: result?.doc_id || null,
        status: result?.doc_id ? 'processing' : 'failed',
        progress: result?.doc_id ? 60 : 0,
        step: result?.doc_id ? 3 : 0,
        error: result?.doc_id ? '' : '上传未返回文档ID',
      })
      if (result?.doc_id) {
        invalidateCache?.(['documents'])
      }
    } catch (err) {
      this.updateTask(id, {
        status: 'failed',
        progress: 0,
        step: 0,
        error: err?.response?.data?.detail || err?.message || '上传失败',
      })
    }
  }

  _startPolling() {
    if (this.pollTimer) return
    this.pollAttempts = 0
    const tick = async () => {
      const activeTasks = this.tasks.filter(
        (t) => t.status === 'processing' || t.status === 'uploading' || t.status === 'pending'
      )
      if (activeTasks.length === 0 || this.pollAttempts >= MAX_POLL_ATTEMPTS) {
        this._stopPolling()
        return
      }
      this.pollAttempts += 1
      try {
        // 清除 documents 缓存，确保每次轮询都拿到最新状态
        invalidateCache?.(['documents'])
        const docs = await listDocuments()
        const arr = Array.isArray(docs) ? docs : []
        let changed = false
        for (const task of activeTasks) {
          const doc = task.docId
            ? arr.find((d) => String(d?.doc_id || '') === String(task.docId))
            : arr.find((d) => String(d?.filename || '') === String(task.filename) && new Date(d?.upload_time || 0).getTime() > task.createdAt - 10000)
          if (!doc) continue
          const structured = String(doc?.structured_kb || '')
          const summaryStatus = String(doc?.ai_summary_status || '')
          const done = structured && structured !== 'pending' && summaryStatus !== 'pending'
          if (done && task.status !== 'completed') {
            this.updateTask(task.id, {
              docId: doc.doc_id,
              status: 'completed',
              progress: 100,
              step: 4,
              error: '',
            })
            changed = true
          } else if (!done && task.status === 'processing') {
            // 保持 processing，进度稍微增长给用户反馈
            this.updateTask(task.id, { progress: Math.max(task.progress, 70) })
            changed = true
          }
        }
        if (changed) {
          invalidateCache?.(['documents'])
        }
      } catch {
        // 轮询失败继续
      }

      const stillActive = this.tasks.some(
        (t) => t.status === 'processing' || t.status === 'uploading' || t.status === 'pending'
      )
      if (stillActive) {
        this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
      } else {
        this.pollTimer = null
      }
    }
    this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }
}

export const uploadStore = new UploadStore()
