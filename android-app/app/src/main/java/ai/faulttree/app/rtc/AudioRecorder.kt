package ai.faulttree.app.rtc

import android.annotation.SuppressLint
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * 使用 AudioRecord 录制 16kHz 16bit 单声道 PCM，并封装为 WAV 文件。
 * 后端 /api/realtime/transcribe 只接受 WAV 格式。
 */
class AudioRecorder(private val context: Context) {

  companion object {
    private const val TAG = "AudioRecorder"
    private const val SAMPLE_RATE = 16000
    private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    private const val BUFFER_SIZE_MS = 100
  }

  private var audioRecord: AudioRecord? = null
  private var recordingThread: Thread? = null
  private var isRecording = false

  fun hasPermission(): Boolean {
    return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
  }

  @SuppressLint("MissingPermission")
  @Throws(IOException::class)
  fun start(outputFile: File) {
    if (isRecording) return
    val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
    if (minBufferSize <= 0) {
      throw IOException("无法初始化录音设备")
    }
    val bufferSize = maxOf(minBufferSize, SAMPLE_RATE * 2 * BUFFER_SIZE_MS / 1000)
    audioRecord = AudioRecord(
      MediaRecorder.AudioSource.MIC,
      SAMPLE_RATE,
      CHANNEL_CONFIG,
      AUDIO_FORMAT,
      bufferSize
    )
    if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
      throw IOException("录音初始化失败")
    }
    val pcmFile = File(outputFile.parentFile, "${outputFile.name}.pcm")
    isRecording = true
    audioRecord?.startRecording()
    recordingThread = Thread {
      writePcmToFile(pcmFile, bufferSize)
      try {
        pcmToWav(pcmFile, outputFile)
      } catch (e: Exception) {
        Log.e(TAG, "PCM to WAV failed", e)
      }
      pcmFile.delete()
    }
    recordingThread?.start()
  }

  fun stop() {
    isRecording = false
    try {
      audioRecord?.stop()
    } catch (e: Exception) {
      Log.w(TAG, "stop audio record failed", e)
    }
    audioRecord?.release()
    audioRecord = null
    try {
      recordingThread?.join(1000)
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    recordingThread = null
  }

  private fun writePcmToFile(pcmFile: File, bufferSize: Int) {
    val buffer = ByteArray(bufferSize)
    FileOutputStream(pcmFile).use { output ->
      while (isRecording) {
        val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
        if (read > 0) {
          output.write(buffer, 0, read)
        }
      }
    }
  }

  private fun pcmToWav(pcmFile: File, wavFile: File) {
    val pcmData = pcmFile.readBytes()
    FileOutputStream(wavFile).use { output ->
      output.write(wavHeader(pcmData.size, SAMPLE_RATE, 1))
      output.write(pcmData)
    }
  }

  private fun wavHeader(pcmLen: Int, sampleRate: Int, channels: Int): ByteArray {
    val byteRate = sampleRate * channels * 2
    val totalDataLen = pcmLen + 36
    val header = ByteArrayOutputStream()
    fun writeString(s: String) = header.write(s.toByteArray(Charsets.US_ASCII))
    fun writeInt(i: Int) {
      header.write(i and 0xff)
      header.write((i shr 8) and 0xff)
      header.write((i shr 16) and 0xff)
      header.write((i shr 24) and 0xff)
    }
    fun writeShort(s: Int) {
      header.write(s and 0xff)
      header.write((s shr 8) and 0xff)
    }
    writeString("RIFF")
    writeInt(totalDataLen)
    writeString("WAVE")
    writeString("fmt ")
    writeInt(16)
    writeShort(1)
    writeShort(channels)
    writeInt(sampleRate)
    writeInt(byteRate)
    writeShort(channels * 2)
    writeShort(16)
    writeString("data")
    writeInt(pcmLen)
    return header.toByteArray()
  }
}
