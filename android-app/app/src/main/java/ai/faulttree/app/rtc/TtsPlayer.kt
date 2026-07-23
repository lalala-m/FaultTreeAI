package ai.faulttree.app.rtc

import ai.faulttree.app.FileLogger
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * AI 语音播报器。
 * 从后端 /api/realtime/tts 获取音频文件（WAV/MP3），使用 MediaPlayer 播放。
 */
class TtsPlayer(private val context: Context) {

  companion object {
    private const val TAG = "TtsPlayer"
  }

  private var mediaPlayer: MediaPlayer? = null
  private var onComplete: (() -> Unit)? = null

  fun play(audioBytes: ByteArray, mimeType: String, onComplete: (() -> Unit)? = null) {
    stop()
    this.onComplete = onComplete
    try {
      val extension = when {
        mimeType.contains("mpeg") || mimeType.contains("mp3") -> "mp3"
        else -> "wav"
      }
      val tempFile = File.createTempFile("tts_${System.currentTimeMillis()}_", ".$extension", context.cacheDir)
      FileOutputStream(tempFile).use { it.write(audioBytes) }
      tempFile.deleteOnExit()

      FileLogger.log(context, TAG, "TTS temp file=${tempFile.absolutePath}, size=${audioBytes.size}, mimeType=$mimeType")

      val player = MediaPlayer().apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
          setAudioAttributes(
            AudioAttributes.Builder()
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .build()
          )
        } else {
          @Suppress("DEPRECATION")
          setAudioStreamType(AudioManager.STREAM_MUSIC)
        }
        setDataSource(tempFile.absolutePath)
        setVolume(1.0f, 1.0f)
        setOnPreparedListener {
          FileLogger.log(context, TAG, "TTS prepared, starting playback")
          start()
        }
        setOnCompletionListener {
          FileLogger.log(context, TAG, "TTS playback completed")
          onComplete?.invoke()
        }
        setOnErrorListener { _, what, extra ->
          FileLogger.log(context, TAG, "TTS play error: what=$what, extra=$extra, file=${tempFile.absolutePath}, size=${audioBytes.size}")
          true
        }
        prepareAsync()
      }
      mediaPlayer = player
      FileLogger.log(context, TAG, "TTS MediaPlayer created, preparing async")
    } catch (e: Exception) {
      FileLogger.log(context, TAG, "TTS prepare failed: ${e.message}", e)
    }
  }

  fun stop() {
    try {
      mediaPlayer?.stop()
      mediaPlayer?.release()
    } catch (e: Exception) {
      FileLogger.log(context, TAG, "stop TTS failed", e)
    }
    mediaPlayer = null
    onComplete = null
  }
}
