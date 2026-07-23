package ai.faulttree.app.rtc

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import ai.faulttree.app.FileLogger
import ai.faulttree.app.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class RtcRoomActivity : AppCompatActivity() {

  companion object {
    private const val EXTRA_BASE_URL = "base_url"

    fun start(context: Context, baseUrl: String) {
      val intent = Intent(context, RtcRoomActivity::class.java)
      intent.putExtra(EXTRA_BASE_URL, baseUrl)
      context.startActivity(intent)
    }
  }

  private val tag = "RtcRoomActivity"
  private lateinit var localView: android.view.SurfaceView
  private lateinit var remoteView: android.view.SurfaceView
  private lateinit var statusText: TextView
  private lateinit var aiStatusText: TextView
  private lateinit var hangupButton: ImageButton
  private lateinit var voiceButton: ImageButton
  private lateinit var cameraButton: ImageButton

  private var rtcManager: RtcEngineManager? = null
  private var baseUrl: String = ""
  private var sessionId: String = ""
  private var realtimeSocket: RealtimeWebSocket? = null
  private var audioRecorder: AudioRecorder? = null
  private var ttsPlayer: TtsPlayer? = null
  private var voiceFile: File? = null

  private val permissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { results ->
    val allGranted = results.entries.all { it.value }
    if (allGranted) {
      startCall()
    } else {
      toast("需要摄像头和麦克风权限")
      finish()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_rtc_room)
    FileLogger.log(this, tag, "RtcRoomActivity onCreate")

    baseUrl = intent.getStringExtra(EXTRA_BASE_URL) ?: ""
    FileLogger.log(this, tag, "baseUrl=$baseUrl")
    if (baseUrl.isEmpty()) {
      toast("服务器地址为空")
      finish()
      return
    }

    bindViews()
    setupControls()

    audioRecorder = AudioRecorder(this)
    ttsPlayer = TtsPlayer(this)

    checkPermissions()
  }

  private fun bindViews() {
    localView = findViewById(R.id.local_view)
    remoteView = findViewById(R.id.remote_view)
    // 远端小窗浮在本地摄像头画面上方
    remoteView.setZOrderMediaOverlay(true)
    statusText = findViewById(R.id.status_text)
    aiStatusText = findViewById(R.id.ai_status_text)
    hangupButton = findViewById(R.id.btn_hangup)
    voiceButton = findViewById(R.id.btn_voice)
    cameraButton = findViewById(R.id.btn_camera)
  }

  private fun setupControls() {
    hangupButton.setOnClickListener { finish() }

    cameraButton.setOnClickListener {
      FileLogger.log(this, tag, "Camera button clicked: switch camera")
      rtcManager?.switchCamera()
    }
    cameraButton.setOnLongClickListener {
      FileLogger.log(this, tag, "Camera button long clicked: capture frame")
      captureAndAnalyzeFrame()
      true
    }

    voiceButton.setOnTouchListener { _, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          startVoiceRecording()
          true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          stopVoiceRecordingAndSend()
          true
        }
        else -> false
      }
    }
  }

  private fun checkPermissions() {
    val permissions = arrayOf(
      Manifest.permission.CAMERA,
      Manifest.permission.RECORD_AUDIO,
      Manifest.permission.MODIFY_AUDIO_SETTINGS
    )
    val missing = permissions.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isEmpty()) {
      startCall()
    } else {
      permissionLauncher.launch(missing.toTypedArray())
    }
  }

  private fun startCall() {
    lifecycleScope.launch {
      updateStatus("正在连接 AI...")
      try {
        val session = withContext(Dispatchers.IO) {
          ApiClient.startRtcSession(baseUrl)
        }
        sessionId = session.session_id
        updateStatus("AI 已接通: ${session.ai_display_name}")

        connectRealtimeSocket(session)

        rtcManager = RtcEngineManager(this@RtcRoomActivity, session.app_id).apply {
          onRoomStateChanged = { roomId, uid, state, extraInfo ->
            Log.d(tag, "state=$state roomId=$roomId")
            if (state == 0) {
              updateStatus("已进房")
            } else {
              updateStatus("房间状态: $state, $extraInfo")
            }
          }
          onUserJoined = { uid ->
            updateStatus("用户加入: $uid")
          }
          onUserLeft = { uid ->
            updateStatus("用户离开: $uid")
          }
          onError = { code, msg ->
            updateStatus("错误 $code: $msg")
          }
        }

        rtcManager?.joinRoom(
          token = session.token,
          roomId = session.room_id,
          userId = session.user_id,
          localView = localView,
          remoteView = remoteView
        )
      } catch (e: Exception) {
        Log.e(tag, "Start call failed: ${e.message}", e)
        updateStatus("连接失败: ${e.message}")
        toast("连接失败: ${e.message}")
      }
    }
  }

  private fun connectRealtimeSocket(session: ApiClient.SessionResponse) {
    FileLogger.log(this, tag, "connectRealtimeSocket sessionId=${session.session_id}")
    val socket = RealtimeWebSocket(baseUrl, session.session_id)
    socket.setListener(object : RealtimeWebSocket.Listener {
      override fun onConnected() {
        Log.d(tag, "Realtime socket connected")
        FileLogger.log(this@RtcRoomActivity, tag, "Realtime socket connected")
      }

      override fun onStatus(aiStatus: String, pendingQuestion: String?) {
        FileLogger.log(this@RtcRoomActivity, tag, "onStatus aiStatus=$aiStatus pendingQuestion=$pendingQuestion")
        runOnUiThread { updateAiStatus(aiStatus) }
      }

      override fun onResult(
        content: String,
        speak: Boolean,
        overallStatus: String,
        detectionCount: Int,
        anomalyCount: Int,
        sessionId: String,
        source: String
      ) {
        FileLogger.log(this@RtcRoomActivity, tag, "onResult source=$source speak=$speak content=${content.take(100)}")
        runOnUiThread {
          updateAiStatus("ready")
          if (speak) {
            playTts(content)
          }
        }
      }

      override fun onError(message: String) {
        FileLogger.log(this@RtcRoomActivity, tag, "onError message=$message")
        runOnUiThread {
          updateAiStatus("error")
        }
      }

      override fun onDisconnected(code: Int, reason: String) {
        Log.d(tag, "Realtime socket disconnected: $code $reason")
        FileLogger.log(this@RtcRoomActivity, tag, "Realtime socket disconnected code=$code reason=$reason")
      }
    })
    socket.connect()
    realtimeSocket = socket
  }

  private fun captureAndAnalyzeFrame() {
    updateAiStatus("analyzing")
    FileLogger.log(this, tag, "captureAndAnalyzeFrame started")
    FrameCapture.capture(localView, object : FrameCapture.Callback {
      override fun onSuccess(dataUrl: String) {
        FileLogger.log(this@RtcRoomActivity, tag, "Frame captured, size=${dataUrl.length}")
        realtimeSocket?.sendFrame(dataUrl)
      }

      override fun onError(message: String) {
        FileLogger.log(this@RtcRoomActivity, tag, "Frame capture error: $message")
        runOnUiThread {
          toast(message)
          updateAiStatus("error")
        }
      }
    })
  }

  private fun startVoiceRecording() {
    if (audioRecorder?.hasPermission() != true) {
      toast("没有麦克风权限")
      FileLogger.log(this, tag, "startVoiceRecording: no permission")
      return
    }
    voiceFile = File(cacheDir, "voice_${System.currentTimeMillis()}.wav")
    FileLogger.log(this, tag, "startVoiceRecording file=${voiceFile?.absolutePath}")
    try {
      audioRecorder?.start(voiceFile!!)
      updateAiStatus("listening")
    } catch (e: Exception) {
      Log.e(tag, "Start recording failed: ${e.message}", e)
      FileLogger.log(this, tag, "Start recording failed", e)
      toast("录音启动失败: ${e.message}")
    }
  }

  private fun stopVoiceRecordingAndSend() {
    audioRecorder?.stop()
    val file = voiceFile ?: return
    FileLogger.log(this, tag, "stopVoiceRecording, file=${file.absolutePath}, size=${file.length()}")
    lifecycleScope.launch {
      try {
        updateAiStatus("analyzing")
        val text = withContext(Dispatchers.IO) {
          ApiClient.transcribeAudio(baseUrl, file)
        }
        FileLogger.log(this@RtcRoomActivity, tag, "ASR result text=$text")
        file.delete()
        if (text.isNotEmpty()) {
          realtimeSocket?.ask(text, "voice")
          FileLogger.log(this@RtcRoomActivity, tag, "Sent ask via websocket, text=$text")
          // 语音输入后自动截取当前画面，与问题一起分析
          captureAndAnalyzeFrame()
        } else {
          toast("未能识别到语音")
          updateAiStatus("ready")
        }
      } catch (e: Exception) {
        file.delete()
        Log.e(tag, "ASR failed: ${e.message}", e)
        FileLogger.log(this@RtcRoomActivity, tag, "ASR failed", e)
        toast("语音识别失败: ${e.message}")
        updateAiStatus("error")
      }
    }
  }

  private fun playTts(text: String) {
    lifecycleScope.launch {
      try {
        FileLogger.log(this@RtcRoomActivity, tag, "TTS request text=$text")
        val (audioBytes, mimeType) = withContext(Dispatchers.IO) {
          ApiClient.synthesizeText(baseUrl, text)
        }
        FileLogger.log(this@RtcRoomActivity, tag, "TTS response bytes=${audioBytes.size}, mimeType=$mimeType")
        ttsPlayer?.play(audioBytes, mimeType)
      } catch (e: Exception) {
        Log.e(tag, "TTS failed: ${e.message}", e)
        FileLogger.log(this@RtcRoomActivity, tag, "TTS failed", e)
      }
    }
  }

  private fun updateStatus(text: String) {
    runOnUiThread { statusText.text = text }
  }

  private fun updateAiStatus(status: String) {
    runOnUiThread {
      aiStatusText.text = when (status) {
        "observing" -> "AI 观察中"
        "analyzing" -> "AI 分析中"
        "speaking" -> "AI 播报中"
        "ready" -> "AI 就绪"
        "listening" -> "正在聆听"
        "error" -> "AI 异常"
        else -> ""
      }
      aiStatusText.visibility = if (aiStatusText.text.isEmpty()) View.GONE else View.VISIBLE
    }
  }

  private fun toast(msg: String) {
    Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
  }

  override fun onDestroy() {
    super.onDestroy()
    if (sessionId.isNotEmpty()) {
      lifecycleScope.launch(Dispatchers.IO) {
        try {
          ApiClient.endRtcSession(baseUrl, sessionId)
        } catch (e: Exception) {
          Log.e(tag, "End session error: ${e.message}", e)
        }
      }
    }
    realtimeSocket?.close()
    ttsPlayer?.stop()
    audioRecorder?.stop()
    rtcManager?.destroy()
    rtcManager = null
  }
}
