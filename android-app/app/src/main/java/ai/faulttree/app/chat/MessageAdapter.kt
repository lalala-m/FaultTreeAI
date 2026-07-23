package ai.faulttree.app.chat

import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import ai.faulttree.app.R
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup

class MessageAdapter : RecyclerView.Adapter<MessageAdapter.MessageViewHolder>() {

  private val messages = mutableListOf<ChatMessage>()
  private var listener: MessageListener? = null

  interface MessageListener {
    fun onClarificationSubmit(message: ChatMessage.Clarification)
    fun onClarificationSkip(message: ChatMessage.Clarification)
    fun onAnswerChanged(message: ChatMessage.Clarification, questionId: String, answer: String)
    fun onStepResult(message: ChatMessage.Steps, result: String)
    fun onViewResult(message: ChatMessage.Steps)
  }

  fun setListener(value: MessageListener?) {
    listener = value
  }

  companion object {
    private const val TYPE_USER = 1
    private const val TYPE_AI = 2
    private const val TYPE_LOADING = 3
    private const val TYPE_CLARIFICATION = 4
    private const val TYPE_STEPS = 5
    private const val TYPE_FAULT_TREE_RESULT = 6
  }

  fun addMessage(message: ChatMessage) {
    messages.add(message)
    notifyItemInserted(messages.size - 1)
  }

  fun setMessages(newMessages: List<ChatMessage>) {
    messages.clear()
    messages.addAll(newMessages)
    notifyDataSetChanged()
  }

  fun removeLast(): ChatMessage? {
    if (messages.isEmpty()) return null
    val removed = messages.removeAt(messages.size - 1)
    notifyItemRemoved(messages.size)
    return removed
  }

  fun removeAt(position: Int): ChatMessage? {
    if (position < 0 || position >= messages.size) return null
    val removed = messages.removeAt(position)
    notifyItemRemoved(position)
    return removed
  }

  fun indexOf(message: ChatMessage): Int = messages.indexOf(message)

  fun replaceMessage(oldMessage: ChatMessage, newMessage: ChatMessage) {
    val index = messages.indexOf(oldMessage)
    if (index >= 0) {
      messages[index] = newMessage
      notifyItemChanged(index)
    }
  }

  fun updateMessage(message: ChatMessage) {
    val index = messages.indexOf(message)
    if (index >= 0) {
      notifyItemChanged(index)
    }
  }

  fun removeMessage(message: ChatMessage): Boolean {
    val index = messages.indexOf(message)
    return if (index >= 0) {
      messages.removeAt(index)
      notifyItemRemoved(index)
      true
    } else {
      false
    }
  }

  override fun getItemViewType(position: Int): Int {
    return when (messages[position]) {
      is ChatMessage.User -> TYPE_USER
      is ChatMessage.Ai -> TYPE_AI
      is ChatMessage.Loading -> TYPE_LOADING
      is ChatMessage.Clarification -> TYPE_CLARIFICATION
      is ChatMessage.Steps -> TYPE_STEPS
      is ChatMessage.FaultTreeResult -> TYPE_FAULT_TREE_RESULT
    }
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): MessageViewHolder {
    val inflater = LayoutInflater.from(parent.context)
    return when (viewType) {
      TYPE_LOADING -> {
        val view = inflater.inflate(R.layout.item_message_loading, parent, false)
        LoadingViewHolder(view)
      }
      TYPE_CLARIFICATION -> {
        val view = inflater.inflate(R.layout.item_clarification, parent, false)
        ClarificationViewHolder(view)
      }
      TYPE_STEPS -> {
        val view = inflater.inflate(R.layout.item_steps, parent, false)
        StepsViewHolder(view)
      }
      TYPE_FAULT_TREE_RESULT -> {
        val view = inflater.inflate(R.layout.item_fault_tree_result, parent, false)
        FaultTreeResultViewHolder(view)
      }
      else -> {
        val view = inflater.inflate(R.layout.item_message, parent, false)
        BasicMessageViewHolder(view)
      }
    }
  }

