package ai.faulttree.app.rtc

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * 实时 AI 通话 WebSocket 客户端
 *
 * 协议与前端 services/realtime.js 保持一致：
 * - 连接：WS /api/realtime/ws/{session_id}
 * - 心跳：{"type":"ping","payload":{}}
 * - 上传帧：{"type":"frame","payload":{"image_base64":"...","timestamp":ms}}
 * - 提问：{"type":"ask","payload":{"text":"...","mode":"voice|text"}}
 * - 服务端推送：status / result / error / pong
 */
class RealtimeWebSocket(
  private val baseUrl: String,
  private val sessionId: String
) {

  companion object {
    private const val TAG = "RealtimeWebSocket"
    private const val HEARTBEAT_INTERVAL_MS = 15000L
    private const val RECONNECT_INTERVAL_MS = 3000L
  }

  interface Listener {
    fun onConnected() {}
    fun onDisconnected(code: Int, reason: String) {}
    fun onStatus(aiStatus: String, pendingQuestion: String?) {}
    fun onResult(
      content: String,
      speak: Boolean,
      overallStatus: String,
      detectionCount: Int,
      anomalyCount: Int,
      sessionId: String,
      source: String
    ) {}
    fun onError(message: String) {}
  }

  private val client = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    .pingInterval(HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS)
    .build()

  private val gson = Gson()
  private var webSocket: WebSocket? = null
  private var listener: Listener? = null
  private var closed = false
  private var reconnectRunnable: Runnable? = null
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())

  fun setListener(listener: Listener) {
    this.listener = listener
  }

  fun connect() {
    if (closed) return
    val wsUrl = baseUrl
      .replace("^https".toRegex(), "wss")
      .replace("^http".toRegex(), "ws")
      .trimEnd('/') + "/api/realtime/ws/$sessionId"
    Log.d(TAG, "Connecting to $wsUrl")

    val request = Request.Builder().url(wsUrl).build()
    webSocket = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.d(TAG, "WebSocket opened")
        handler.post { listener?.onConnected() }
        startHeartbeat()
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handleMessage(text)
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        Log.d(TAG, "WebSocket closing: $code $reason")
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.d(TAG, "WebSocket closed: $code $reason")
        handler.post { listener?.onDisconnected(code, reason) }
        scheduleReconnect()
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.e(TAG, "WebSocket failure: ${t.message}", t)
        handler.post { listener?.onError("实时通道异常: ${t.message}") }
        scheduleReconnect()
      }
    })
  }

  fun close() {
    closed = true
    cancelReconnect()
    cancelHeartbeat()
    webSocket?.close(1000, "user close")
    webSocket = null
  }

  fun sendFrame(imageBase64: String, timestamp: Long = System.currentTimeMillis()) {
    val payload = JsonObject().apply {
      addProperty("image_base64", imageBase64)
      addProperty("timestamp", timestamp)
      addProperty("source", "android")
    }
    send("frame", payload)
  }

  fun ask(text: String, mode: String = "text") {
    val payload = JsonObject().apply {
      addProperty("text", text)
      addProperty("mode", if (mode == "voice") "voice" else "text")
    }
    send("ask", payload)
  }

  private fun send(type: String, payload: JsonObject) {
    val message = JsonObject().apply {
      addProperty("type", type)
      add("payload", payload)
    }
    val ok = webSocket?.send(message.toString()) ?: false
    if (!ok) {
      Log.w(TAG, "Send failed, websocket not ready")
    }
  }

  private fun handleMessage(text: String) {
    try {
      val obj = gson.fromJson(text, JsonObject::class.java)
      val type = obj.get("type")?.asString ?: "message"
      val payload = obj.getAsJsonObject("payload") ?: JsonObject()
      handler.post { dispatchMessage(type, payload) }
    } catch (e: Exception) {
      Log.w(TAG, "Parse message failed: $text", e)
    }
  }

  private fun dispatchMessage(type: String, payload: JsonObject) {
    when (type) {
      "pong" -> Unit
      "status" -> {
        val aiStatus = payload.get("ai_status")?.takeIf { !it.isJsonNull }?.asString ?: "idle"
        val pendingQuestion = payload.get("pending_question")?.takeIf { !it.isJsonNull }?.asString
        listener?.onStatus(aiStatus, pendingQuestion)
      }
      "result" -> {
        val content = payload.get("content")?.takeIf { !it.isJsonNull }?.asString ?: ""
        val speak = payload.get("speak")?.takeIf { !it.isJsonNull }?.asBoolean != false
        val overallStatus = payload.get("overall_status")?.takeIf { !it.isJsonNull }?.asString ?: "normal"
        val detectionCount = payload.get("detection_count")?.takeIf { !it.isJsonNull }?.asInt ?: 0
        val anomalyCount = payload.get("anomaly_count")?.takeIf { !it.isJsonNull }?.asInt ?: 0
        val sessionId = payload.get("session_id")?.takeIf { !it.isJsonNull }?.asString ?: this.sessionId
        val source = payload.get("source")?.takeIf { !it.isJsonNull }?.asString ?: ""
        listener?.onResult(content, speak, overallStatus, detectionCount, anomalyCount, sessionId, source)
      }
      "error" -> {
        val msg = payload.get("content")?.takeIf { !it.isJsonNull }?.asString ?: "实时通道异常"
        listener?.onError(msg)
      }
    }
  }

  private fun startHeartbeat() {
    cancelHeartbeat()
    heartbeatRunnable = object : Runnable {
      override fun run() {
        send("ping", JsonObject())
        handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
      }
    }
    handler.postDelayed(heartbeatRunnable as Runnable, HEARTBEAT_INTERVAL_MS)
  }

  private fun cancelHeartbeat() {
    heartbeatRunnable?.let { handler.removeCallbacks(it) }
    heartbeatRunnable = null
  }

  private var heartbeatRunnable: Runnable? = null

  private fun scheduleReconnect() {
    if (closed) return
    cancelReconnect()
    reconnectRunnable = Runnable {
      Log.d(TAG, "Reconnecting...")
      connect()
    }
    handler.postDelayed(reconnectRunnable as Runnable, RECONNECT_INTERVAL_MS)
  }

  private fun cancelReconnect() {
    reconnectRunnable?.let { handler.removeCallbacks(it) }
    reconnectRunnable = null
  }
}
