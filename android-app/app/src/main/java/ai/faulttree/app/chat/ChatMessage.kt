package ai.faulttree.app.chat

sealed class ChatMessage {
  abstract val content: String
  abstract val timestamp: Long
  abstract val id: String

  data class User(
    override val content: String,
    override val id: String = "user_${System.currentTimeMillis()}_${(0..9999).random()}",
    override val timestamp: Long = System.currentTimeMillis()
  ) : ChatMessage()

  data class Ai(
    override val content: String,
    override val id: String = "ai_${System.currentTimeMillis()}_${(0..9999).random()}",
    override val timestamp: Long = System.currentTimeMillis()
  ) : ChatMessage()

  data class Loading(
    override val content: String = "AI 思考中...",
    override val id: String = "loading_${System.currentTimeMillis()}_${(0..9999).random()}",
    override val timestamp: Long = System.currentTimeMillis()
  ) : ChatMessage()

  data class Clarification(
    val topEvent: String,
    val questions: List<ClarifyQuestion> = emptyList(),
    val intro: String = "",
    val refinedQueryHint: String = "",
    val provider: String? = null,
    val cached: Boolean = false,
    val answersDraft: MutableMap<String, String> = mutableMapOf(),
    val submitted: Boolean = false,
    val skipped: Boolean = false,
    override val id: String = "clarify_${System.currentTimeMillis()}_${(0..9999).random()}",
    override val timestamp: Long = System.currentTimeMillis()
  ) : ChatMessage() {
    override val content: String get() = intro
  }

  data class Steps(
    val topEvent: String,
    val questions: List<ClarifyQuestion> = emptyList(),
    val answers: Map<String, String> = emptyMap(),
    val steps: List<DiagnosisStep> = emptyList(),
    val summary: String = "",
    val currentStep: Int = 0,
    val finished: Boolean = false,
    val reused: Boolean = false,
    val hitCount: Int = 0,
    val provider: String? = null,
    override val id: String = "steps_${System.currentTimeMillis()}_${(0..9999).random()}",
    override val timestamp: Long = System.currentTimeMillis()
  ) : ChatMessage() {
    override val content: String get() = summary
  }

  data class FaultTreeResult(
    val summary: String,
    val treeId: String? = null,
    val reused: Boolean = false,
    val provider: String? = null,
    val hitCount: Int = 0,
    val manualWeight: Float = 0.5f,
    override val id: String = "ft_${System.currentTimeMillis()}_${(0..9999).random()}",
    override val timestamp: Long = System.currentTimeMillis()
  ) : ChatMessage() {
    override val content: String get() = summary
  }
}

data class ClarifyQuestion(
  val id: String,
  val text: String,
  val hint: String = "",
  val required: Boolean = false
)

data class DiagnosisStep(
  val step: Int,
  val title: String,
  val action: String,
  val expected: String = "",
  val decision: String = "",
  val note: String = ""
)