  override fun onBindViewHolder(holder: MessageViewHolder, position: Int) {
    holder.bind(messages[position])
  }

  override fun getItemCount(): Int = messages.size

  abstract class MessageViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
    abstract fun bind(message: ChatMessage)
  }

  inner class BasicMessageViewHolder(itemView: View) : MessageViewHolder(itemView) {
    private val container: LinearLayout = itemView.findViewById(R.id.message_container)
    private val bubble: TextView = itemView.findViewById(R.id.message_bubble)

    override fun bind(message: ChatMessage) {
      when (message) {
        is ChatMessage.User -> {
          bubble.text = message.content
          container.gravity = Gravity.END
          bubble.setBackgroundResource(R.drawable.bg_bubble_user)
          bubble.setTextColor(0xFFFFFFFF.toInt())
        }
        is ChatMessage.Ai -> {
          bubble.text = message.content
          container.gravity = Gravity.START
          bubble.setBackgroundResource(R.drawable.bg_bubble_ai)
          bubble.setTextColor(0xFF1A1A1A.toInt())
        }
        else -> {
          bubble.text = message.content
          container.gravity = Gravity.START
          bubble.setBackgroundResource(R.drawable.bg_bubble_ai)
          bubble.setTextColor(0xFF1A1A1A.toInt())
        }
      }
    }
  }

  inner class LoadingViewHolder(itemView: View) : MessageViewHolder(itemView) {
    private val bubble: TextView = itemView.findViewById(R.id.message_bubble)

    override fun bind(message: ChatMessage) {
      bubble.text = message.content
    }
  }

  inner class ClarificationViewHolder(itemView: View) : MessageViewHolder(itemView) {
    private val intro: TextView = itemView.findViewById(R.id.tv_intro)
    private val topEvent: TextView = itemView.findViewById(R.id.tv_top_event)
    private val questionsContainer: LinearLayout = itemView.findViewById(R.id.questions_container)
    private val actionContainer: LinearLayout = itemView.findViewById(R.id.action_container)
    private val submitBtn: MaterialButton = itemView.findViewById(R.id.btn_submit)
    private val skipBtn: MaterialButton = itemView.findViewById(R.id.btn_skip)
    private val submittedState: TextView = itemView.findViewById(R.id.tv_submitted_state)

    private val watchers = mutableListOf<TextWatcher>()

    override fun bind(message: ChatMessage) {
      val clarification = message as ChatMessage.Clarification
      intro.text = clarification.intro.ifEmpty { "为了更精准地定位故障源，请补充以下信息：" }
      topEvent.text = "针对故障现象「${clarification.topEvent}」"

      questionsContainer.removeAllViews()
      watchers.clear()

      val inflater = LayoutInflater.from(itemView.context)
      clarification.questions.forEach { question ->
        val row = inflater.inflate(R.layout.item_clarification_question, questionsContainer, false)
        val tvText: TextView = row.findViewById(R.id.tv_question_text)
        val tvHint: TextView = row.findViewById(R.id.tv_hint)
        val tvRequired: TextView = row.findViewById(R.id.tv_required)
        val chipGroup: ChipGroup = row.findViewById(R.id.cg_options)
        val etAnswer: EditText = row.findViewById(R.id.et_answer)

        tvText.text = question.text
        tvRequired.visibility = if (question.required) View.VISIBLE else View.GONE

        val options = parseHintOptions(question.hint)
        if (options.isNotEmpty()) {
          // 显示为选项芯片
          tvHint.visibility = View.GONE
          chipGroup.visibility = View.VISIBLE
          etAnswer.visibility = View.GONE
          chipGroup.isSingleSelection = true
          chipGroup.isSelectionRequired = false
          chipGroup.removeAllViews()

          options.forEach { option ->
            val chip = inflater.inflate(R.layout.item_chip, chipGroup, false) as Chip
            chip.text = option
            chip.isCheckable = true
            chip.isChecked = clarification.answersDraft[question.id] == option
            chip.setOnCheckedChangeListener { _, isChecked ->
              if (isChecked) {
                listener?.onAnswerChanged(clarification, question.id, option)
              } else if (clarification.answersDraft[question.id] == option) {
                listener?.onAnswerChanged(clarification, question.id, "")
              }
            }
            chipGroup.addView(chip)
          }
          chipGroup.isEnabled = !clarification.submitted && !clarification.skipped
        } else {
          // 无可用选项时回退到输入框
          if (question.hint.isNotBlank()) {
            tvHint.text = "提示：${question.hint}"
            tvHint.visibility = View.VISIBLE
          } else {
            tvHint.visibility = View.GONE
          }
          chipGroup.visibility = View.GONE
          etAnswer.visibility = View.VISIBLE
          etAnswer.setText(clarification.answersDraft[question.id] ?: "")
          etAnswer.isEnabled = !clarification.submitted && !clarification.skipped

          val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
              listener?.onAnswerChanged(clarification, question.id, s?.toString() ?: "")
            }
          }
          etAnswer.addTextChangedListener(watcher)
          watchers.add(watcher)
        }

        questionsContainer.addView(row)
      }

      if (clarification.submitted || clarification.skipped) {
        actionContainer.visibility = View.GONE
        submittedState.visibility = View.VISIBLE
        submittedState.text = when {
          clarification.skipped -> "已跳过补充信息"
          clarification.submitted -> "已提交，正在生成排查步骤…"
          else -> ""
        }
      } else {
        actionContainer.visibility = View.VISIBLE
        submittedState.visibility = View.GONE
        submitBtn.setOnClickListener { listener?.onClarificationSubmit(clarification) }
        skipBtn.setOnClickListener { listener?.onClarificationSkip(clarification) }
      }
    }
  }

  private fun parseHintOptions(hint: String): List<String> {
    val raw = hint.trim()
    if (raw.isEmpty()) return emptyList()
    // 去掉前缀 "如：" / "例如：" / "如" / "例如"
    val body = raw.replace(Regex("^(如|例如)[：:\\s]*"), "")
    if (body.isEmpty()) return emptyList()
    return body.split(Regex("[;；]"))
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .flatMap { group ->
        group.split(Regex("[/／、]")).map { it.trim() }.filter { it.isNotEmpty() }
      }
      .filter { it.length <= 30 }
      .distinct()
  }

  inner class StepsViewHolder(itemView: View) : MessageViewHolder(itemView) {
    private val title: TextView = itemView.findViewById(R.id.tv_title)
    private val subtitle: TextView = itemView.findViewById(R.id.tv_subtitle)
    private val summary: TextView = itemView.findViewById(R.id.tv_summary)
    private val stepNumber: Chip = itemView.findViewById(R.id.chip_step_number)
    private val stepTitle: TextView = itemView.findViewById(R.id.tv_step_title)
    private val stepAction: TextView = itemView.findViewById(R.id.tv_step_action)
    private val stepExpected: TextView = itemView.findViewById(R.id.tv_step_expected)
    private val stepDecision: TextView = itemView.findViewById(R.id.tv_step_decision)
    private val stepNote: TextView = itemView.findViewById(R.id.tv_step_note)
    private val actionContainer: LinearLayout = itemView.findViewById(R.id.action_container)
    private val normalBtn: MaterialButton = itemView.findViewById(R.id.btn_normal)
    private val abnormalBtn: MaterialButton = itemView.findViewById(R.id.btn_abnormal)
    private val unknownBtn: MaterialButton = itemView.findViewById(R.id.btn_unknown)
    private val viewResultBtn: MaterialButton = itemView.findViewById(R.id.btn_view_result)

    override fun bind(message: ChatMessage) {
      val stepsMsg = message as ChatMessage.Steps
      title.text = "建议排查步骤"
      val reusedText = if (stepsMsg.reused) " · 命中历史记录（复用次数 ${stepsMsg.hitCount}）" else ""
      subtitle.text = "针对「${stepsMsg.topEvent}」${reusedText}"

      if (stepsMsg.summary.isNotBlank() && stepsMsg.currentStep == 0) {
        summary.text = stepsMsg.summary
        summary.visibility = View.VISIBLE
      } else {
        summary.visibility = View.GONE
      }

      val stepList = stepsMsg.steps
      val idx = stepsMsg.currentStep.coerceIn(0, (stepList.size - 1).coerceAtLeast(0))
      val step = stepList.getOrNull(idx)

      if (step != null) {
        stepNumber.text = "步骤 ${step.step}"
        stepTitle.text = step.title
        stepAction.text = step.action
        if (step.expected.isNotBlank()) {
          stepExpected.text = "预期结果：${step.expected}"
          stepExpected.visibility = View.VISIBLE
        } else {
          stepExpected.visibility = View.GONE
        }
        if (step.decision.isNotBlank()) {
          stepDecision.text = "决策：${step.decision}"
          stepDecision.visibility = View.VISIBLE
        } else {
          stepDecision.visibility = View.GONE
        }
        if (step.note.isNotBlank()) {
          stepNote.text = "注意：${step.note}"
          stepNote.visibility = View.VISIBLE
        } else {
          stepNote.visibility = View.GONE
        }
      } else {
        stepNumber.text = "步骤 0"
        stepTitle.text = "暂无步骤"
        stepAction.text = ""
        stepExpected.visibility = View.GONE
        stepDecision.visibility = View.GONE
        stepNote.visibility = View.GONE
      }

      val isLastOrFinished = stepsMsg.finished || stepsMsg.currentStep >= (stepList.size - 1).coerceAtLeast(0)
      if (isLastOrFinished) {
        normalBtn.visibility = View.GONE
        abnormalBtn.visibility = View.GONE
        unknownBtn.visibility = View.GONE
        viewResultBtn.visibility = View.VISIBLE
        viewResultBtn.setOnClickListener { listener?.onViewResult(stepsMsg) }
      } else {
        normalBtn.visibility = View.VISIBLE
        abnormalBtn.visibility = View.VISIBLE
        unknownBtn.visibility = View.VISIBLE
        viewResultBtn.visibility = View.GONE
        normalBtn.setOnClickListener { listener?.onStepResult(stepsMsg, "normal") }
        abnormalBtn.setOnClickListener { listener?.onStepResult(stepsMsg, "abnormal") }
        unknownBtn.setOnClickListener { listener?.onStepResult(stepsMsg, "unknown") }
      }
    }
  }

  inner class FaultTreeResultViewHolder(itemView: View) : MessageViewHolder(itemView) {
    private val subtitle: TextView = itemView.findViewById(R.id.tv_subtitle)
    private val summary: TextView = itemView.findViewById(R.id.tv_summary)
    private val chipGroup: ChipGroup = itemView.findViewById(R.id.chip_group)

    override fun bind(message: ChatMessage) {
      val result = message as ChatMessage.FaultTreeResult
      subtitle.text = if (result.reused) "已从历史记录匹配到故障树" else "已生成故障树"
      summary.text = result.summary

      chipGroup.removeAllViews()
      val inflater = LayoutInflater.from(itemView.context)
      result.provider?.takeIf { it.isNotBlank() }?.let {
        chipGroup.addView(createChip(inflater, chipGroup, "模型: ${it.uppercase()}"))
      }
      if (result.reused) {
        chipGroup.addView(createChip(inflater, chipGroup, "复用命中"))
      }
      if (result.hitCount > 0) {
        chipGroup.addView(createChip(inflater, chipGroup, "复用次数 ${result.hitCount}"))
      }
      chipGroup.addView(createChip(inflater, chipGroup, "文档权重 ${(result.manualWeight * 100).toInt()}%"))
    }

    private fun createChip(inflater: LayoutInflater, parent: ViewGroup, text: String): Chip {
      val chip = inflater.inflate(R.layout.item_chip, parent, false) as Chip
      chip.text = text
      return chip
    }
  }
}
