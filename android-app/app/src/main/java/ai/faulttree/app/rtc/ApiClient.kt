package ai.faulttree.app.rtc

import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

object ApiClient {

  private val client = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(15, TimeUnit.SECONDS)
    .build()

  private val longClient = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(300, TimeUnit.SECONDS)
    .build()

  private val gson = Gson()
  private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

  data class SessionResponse(
    val session_id: String,
    val app_id: String,
    val room_id: String,
    val user_id: String,
    val token: String,
    val ai_user_id: String,
    val ai_display_name: String,
    val welcome_message: String
  )

  data class Provider(
    val name: String,
    val display_name: String? = null,
    val model: String? = null,
    val available: Boolean = false,
    val reason: String? = null
  )

  data class ProvidersResponse(val providers: List<Provider>? = null, val primary: String? = null)

  data class PipelineResponse(val pipelines: List<String>? = null)

  data class Document(
    val doc_id: String,
    val filename: String,
    val status: String? = null,
    val current_weight: Float? = null
  )

  data class ClarifyQuestion(
    val id: String,
    val text: String,
    val hint: String = "",
    val required: Boolean = false
  )

  data class ClarifyRequest(
    val top_event: String,
    val doc_ids: List<String>? = null,
    val provider: String? = null,
    val rag_top_k: Int = 3,
    val max_questions: Int = 4
  )

  data class ClarifyResponse(
    val questions: List<ClarifyQuestion>? = null,
    val refined_query_hint: String? = null,
    val provider: String? = null,
    val raw_intro: String? = null
  )

  data class ClarifyLookupRequest(val top_event: String)

  data class ClarifyLookupResponse(
    val found: Boolean = false,
    val questions: List<ClarifyQuestion>? = null,
    val raw_intro: String? = null,
    val refined_query_hint: String? = null,
    val provider: String? = null
  )

  data class DiagnosisStep(
    val step: Int,
    val title: String,
    val action: String,
    val expected: String = "",
    val decision: String = "",
    val note: String = ""
  )

  data class StepsRequest(
    val top_event: String,
    val user_prompt: String = "",
    val doc_ids: List<String>? = null,
    val provider: String? = null,
    val rag_top_k: Int = 3,
    val clarify_questions: List<ClarifyQuestion>? = null,
    val clarify_answers: Map<String, String>? = null
  )

  data class StepsResponse(
    val steps: List<DiagnosisStep>? = null,
    val summary: String? = null,
    val provider: String? = null
  )

  data class StepsLookupRequest(
    val top_event: String,
    val answers: Map<String, String>? = null
  )

  data class StepsLookupResponse(
    val found: Boolean = false,
    val steps: List<DiagnosisStep>? = null,
    val summary: String? = null,
    val hit_count: Int = 0
  )

  data class DiagnosisLookupRequest(
    val top_event: String,
    val answers: Map<String, String>? = null
  )

  data class DiagnosisLookupResponse(
    val found: Boolean = false,
    val tree_id: String? = null,
    val fault_tree: FaultTree? = null,
    val similarity: Float = 0f,
    val hit_count: Int = 0
  )

  data class GenerateRequest(
    val top_event: String,
    val user_prompt: String = "",
    val rag_top_k: Int = 5,
    val use_fallback: Boolean = true,
    val provider: String? = null,
    val doc_ids: List<String>? = null,
    val manual_weight: Float = 0.5f,
    val clarify_questions: List<ClarifyQuestion>? = null,
    val clarify_answers: Map<String, String>? = null
  )

  data class FaultTreeNode(
    val id: String,
    val type: String,
    val name: String,
    val description: String = "",
    val source_ref: String? = null
  )

  data class FaultTreeGate(
    val id: String,
    val type: String,
    val output_node: String,
    val input_nodes: List<String>
  )

  data class FaultTree(
    val top_event: String,
    val analysis_summary: String,
    val confidence: Float? = null,
    val nodes: List<FaultTreeNode>? = null,
    val gates: List<FaultTreeGate>? = null
  )

