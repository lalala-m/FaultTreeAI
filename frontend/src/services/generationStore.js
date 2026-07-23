/**
 * 全局生成任务存储（内存）
 * 用于在页面切换时保留正在进行的故障树生成任务，
 * 刷新页面或重启项目后自动清空。
 */

class GenerationStore {
  constructor() {
    this.jobs = new Map()
  }

  _makeKey(topEvent, answers) {
    const ans = answers ? JSON.stringify(answers) : ''
    return `${topEvent}::${ans}`
  }

  start(topEvent, answers, promise) {
    const key = this._makeKey(topEvent, answers)
    const job = {
      key,
      topEvent,
      answers,
      status: 'running',
      result: null,
      error: null,
      promise,
      startedAt: Date.now(),
    }
    this.jobs.set(key, job)

    promise.then(
      (result) => {
        job.status = 'completed'
        job.result = result
      },
      (error) => {
        job.status = 'error'
        job.error = error
      }
    )

    return key
  }

  get(topEvent, answers) {
    return this.jobs.get(this._makeKey(topEvent, answers))
  }

  consume(topEvent, answers) {
    const key = this._makeKey(topEvent, answers)
    const job = this.jobs.get(key)
    if (!job) return null
    if (job.status === 'running') return job
    this.jobs.delete(key)
    return job
  }

  cleanup(maxAgeMs = 1000 * 60 * 30) {
    const now = Date.now()
    for (const [key, job] of this.jobs.entries()) {
      if (job.status !== 'running' && now - job.startedAt > maxAgeMs) {
        this.jobs.delete(key)
      }
    }
  }
}

export const generationStore = new GenerationStore()
