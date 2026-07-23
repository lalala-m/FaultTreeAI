package ai.faulttree.app

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class FaultTreeApplication : Application() {

  override fun onCreate() {
    super.onCreate()

    val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        writeCrashLog(throwable)
      } catch (ignored: Exception) {
        // ignore
      }
      defaultHandler?.uncaughtException(thread, throwable)
    }

    FileLogger.init(this)
  }

  private fun writeCrashLog(throwable: Throwable) {
    val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
    val sb = StringBuilder()
    sb.appendLine("Crash Time: $time")
    sb.appendLine("App Version: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
    sb.appendLine("--- Stack Trace ---")
    sb.appendLine(throwable.stackTraceToString())

    val logDir = getExternalFilesDir(null) ?: filesDir
    val logFile = File(logDir, "crash.log")
    logFile.writeText(sb.toString())

    // 尝试提示用户日志路径
    Handler(Looper.getMainLooper()).post {
      Toast.makeText(
        this,
        "App 已闪退，日志已保存到：\n${logFile.absolutePath}",
        Toast.LENGTH_LONG
      ).show()
    }
  }
}
