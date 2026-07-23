package ai.faulttree.app

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object FileLogger {

  private const val FILENAME = "runtime.log"
  private val dateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault())

  private fun logFile(context: Context): File {
    val dir = context.getExternalFilesDir(null) ?: context.filesDir
    return File(dir, FILENAME)
  }

  @JvmStatic
  fun init(context: Context) {
    try {
      val file = logFile(context)
      file.writeText("Runtime log started at ${dateFormat.format(Date())}\n")
    } catch (ignored: Exception) {
    }
  }

  @JvmStatic
  fun log(context: Context, tag: String, message: String) {
    try {
      val file = logFile(context)
      val line = "${dateFormat.format(Date())} [$tag] $message\n"
      file.appendText(line)
    } catch (ignored: Exception) {
    }
  }

  @JvmStatic
  fun log(context: Context, tag: String, message: String, throwable: Throwable) {
    log(context, tag, "$message\n${throwable.stackTraceToString()}")
  }
}