  data class GenerateResponse(
    val tree_id: String? = null,
    val fault_tree: FaultTree? = null,
    val provider: String? = null,
    val validation_issues: List<String>? = null,
    val mcs: List<List<String>>? = null,
    val importance: List<Map<String, Any>>? = null
  )

  data class FaultTreeHistoryItem(
    val tree_id: String,
    val top_event: String,
    val confidence: Float? = null,
    val is_valid: Boolean? = null,
    val created_at: String? = null
  )

  data class LookupFaultTreeRequest(val query: String)

  data class LookupFaultTreeResponse(
    val found: Boolean = false,
    val tree_id: String? = null,
    val similarity: Float = 0f,
    val question: String? = null
  )

  @Throws(IOException::class)
  fun startRtcSession(baseUrl: String): SessionResponse {
    val url = "$baseUrl/api/vision/rtc/session/start"
    val body = "{}".toRequestBody(jsonMediaType)
    val request = Request.Builder()
      .url(url)
      .post(body)
      .build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("HTTP ${response.code}: ${response.body?.string()}")
      }
      val json = response.body?.string() ?: throw IOException("Empty response")
      return gson.fromJson(json, SessionResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun transcribeAudio(baseUrl: String, audioFile: File): String {
    val url = "$baseUrl/api/realtime/transcribe"
    val requestBody = MultipartBody.Builder()
      .setType(MultipartBody.FORM)
      .addFormDataPart(
        "audio",
        "voice.wav",
        audioFile.asRequestBody("audio/wav".toMediaType())
      )
      .build()
    val request = Request.Builder()
      .url(url)
      .post(requestBody)
      .build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("ASR 请求失败 HTTP ${response.code}: ${response.body?.string()}")
      }
      val json = response.body?.string() ?: throw IOException("ASR 返回为空")
      val obj = gson.fromJson(json, JsonObject::class.java)
      return obj.get("text")?.asString?.trim() ?: ""
    }
  }

  @Throws(IOException::class)
  fun synthesizeText(baseUrl: String, text: String): Pair<ByteArray, String> {
    val url = "$baseUrl/api/realtime/tts"
    val body = gson.toJson(mapOf("text" to text)).toRequestBody(jsonMediaType)
    val request = Request.Builder()
      .url(url)
      .post(body)
      .build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("TTS 请求失败 HTTP ${response.code}: ${response.body?.string()}")
      }
      val bytes = response.body?.bytes() ?: throw IOException("TTS 返回为空")
      val contentType = response.header("Content-Type") ?: "audio/wav"
      return bytes to contentType
    }
  }

  @Throws(IOException::class)
  fun endRtcSession(baseUrl: String, sessionId: String) {
    val url = "$baseUrl/api/vision/rtc/session/$sessionId/end"
    val request = Request.Builder()
      .url(url)
      .post("{}".toRequestBody(jsonMediaType))
      .build()

    client.newCall(request).execute().close()
  }

  @Throws(IOException::class)
  fun generateFaultTree(baseUrl: String, req: GenerateRequest): GenerateResponse {
    val url = "$baseUrl/api/generate/"
    val body = gson.toJson(req).toRequestBody(jsonMediaType)
    val request = Request.Builder()
      .url(url)
      .post(body)
      .build()

    longClient.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("生成故障树失败 HTTP ${response.code}: ${response.body?.string()}")
      }
      val json = response.body?.string() ?: throw IOException("生成故障树返回为空")
      return gson.fromJson(json, GenerateResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun getProviders(baseUrl: String): List<Provider> {
    val url = "$baseUrl/api/llm/providers"
    val request = Request.Builder().url(url).get().build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("获取模型列表失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return emptyList()
      val resp = gson.fromJson(json, ProvidersResponse::class.java)
      return resp.providers?.filter { it.available } ?: emptyList()
    }
  }

  @Throws(IOException::class)
  fun listPipelines(baseUrl: String): List<String> {
    val url = "$baseUrl/api/knowledge/pipelines"
    val request = Request.Builder().url(url).get().build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("获取流水线失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return listOf("流水线1")
      val resp = gson.fromJson(json, PipelineResponse::class.java)
      return resp.pipelines?.takeIf { it.isNotEmpty() } ?: listOf("流水线1")
    }
  }

  @Throws(IOException::class)
  fun listDocuments(baseUrl: String): List<Document> {
    val url = "$baseUrl/api/knowledge/list"
    val request = Request.Builder().url(url).get().build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("获取文档失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return emptyList()
      return gson.fromJson(json, Array<Document>::class.java)?.toList() ?: emptyList()
    }
  }

  @Throws(IOException::class)
  fun clarifyProblem(baseUrl: String, req: ClarifyRequest): ClarifyResponse {
    val url = "$baseUrl/api/generate/clarify"
    val body = gson.toJson(req).toRequestBody(jsonMediaType)
    val request = Request.Builder().url(url).post(body).build()

    longClient.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("澄清失败 HTTP ${response.code}: ${response.body?.string()}")
      }
      val json = response.body?.string() ?: throw IOException("澄清返回为空")
      return gson.fromJson(json, ClarifyResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun clarifyLookup(baseUrl: String, req: ClarifyLookupRequest): ClarifyLookupResponse {
    val url = "$baseUrl/api/generate/clarify_lookup"
    val body = gson.toJson(req).toRequestBody(jsonMediaType)
    val request = Request.Builder().url(url).post(body).build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("查询澄清缓存失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return ClarifyLookupResponse()
      return gson.fromJson(json, ClarifyLookupResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun generateSteps(baseUrl: String, req: StepsRequest): StepsResponse {
    val url = "$baseUrl/api/generate/steps"
    val body = gson.toJson(req).toRequestBody(jsonMediaType)
    val request = Request.Builder().url(url).post(body).build()

    longClient.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("生成排查步骤失败 HTTP ${response.code}: ${response.body?.string()}")
      }
      val json = response.body?.string() ?: throw IOException("排查步骤返回为空")
      return gson.fromJson(json, StepsResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun stepsLookup(baseUrl: String, req: StepsLookupRequest): StepsLookupResponse {
    val url = "$baseUrl/api/generate/steps_lookup"
    val body = gson.toJson(req).toRequestBody(jsonMediaType)
    val request = Request.Builder().url(url).post(body).build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("查询排查步骤失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return StepsLookupResponse()
      return gson.fromJson(json, StepsLookupResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun diagnosisLookup(baseUrl: String, req: DiagnosisLookupRequest): DiagnosisLookupResponse {
    val url = "$baseUrl/api/generate/diagnosis_lookup"
    val body = gson.toJson(req).toRequestBody(jsonMediaType)
    val request = Request.Builder().url(url).post(body).build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("查询诊断案例失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return DiagnosisLookupResponse()
      return gson.fromJson(json, DiagnosisLookupResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun listFaultTrees(baseUrl: String): List<FaultTreeHistoryItem> {
    val url = "$baseUrl/api/generate/"
    val request = Request.Builder().url(url).get().build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("获取历史记录失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return emptyList()
      return gson.fromJson(json, Array<FaultTreeHistoryItem>::class.java)?.toList() ?: emptyList()
    }
  }

  @Throws(IOException::class)
  fun getFaultTree(baseUrl: String, treeId: String): GenerateResponse {
    val url = "$baseUrl/api/generate/$treeId"
    val request = Request.Builder().url(url).get().build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("获取故障树详情失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: throw IOException("故障树详情返回为空")
      return gson.fromJson(json, GenerateResponse::class.java)
    }
  }

  @Throws(IOException::class)
  fun lookupFaultTree(baseUrl: String, req: LookupFaultTreeRequest): LookupFaultTreeResponse {
    val url = "$baseUrl/api/generate/lookup"
    val body = gson.toJson(req).toRequestBody(jsonMediaType)
    val request = Request.Builder().url(url).post(body).build()

    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IOException("查找故障树失败 HTTP ${response.code}")
      }
      val json = response.body?.string() ?: return LookupFaultTreeResponse()
      return gson.fromJson(json, LookupFaultTreeResponse::class.java)
    }
  }
}
