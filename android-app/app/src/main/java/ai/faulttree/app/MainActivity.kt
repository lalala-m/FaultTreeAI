package ai.faulttree.app

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import ai.faulttree.app.chat.ChatMessage
import ai.faulttree.app.chat.ClarifyQuestion
import ai.faulttree.app.chat.DiagnosisStep
import ai.faulttree.app.chat.MessageAdapter
import ai.faulttree.app.rtc.ApiClient
import ai.faulttree.app.rtc.RtcRoomActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity(), MessageAdapter.MessageListener {

  companion object {
    private const val PREF_NAME = "faulttree_prefs"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_SELECTED_PROVIDER = "selected_provider"
    private const val KEY_SELECTED_PIPELINE = "selected_pipeline"
  }

  private lateinit var recyclerView: RecyclerView
  private lateinit var messageInput: EditText
  private lateinit var sendButton: ImageButton
  private lateinit var videoCallButton: ImageButton
  private lateinit var settingsButton: ImageButton
  private lateinit var historyButton: ImageButton
  private lateinit var providerText: TextView
  private lateinit var pipelineText: TextView
  private lateinit var messageAdapter: MessageAdapter
  private lateinit var prefs: SharedPreferences

  private var availableProviders: List<ApiClient.Provider> = emptyList()
  private var availablePipelines: List<String> = listOf("流水线1")
  private var selectedProvider: String? = null
  private var selectedPipeline: String = "流水线1"
  private var isGenerating = false
  private var currentServerUrl: String = ""

  private val requestPermissionsLauncher =
    registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
      if (results.values.all { it }) {
        startVideoCall()
      } else {
        toast("需要摄像头和麦克风权限才能通话")
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)

    recyclerView = findViewById(R.id.chat_recycler_view)
    messageInput = findViewById(R.id.message_input)
    sendButton = findViewById(R.id.btn_send)
    videoCallButton = findViewById(R.id.btn_video_call)
    settingsButton = findViewById(R.id.btn_settings)
    historyButton = findViewById(R.id.btn_history)
    providerText = findViewById(R.id.tv_provider)
    pipelineText = findViewById(R.id.tv_pipeline)

    prefs = getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
    currentServerUrl = prefs.getString(KEY_SERVER_URL, null) ?: BuildConfig.SERVER_URL.ifEmpty {
      "https://192.168.43.122:8443"
    }
    selectedProvider = prefs.getString(KEY_SELECTED_PROVIDER, null)
    selectedPipeline = prefs.getString(KEY_SELECTED_PIPELINE, null) ?: "流水线1"

    messageAdapter = MessageAdapter()
    messageAdapter.setListener(this)
    recyclerView.layoutManager = LinearLayoutManager(this)
    recyclerView.adapter = messageAdapter

    messageAdapter.setMessages(
      listOf(
        ChatMessage.Ai(
          content = "你好，我是故障检修系统助手。\n\n你可以直接文字描述设备故障，我会先问你几个关键问题，再生成排查步骤和故障树分析；也可以点击「开始 AI 视频通话」，让我实时观察现场并语音交流。"
        )
      )
    )

    sendButton.setOnClickListener { sendMessage() }
    messageInput.setOnEditorActionListener { _, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_SEND) {
        sendMessage()
        true
      } else {
        false
      }
    }

    videoCallButton.setOnClickListener {
      requestPermissionsLauncher.launch(
        arrayOf(
          Manifest.permission.CAMERA,
          Manifest.permission.RECORD_AUDIO,
          Manifest.permission.MODIFY_AUDIO_SETTINGS,
        )
      )
    }

    providerText.setOnClickListener { showProviderDialog() }
    pipelineText.setOnClickListener { showPipelineDialog() }
    settingsButton.setOnClickListener { showSettingsDialog() }
    historyButton.setOnClickListener { showHistoryDialog() }

    loadConfig()
  }

  private fun showSettingsDialog() {
    val view = layoutInflater.inflate(R.layout.dialog_settings, null)
    val editText = view.findViewById<EditText>(R.id.et_server_url)
    editText.setText(currentServerUrl)

    AlertDialog.Builder(this)
      .setView(view)
      .setPositiveButton("保存") { _, _ ->
        val url = normalizeServerUrl(editText.text.toString().trim())
        currentServerUrl = url
        prefs.edit().putString(KEY_SERVER_URL, url).apply()
        loadConfig()
        toast("服务器地址已保存")
      }
      .setNegativeButton("取消", null)
      .show()
  }

  private fun normalizeServerUrl(raw: String): String {
    var url = raw
    if (url.isEmpty()) {
      url = BuildConfig.SERVER_URL.ifEmpty { "https://192.168.43.122:8443" }
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://$url"
    }
    return url.trimEnd('/')
  }

  private fun baseUrl(): String {
    return normalizeServerUrl(currentServerUrl)
  }

  private fun loadConfig() {
    val url = baseUrl()
    lifecycleScope.launch {
      try {
        val providers = withContext(Dispatchers.IO) { ApiClient.getProviders(url) }
        availableProviders = providers
        if (selectedProvider == null || providers.none { it.name == selectedProvider }) {
          selectedProvider = providers.find { it.available }?.name
        }
        updateProviderText()
      } catch (e: Exception) {
        updateProviderText()
      }

      try {
        val pipelines = withContext(Dispatchers.IO) { ApiClient.listPipelines(url) }
        availablePipelines = pipelines
        if (!pipelines.contains(selectedPipeline)) {
          selectedPipeline = pipelines.firstOrNull() ?: "流水线1"
        }
        updatePipelineText()
      } catch (e: Exception) {
        updatePipelineText()
      }
    }
  }

  private fun updateProviderText() {
    val name = selectedProvider ?: "默认"
    val display = availableProviders.find { it.name == selectedProvider }?.display_name ?: name
    providerText.text = "模型: $display"
  }

  private fun updatePipelineText() {
    pipelineText.text = "流水线: $selectedPipeline"
  }

  private fun showProviderDialog() {
    if (availableProviders.isEmpty()) {
      toast("暂无可用模型，请检查服务器地址")
      return
    }
    val items = availableProviders.map {
      val label = it.display_name?.takeIf { it.isNotBlank() } ?: it.name
      "$label ${if (it.available) "" else "(不可用)"}"
    }.toTypedArray()
    AlertDialog.Builder(this)
      .setTitle("选择模型")
      .setItems(items) { _, which ->
        selectedProvider = availableProviders[which].name
        prefs.edit().putString(KEY_SELECTED_PROVIDER, selectedProvider).apply()
        updateProviderText()
      }
      .setNegativeButton("取消", null)
      .show()
  }

  private fun showPipelineDialog() {
    if (availablePipelines.isEmpty()) {
      toast("暂无可用流水线")
      return
    }
    val items = availablePipelines.toTypedArray()
    AlertDialog.Builder(this)
      .setTitle("选择流水线")
      .setItems(items) { _, which ->
        selectedPipeline = availablePipelines[which]
        prefs.edit().putString(KEY_SELECTED_PIPELINE, selectedPipeline).apply()
        updatePipelineText()
      }
      .setNegativeButton("取消", null)
      .show()
  }

  private fun showHistoryDialog() {
    lifecycleScope.launch {
      try {
        val url = baseUrl()
        val items = withContext(Dispatchers.IO) { ApiClient.listFaultTrees(url) }
        if (items.isEmpty()) {
          toast("暂无历史故障树")
          return@launch
        }
        val labels = items.map {
          "${it.top_event} · ${it.created_at?.take(10) ?: ""}"
        }.toTypedArray()
        AlertDialog.Builder(this@MainActivity)
          .setTitle("历史故障树")
          .setItems(labels) { _, which ->
            loadHistoryFaultTree(items[which].tree_id)
          }
          .setNegativeButton("关闭", null)
          .show()
      } catch (e: Exception) {
        toast("加载历史失败：${e.message ?: "未知错误"}")
      }
    }
  }

  private fun loadHistoryFaultTree(treeId: String) {
    if (isGenerating) return
    isGenerating = true
    sendButton.isEnabled = false

    lifecycleScope.launch {
      val loading = addLoading()
      try {
        val resp = withContext(Dispatchers.IO) { ApiClient.getFaultTree(baseUrl(), treeId) }
        removeLoading(loading)
        finalizeFaultTreeResult(
          summary = resp.fault_tree?.analysis_summary ?: "暂无分析摘要",
          treeId = resp.tree_id,
          reused = true,
          provider = resp.provider,
          hitCount = 0
        )
      } catch (e: Exception) {
        removeLoading(loading)
        showError("加载历史故障树失败：${e.message ?: "未知错误"}")
      } finally {
        isGenerating = false
        sendButton.isEnabled = true
      }
    }
  }

  private fun sendMessage() {
    val text = messageInput.text.toString().trim()
    if (text.isEmpty() || isGenerating) return

    messageAdapter.addMessage(ChatMessage.User(content = text))
    messageInput.setText("")
    scrollToBottom()

    isGenerating = true
    sendButton.isEnabled = false

    lifecycleScope.launch {
      val loading = addLoading()
      try {
        startClarification(text, loading)
      } catch (e: Exception) {
        removeLoading(loading)
        showError("处理失败：${e.message ?: "未知错误"}")
      } finally {
        isGenerating = false
        sendButton.isEnabled = true
      }
    }
  }

  private suspend fun startClarification(topEvent: String, loading: ChatMessage.Loading) {
    val url = baseUrl()

    try {
      val cached = withContext(Dispatchers.IO) {
        ApiClient.clarifyLookup(url, ApiClient.ClarifyLookupRequest(topEvent))
      }
      if (cached.found && !cached.questions.isNullOrEmpty()) {
        removeLoading(loading)
        messageAdapter.addMessage(
          ChatMessage.Clarification(
            topEvent = topEvent,
            questions = cached.questions.map { it.toChatQuestion() },
            intro = cached.raw_intro ?: "",
            refinedQueryHint = cached.refined_query_hint ?: "",
            provider = cached.provider,
            cached = true
          )
        )
        scrollToBottom()
        return
      }
    } catch (e: Exception) {
      // 缓存查询失败继续走 clarify
    }

    try {
      val resp = withContext(Dispatchers.IO) {
        ApiClient.clarifyProblem(
          url,
          ApiClient.ClarifyRequest(
            top_event = topEvent,
            doc_ids = null,
            provider = selectedProvider,
            rag_top_k = 3,
            max_questions = 4
          )
        )
      }
      val questions = resp.questions?.map { it.toChatQuestion() } ?: emptyList()
      if (questions.isNotEmpty()) {
        removeLoading(loading)
        messageAdapter.addMessage(
          ChatMessage.Clarification(
            topEvent = topEvent,
            questions = questions,
            intro = resp.raw_intro ?: "",
            refinedQueryHint = resp.refined_query_hint ?: "",
            provider = resp.provider,
            cached = false
          )
        )
        scrollToBottom()
        return
      }
    } catch (e: Exception) {
      // 澄清失败也回退到直接生成
    }

    removeLoading(loading)
    generateFromTopEvent(topEvent, "")
  }

  override fun onClarificationSubmit(message: ChatMessage.Clarification) {
    val missing = message.questions.filter {
      it.required && message.answersDraft[it.id].isNullOrBlank()
    }
    if (missing.isNotEmpty()) {
      toast("请填写必填项：${missing.joinToString("；") { it.text }}")
      return
    }

    isGenerating = true
    sendButton.isEnabled = false

    lifecycleScope.launch {
      var loading: ChatMessage.Loading? = null
      try {
        val submittedMessage = message.copy(submitted = true)
        messageAdapter.replaceMessage(message, submittedMessage)

        messageAdapter.addMessage(
          ChatMessage.User(content = buildUserSummary(submittedMessage))
        )
        scrollToBottom()

        loading = addLoading()
        val url = baseUrl()
        try {
          val cached = withContext(Dispatchers.IO) {
            ApiClient.stepsLookup(
              url,
              ApiClient.StepsLookupRequest(
                top_event = submittedMessage.topEvent,
                answers = submittedMessage.answersDraft
              )
            )
          }
          if (cached.found && !cached.steps.isNullOrEmpty()) {
            removeLoading(loading)
            finalizeStepsResult(
              topEvent = submittedMessage.topEvent,
              questions = submittedMessage.questions,
              answers = submittedMessage.answersDraft,
              steps = cached.steps.map { it.toChatStep() },
              summary = cached.summary ?: "",
              reused = true,
              hitCount = cached.hit_count
            )
            return@launch
          }
        } catch (e: Exception) {
          // steps 查询失败继续生成
        }

        val enrichedPrompt = buildEnrichedPrompt(submittedMessage)
        val resp = withContext(Dispatchers.IO) {
          ApiClient.generateSteps(
            url,
            ApiClient.StepsRequest(
              top_event = submittedMessage.topEvent,
              user_prompt = enrichedPrompt,
              doc_ids = null,
              provider = selectedProvider,
              rag_top_k = 3,
              clarify_questions = submittedMessage.questions.map { it.toApiQuestion() },
              clarify_answers = submittedMessage.answersDraft
            )
          )
        }
        removeLoading(loading)
        finalizeStepsResult(
          topEvent = submittedMessage.topEvent,
          questions = submittedMessage.questions,
          answers = submittedMessage.answersDraft,
          steps = resp.steps?.map { it.toChatStep() } ?: emptyList(),
          summary = resp.summary ?: "",
          reused = false,
          hitCount = 0,
          provider = resp.provider
        )
      } catch (e: Exception) {
        loading?.let { removeLoading(it) }
        showError("生成排查步骤失败：${e.message ?: "未知错误"}")
      } finally {
        isGenerating = false
        sendButton.isEnabled = true
      }
    }
  }

  override fun onClarificationSkip(message: ChatMessage.Clarification) {
    isGenerating = true
    sendButton.isEnabled = false

    lifecycleScope.launch {
      var loading: ChatMessage.Loading? = null
      try {
        val skippedMessage = message.copy(skipped = true)
        messageAdapter.replaceMessage(message, skippedMessage)
        messageAdapter.addMessage(ChatMessage.User(content = "（跳过补充信息，直接生成排查步骤）"))
        scrollToBottom()

        loading = addLoading()
        val url = baseUrl()
        try {
          val cached = withContext(Dispatchers.IO) {
            ApiClient.stepsLookup(
              url,
              ApiClient.StepsLookupRequest(
                top_event = skippedMessage.topEvent,
                answers = emptyMap()
              )
            )
          }
          if (cached.found && !cached.steps.isNullOrEmpty()) {
            removeLoading(loading)
            finalizeStepsResult(
              topEvent = skippedMessage.topEvent,
              questions = skippedMessage.questions,
              answers = emptyMap(),
              steps = cached.steps.map { it.toChatStep() },
              summary = cached.summary ?: "",
              reused = true,
              hitCount = cached.hit_count
            )
            return@launch
          }
        } catch (e: Exception) {
          // 继续生成
        }

        val resp = withContext(Dispatchers.IO) {
          ApiClient.generateSteps(
            url,
            ApiClient.StepsRequest(
              top_event = skippedMessage.topEvent,
              user_prompt = "",
              doc_ids = null,
              provider = selectedProvider,
              rag_top_k = 3,
              clarify_questions = skippedMessage.questions.map { it.toApiQuestion() },
              clarify_answers = emptyMap()
            )
          )
        }
        removeLoading(loading)
        finalizeStepsResult(
          topEvent = skippedMessage.topEvent,
          questions = skippedMessage.questions,
          answers = emptyMap(),
          steps = resp.steps?.map { it.toChatStep() } ?: emptyList(),
          summary = resp.summary ?: "",
          reused = false,
          hitCount = 0,
          provider = resp.provider
        )
      } catch (e: Exception) {
        loading?.let { removeLoading(it) }
        showError("生成排查步骤失败：${e.message ?: "未知错误"}")
      } finally {
        isGenerating = false
        sendButton.isEnabled = true
      }
    }
  }

  override fun onAnswerChanged(message: ChatMessage.Clarification, questionId: String, answer: String) {
    message.answersDraft[questionId] = answer
  }

  override fun onStepResult(message: ChatMessage.Steps, result: String) {
    val nextStep = message.currentStep + 1
    val finished = nextStep >= message.steps.size
    val updated = message.copy(currentStep = nextStep, finished = finished)
    messageAdapter.replaceMessage(message, updated)
    scrollToBottom()
  }

  override fun onViewResult(message: ChatMessage.Steps) {
    if (isGenerating) return
    isGenerating = true
    sendButton.isEnabled = false

    lifecycleScope.launch {
      var loading: ChatMessage.Loading? = null
      try {
        loading = addLoading()
        val url = baseUrl()
        try {
          val diagnosis = withContext(Dispatchers.IO) {
            ApiClient.diagnosisLookup(
              url,
              ApiClient.DiagnosisLookupRequest(
                top_event = message.topEvent,
                answers = message.answers
              )
            )
          }
          if (diagnosis.found && diagnosis.fault_tree != null) {
            removeLoading(loading)
            finalizeFaultTreeResult(
              summary = diagnosis.fault_tree.analysis_summary,
              treeId = diagnosis.tree_id,
              reused = true,
              provider = selectedProvider,
              hitCount = diagnosis.hit_count
            )
            return@launch
          }
        } catch (e: Exception) {
          // 诊断查询失败继续生成
        }

        val enrichedPrompt = buildEnrichedPrompt(message)
        generateFromTopEvent(
          topEvent = message.topEvent,
          userPrompt = enrichedPrompt,
          questions = message.questions,
          answers = message.answers,
          loading = loading
        )
      } catch (e: Exception) {
        loading?.let { removeLoading(it) }
        showError("生成故障树失败：${e.message ?: "未知错误"}")
      } finally {
        isGenerating = false
        sendButton.isEnabled = true
      }
    }
  }

  private fun finalizeStepsResult(
    topEvent: String,
    questions: List<ClarifyQuestion>,
    answers: Map<String, String>,
    steps: List<DiagnosisStep>,
    summary: String,
    reused: Boolean,
    hitCount: Int,
    provider: String? = null
  ) {
    messageAdapter.addMessage(
      ChatMessage.Steps(
        topEvent = topEvent,
        questions = questions,
        answers = answers,
        steps = steps,
        summary = summary,
        reused = reused,
        hitCount = hitCount,
        provider = provider
      )
    )
    scrollToBottom()
  }

  private suspend fun generateFromTopEvent(
    topEvent: String,
    userPrompt: String,
    questions: List<ClarifyQuestion> = emptyList(),
    answers: Map<String, String> = emptyMap(),
    loading: ChatMessage.Loading? = null
  ) {
    val url = baseUrl()

    try {
      val lookupQuery = if (userPrompt.isNotBlank()) "$topEvent\n$userPrompt" else topEvent
      try {
        val hit = withContext(Dispatchers.IO) {
          ApiClient.lookupFaultTree(url, ApiClient.LookupFaultTreeRequest(lookupQuery))
        }
        if (hit.found && hit.tree_id != null) {
          val reused = withContext(Dispatchers.IO) { ApiClient.getFaultTree(url, hit.tree_id) }
          loading?.let { removeLoading(it) }
          finalizeFaultTreeResult(
            summary = reused.fault_tree?.analysis_summary ?: "已从历史记录匹配到故障树。",
            treeId = reused.tree_id,
            reused = true,
            provider = reused.provider,
            hitCount = 0
          )
          return
        }
      } catch (e: Exception) {
        // lookup 失败继续生成
      }

      val req = ApiClient.GenerateRequest(
        top_event = topEvent,
        user_prompt = userPrompt,
        provider = selectedProvider,
        doc_ids = null,
        manual_weight = 0.5f,
        clarify_questions = questions.map { it.toApiQuestion() }.takeIf { it.isNotEmpty() },
        clarify_answers = answers.takeIf { it.isNotEmpty() }
      )
      val resp = withContext(Dispatchers.IO) { ApiClient.generateFaultTree(url, req) }
      loading?.let { removeLoading(it) }
      finalizeFaultTreeResult(
        summary = resp.fault_tree?.analysis_summary ?: "已生成故障树。",
        treeId = resp.tree_id,
        reused = false,
        provider = resp.provider,
        hitCount = 0
      )
    } catch (e: Exception) {
      loading?.let { removeLoading(it) }
      showError("生成故障树失败：${e.message ?: "未知错误"}")
    }
  }

  private fun finalizeFaultTreeResult(
    summary: String,
    treeId: String?,
    reused: Boolean,
    provider: String?,
    hitCount: Int
  ) {
    messageAdapter.addMessage(
      ChatMessage.FaultTreeResult(
        summary = summary,
        treeId = treeId,
        reused = reused,
        provider = provider,
        hitCount = hitCount
      )
    )
    scrollToBottom()
  }

  private fun buildEnrichedPrompt(message: ChatMessage.Clarification): String {
    val lines = message.questions.mapNotNull { q ->
      val ans = message.answersDraft[q.id]?.trim()
      if (ans.isNullOrBlank()) null else "- ${q.text}\n  回答：$ans"
    }
    return if (lines.isEmpty()) "" else {
      "原始描述：${message.topEvent}\n\n补充信息：\n${lines.joinToString("\n")}"
    }
  }

  private fun buildEnrichedPrompt(message: ChatMessage.Steps): String {
    val lines = message.questions.mapNotNull { q ->
      val ans = message.answers[q.id]?.trim()
      if (ans.isNullOrBlank()) null else "- ${q.text}\n  回答：$ans"
    }
    return if (lines.isEmpty()) "" else {
      "原始描述：${message.topEvent}\n\n补充信息：\n${lines.joinToString("\n")}"
    }
  }

  private fun buildUserSummary(message: ChatMessage.Clarification): String {
    val lines = message.questions.mapNotNull { q ->
      val ans = message.answersDraft[q.id]?.trim()
      if (ans.isNullOrBlank()) null else "${q.text} → $ans"
    }
    return if (lines.isEmpty()) "（未填写补充信息）" else lines.joinToString("；")
  }

  private fun addLoading(): ChatMessage.Loading {
    val loading = ChatMessage.Loading()
    messageAdapter.addMessage(loading)
    scrollToBottom()
    return loading
  }

  private fun removeLoading(loading: ChatMessage.Loading) {
    messageAdapter.removeMessage(loading)
  }

  private fun showError(text: String) {
    messageAdapter.addMessage(ChatMessage.Ai(content = text))
    scrollToBottom()
  }

  private fun scrollToBottom() {
    recyclerView.post {
      if (messageAdapter.itemCount > 0) {
        recyclerView.smoothScrollToPosition(messageAdapter.itemCount - 1)
      }
    }
  }

  private fun startVideoCall() {
    val url = baseUrl()
    prefs.edit().putString(KEY_SERVER_URL, url).apply()
    RtcRoomActivity.start(this, url)
  }

  private fun toast(msg: String) {
    Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
  }

  private fun ApiClient.ClarifyQuestion.toChatQuestion(): ClarifyQuestion {
    return ClarifyQuestion(id, text, hint, required)
  }

  private fun ApiClient.DiagnosisStep.toChatStep(): DiagnosisStep {
    return DiagnosisStep(step, title, action, expected, decision, note)
  }

  private fun ClarifyQuestion.toApiQuestion(): ApiClient.ClarifyQuestion {
    return ApiClient.ClarifyQuestion(id, text, hint, required)
  }
}
