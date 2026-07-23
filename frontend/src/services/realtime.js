/**
 * 实时 AI 通话 WebSocket 服务封装
 *
 * 用于 RTC 视频通话过程中，前端与后端实时传输视频帧、接收 AI 分析结果。
 */

const getApiBaseUrl = () => {
  const envUrl = import.meta.env.VITE_API_URL || '';
  if (!envUrl) return '';
  try {
    const env = new URL(envUrl, window.location.href);
    if (env.protocol !== window.location.protocol) return '';
    return envUrl;
  } catch {
    return envUrl;
  }
};

const WS_BASE_URL = () => {
  const apiUrl = getApiBaseUrl();
  if (!apiUrl) {
    // 默认使用当前页面 host，协议升级为 ws/wss
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  // 将 http/https 替换为 ws/wss
  return apiUrl.replace(/^http/, 'ws');
};

export class RealtimeService {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.ws = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.closed = false;
    this.listeners = new Map();
    this.options = {
      autoReconnect: true,
      reconnectInterval: 3000,
      heartbeatInterval: 15000,
      ...options,
    };
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }
    this.closed = false;
    const url = `${WS_BASE_URL()}/api/realtime/ws/${this.sessionId}`;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this._emit('error', { message: String(e?.message || '创建 WebSocket 失败') });
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._emit('open', {});
      this._startHeartbeat();
      this._stopReconnectTimer();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._emit(data.type || 'message', data.payload || {});
        this._emit('message', data);
      } catch {
        this._emit('message', { raw: event.data });
      }
    };

    this.ws.onerror = (event) => {
      this._emit('error', { message: 'WebSocket 连接异常', event });
    };

    this.ws.onclose = (event) => {
      this._stopHeartbeat();
      this._emit('close', { code: event.code, reason: event.reason });
      if (!this.closed && this.options.autoReconnect) {
        this._scheduleReconnect();
      }
    };
  }

  sendFrame(imageBase64, timestamp = Date.now()) {
    this._send({
      type: 'frame',
      payload: {
        image_base64: imageBase64,
        timestamp,
        source: 'local',
      },
    });
  }

  ask(text, mode = 'text') {
    this._send({
      type: 'ask',
      payload: {
        text: String(text || '').trim(),
        mode: mode === 'voice' ? 'voice' : 'text',
      },
    });
  }

  ping(ts = Date.now()) {
    this._send({ type: 'ping', payload: { ts } });
  }

  status() {
    this._send({ type: 'status', payload: {} });
  }

  close() {
    this.closed = true;
    this._stopReconnectTimer();
    this._stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  on(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  _emit(type, payload) {
    this.listeners.get(type)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[RealtimeService] listener error for ${type}:`, e);
      }
    });
  }

  _send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('[RealtimeService] send failed:', e);
      return false;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.ping();
    }, this.options.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _scheduleReconnect() {
    this._stopReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
    }, this.options.reconnectInterval);
  }

  _stopReconnectTimer() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export function createRealtimeService(sessionId, options) {
  return new RealtimeService(sessionId, options);
}

/**
 * 上传 WAV 音频到后端 ASR 进行语音识别。
 * @param {Blob} audioBlob 16kHz 16bit 单声道 WAV 音频
 * @returns {Promise<string>} 识别到的文本
 */
export async function transcribeAudio(audioBlob) {
  const apiUrl = getApiBaseUrl();
  const url = apiUrl ? `${apiUrl.replace(/\/$/, '')}/api/realtime/transcribe` : `/api/realtime/transcribe`;

  const formData = new FormData();
  formData.append('audio', audioBlob, 'voice.wav');

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    let detail = `ASR 请求失败: ${response.status}`;
    try {
      const err = await response.json();
      detail = err?.detail || err?.error || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  const data = await response.json();
  return String(data?.text || '').trim();
}
