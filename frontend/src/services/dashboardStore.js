/**
 * Dashboard 对话状态内存存储
 *
 * 设计原则：
 * - 同一浏览器标签页内切换路由时保留对话记录
 * - 刷新页面或重启项目后自动清空，不保留历史
 */

class DashboardStore {
  constructor() {
    this.messages = []
    this.listeners = new Set()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.messages)
    return () => this.listeners.delete(listener)
  }

  _notify() {
    this.listeners.forEach((fn) => {
      try {
        fn(this.messages)
      } catch {
      }
    })
  }

  setMessages(messages) {
    this.messages = messages
    this._notify()
  }

  getMessages() {
    return this.messages
  }
}

export const dashboardStore = new DashboardStore()
