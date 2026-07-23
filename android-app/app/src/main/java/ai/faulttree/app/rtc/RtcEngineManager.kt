package ai.faulttree.app.rtc

import android.content.Context
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import ai.faulttree.app.FileLogger
import com.ss.bytertc.engine.RTCEngine
import com.ss.bytertc.engine.RTCRoom
import com.ss.bytertc.engine.RTCRoomConfig
import com.ss.bytertc.engine.UserInfo
import com.ss.bytertc.engine.VideoCanvas
import com.ss.bytertc.engine.data.CameraId
import com.ss.bytertc.engine.data.EngineConfig
import com.ss.bytertc.engine.data.StreamInfo
import com.ss.bytertc.engine.handler.IRTCEngineEventHandler
import com.ss.bytertc.engine.handler.IRTCRoomEventHandler
import com.ss.bytertc.engine.type.ChannelProfile

class RtcEngineManager(context: Context, appId: String) {

  private val tag = "RtcEngineManager"
  private val appContext = context.applicationContext
  private var engine: RTCEngine? = null
  private var room: RTCRoom? = null
  private var currentRoomId: String? = null
  private var currentUserId: String? = null

  var onUserJoined: ((String) -> Unit)? = null
  var onUserLeft: ((String) -> Unit)? = null
  var onError: ((Int, String) -> Unit)? = null
  var onRoomStateChanged: ((String, String, Int, String) -> Unit)? = null

  private var localView: SurfaceView? = null
  private var remoteView: SurfaceView? = null
  private var boundRemoteUid: String? = null
  private var isFrontCamera = true  // 引擎默认一般为前置，startWithBackCamera 会切换为后置
  private var pendingLocalBind = false

  init {
    try {
      val engineConfig = EngineConfig().apply {
        this.context = appContext
        this.appID = appId
      }
      FileLogger.log(appContext, tag, "Creating RTC engine with appId=$appId")
      engine = RTCEngine.createRTCEngine(engineConfig, object : IRTCEngineEventHandler() {
        override fun onError(errorCode: Int) {
          Log.e(tag, "Engine error: $errorCode")
          FileLogger.log(appContext, tag, "RTC engine error: $errorCode")
          onError?.invoke(errorCode, "engine error $errorCode")
        }
      })
      FileLogger.log(appContext, tag, "RTC engine created successfully, isNull=${engine == null}")
    } catch (e: Exception) {
      Log.e(tag, "Create engine failed: ${e.message}", e)
      FileLogger.log(appContext, tag, "Create RTC engine failed", e)
      onError?.invoke(-1, e.message ?: "create engine failed")
    }
  }

  fun joinRoom(
    token: String,
    roomId: String,
    userId: String,
    localView: SurfaceView? = null,
    remoteView: SurfaceView? = null
  ) {
    val rtcEngine = engine ?: run {
      onError?.invoke(-1, "RTC engine not initialized")
      return
    }

    currentRoomId = roomId
    currentUserId = userId
    this.localView = localView
    this.remoteView = remoteView

    // 开启音视频采集
    FileLogger.log(appContext, tag, "Starting audio/video capture")
    rtcEngine.startAudioCapture()
    rtcEngine.startVideoCapture()
    // 默认使用后置摄像头
    startWithBackCamera()
    Log.d(tag, "Audio/video capture started")

    // 本地预览：等 Surface 创建好再绑定
    localView?.let { bindLocalView(it) }

    // 创建并进入房间
    val rtcRoom = rtcEngine.createRTCRoom(roomId)
    room = rtcRoom

    val userInfo = UserInfo(userId, "")
    val roomConfig = RTCRoomConfig(
      ChannelProfile.CHANNEL_PROFILE_COMMUNICATION,
      null,
      true,
      true,
      true,
      true
    )

    rtcRoom.setRTCRoomEventHandler(object : IRTCRoomEventHandler() {
      override fun onRoomStateChanged(roomId: String, uid: String, state: Int, extraInfo: String) {
        Log.d(tag, "onRoomStateChanged roomId=$roomId uid=$uid state=$state extraInfo=$extraInfo")
        onRoomStateChanged?.invoke(roomId, uid, state, extraInfo)
      }

      override fun onUserJoined(userInfo: UserInfo) {
        val uid = userInfo.uid
        Log.d(tag, "onUserJoined uid=$uid")
        onUserJoined?.invoke(uid)
      }

      override fun onUserLeave(uid: String, reason: Int) {
        Log.d(tag, "onUserLeave uid=$uid reason=$reason")
        onUserLeft?.invoke(uid)
      }

      override fun onUserPublishStreamVideo(uid: String, streamInfo: StreamInfo, isPublish: Boolean) {
        Log.d(tag, "onUserPublishStreamVideo uid=$uid isPublish=$isPublish")
        if (isPublish) {
          rtcRoom.subscribeStreamVideo(uid, true)
          rtcRoom.subscribeStreamAudio(uid, true)
          bindRemoteView(uid)
        }
      }

      override fun onUserPublishStreamAudio(uid: String, streamInfo: StreamInfo, isPublish: Boolean) {
        Log.d(tag, "onUserPublishStreamAudio uid=$uid isPublish=$isPublish")
        if (isPublish) {
          rtcRoom.subscribeStreamAudio(uid, true)
        }
      }
    })

    rtcRoom.joinRoom(token, userInfo, true, roomConfig)
  }

