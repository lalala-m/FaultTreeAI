package ai.faulttree.app.rtc

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.view.SurfaceView
import java.io.ByteArrayOutputStream

/**
 * 将 SurfaceView 上的画面捕获为 JPEG 并编码成 Base64 data URL，
 * 用于通过 WebSocket 发送给后端做实时画面分析。
 *
 * 要求 API 24+（PixelCopy），当前 minSdk=24 已满足。
 */
object FrameCapture {

  interface Callback {
    fun onSuccess(dataUrl: String)
    fun onError(message: String)
  }

  fun capture(surfaceView: SurfaceView, callback: Callback, maxDimension: Int = 640, quality: Int = 75) {
    try {
      val width = surfaceView.width
      val height = surfaceView.height
      if (width <= 0 || height <= 0) {
        callback.onError("SurfaceView 尺寸无效")
        return
      }
      val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
      val listener = PixelCopy.OnPixelCopyFinishedListener { copyResult ->
        if (copyResult == PixelCopy.SUCCESS) {
          val scaled = scaleBitmap(bitmap, maxDimension)
          val base64 = bitmapToJpegBase64(scaled, quality)
          if (base64.isNotEmpty()) {
            callback.onSuccess("data:image/jpeg;base64,$base64")
          } else {
            callback.onError("图片编码失败")
          }
          bitmap.recycle()
          if (scaled !== bitmap) {
            scaled.recycle()
          }
        } else {
          bitmap.recycle()
          callback.onError("PixelCopy 失败: $copyResult")
        }
      }
      PixelCopy.request(surfaceView, bitmap, listener, Handler(Looper.getMainLooper()))
    } catch (e: Exception) {
      callback.onError("截图异常: ${e.message}")
    }
  }

  private fun scaleBitmap(bitmap: Bitmap, maxDimension: Int): Bitmap {
    val width = bitmap.width
    val height = bitmap.height
    if (width <= maxDimension && height <= maxDimension) {
      return bitmap
    }
    val ratio = width.toFloat() / height.toFloat()
    val (newWidth, newHeight) = if (width > height) {
      maxDimension to (maxDimension / ratio).toInt()
    } else {
      (maxDimension * ratio).toInt() to maxDimension
    }
    return Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true)
  }

  private fun bitmapToJpegBase64(bitmap: Bitmap, quality: Int): String {
    return ByteArrayOutputStream().use { output ->
      bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)
      Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }
  }
}