  private fun bindLocalView(view: SurfaceView) {
    val rtcEngine = engine ?: run {
      FileLogger.log(appContext, tag, "bindLocalView skipped, engine is null")
      return
    }

    FileLogger.log(appContext, tag, "bindLocalView, surface valid=${view.holder.surface?.isValid == true}")

    val bind = {
      try {
        val canvas = VideoCanvas().apply {
          renderView = view
          renderMode = VideoCanvas.RENDER_MODE_HIDDEN
        }
        rtcEngine.setLocalVideoCanvas(canvas)
        Log.d(tag, "Local video canvas bound")
        FileLogger.log(appContext, tag, "Local video canvas bound")
      } catch (e: Exception) {
        Log.e(tag, "Bind local view failed: ${e.message}")
        FileLogger.log(appContext, tag, "Bind local view failed", e)
      }
    }

    if (view.holder.surface?.isValid == true) {
      bind()
    } else {
      pendingLocalBind = true
      view.holder.addCallback(object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) {
          Log.d(tag, "Local surface created")
          if (pendingLocalBind) {
            bind()
            pendingLocalBind = false
          }
        }
        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
        override fun surfaceDestroyed(holder: SurfaceHolder) {
          pendingLocalBind = true
        }
      })
    }
  }

  private fun bindRemoteView(remoteUserId: String) {
    val view = remoteView ?: return
    val rtcEngine = engine ?: return
    if (boundRemoteUid == remoteUserId) return
    boundRemoteUid = remoteUserId

    val bind = {
      try {
        val canvas = VideoCanvas().apply {
          renderView = view
          renderMode = VideoCanvas.RENDER_MODE_HIDDEN
        }
        rtcEngine.setRemoteVideoCanvas(remoteUserId, canvas)
        Log.d(tag, "Remote video canvas bound uid=$remoteUserId")
      } catch (e: Exception) {
        Log.e(tag, "Bind remote view failed: ${e.message}")
      }
    }

    if (view.holder.surface?.isValid == true) {
      bind()
    } else {
      view.holder.addCallback(object : SurfaceHolder.Callback {
        override fun surfaceCreated(holder: SurfaceHolder) {
          Log.d(tag, "Remote surface created")
          bind()
        }
        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
        override fun surfaceDestroyed(holder: SurfaceHolder) {}
      })
    }
  }

  fun startWithBackCamera() {
    FileLogger.log(appContext, tag, "Setting default camera to back")
    isFrontCamera = false
    engine?.switchCamera(CameraId.CAMERA_ID_BACK)
  }

  fun switchCamera() {
    isFrontCamera = !isFrontCamera
    val target = if (isFrontCamera) CameraId.CAMERA_ID_FRONT else CameraId.CAMERA_ID_BACK
    FileLogger.log(appContext, tag, "Switching camera to ${if (isFrontCamera) "front" else "back"}")
    engine?.switchCamera(target)
  }

  fun leaveRoom() {
    try {
      room?.leaveRoom()
      room?.destroy()
      room = null
    } catch (e: Exception) {
      Log.e(tag, "Leave room error: ${e.message}", e)
    }
    try {
      engine?.stopAudioCapture()
      engine?.stopVideoCapture()
    } catch (e: Exception) {
      Log.e(tag, "Stop capture error: ${e.message}", e)
    }
    remoteView = null
    localView = null
    boundRemoteUid = null
    pendingLocalBind = false
  }

  fun destroy() {
    leaveRoom()
    try {
      RTCEngine.destroyRTCEngine()
      engine = null
    } catch (e: Exception) {
      Log.e(tag, "Destroy engine error: ${e.message}", e)
    }
  }
}
