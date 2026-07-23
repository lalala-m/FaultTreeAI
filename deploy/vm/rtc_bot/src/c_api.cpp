#include "rtc_bot_c_api.h"

#include <cstring>
#include <map>
#include <mutex>
#include <string>

#include "rtc_bot.h"

namespace {

std::mutex g_handle_mutex;
std::map<rtc_bot_handle_t, std::unique_ptr<rtc_bot::RtcBot>> g_bots;

}  // namespace

extern "C" {

RTC_BOT_API rtc_bot_handle_t rtc_bot_create(const char* app_id, const char* work_dir) {
    if (!app_id) return nullptr;

    auto bot = std::make_unique<rtc_bot::RtcBot>(app_id, work_dir ? work_dir : "");
    auto* raw = bot.get();

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    g_bots[raw] = std::move(bot);
    return raw;
}

RTC_BOT_API int rtc_bot_destroy(rtc_bot_handle_t handle) {
    if (!handle) return -1;

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    auto it = g_bots.find(handle);
    if (it == g_bots.end()) return -1;

    it->second->LeaveRoom();
    g_bots.erase(it);
    return 0;
}

RTC_BOT_API int rtc_bot_join_room(rtc_bot_handle_t handle,
                                  const char* token,
                                  const char* room_id,
                                  const char* user_id) {
    if (!handle || !token || !room_id || !user_id) return -1;

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    auto it = g_bots.find(handle);
    if (it == g_bots.end()) return -1;

    bool ok = it->second->JoinRoom(token, room_id, user_id);
    return ok ? 0 : -1;
}

RTC_BOT_API int rtc_bot_leave_room(rtc_bot_handle_t handle) {
    if (!handle) return -1;

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    auto it = g_bots.find(handle);
    if (it == g_bots.end()) return -1;

    it->second->LeaveRoom();
    return 0;
}

RTC_BOT_API int rtc_bot_push_audio(rtc_bot_handle_t handle,
                                   const uint8_t* pcm_data,
                                   int data_len,
                                   int sample_rate,
                                   int channels,
                                   int bits_per_sample) {
    if (!handle || !pcm_data || data_len <= 0) return -1;

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    auto it = g_bots.find(handle);
    if (it == g_bots.end()) return -1;

    bool ok = it->second->PushAudio(pcm_data, data_len, sample_rate, channels, bits_per_sample);
    return ok ? 0 : -1;
}

RTC_BOT_API int rtc_bot_pop_audio(rtc_bot_handle_t handle,
                                  uint8_t* out_buf,
                                  int buf_len,
                                  int* sample_rate,
                                  int* channels,
                                  int* bits_per_sample) {
    if (!handle || !out_buf || buf_len <= 0) return -1;

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    auto it = g_bots.find(handle);
    if (it == g_bots.end()) return -1;

    int out_len = 0;
    bool ok = it->second->PopAudio(out_buf, buf_len, sample_rate, channels,
                                   bits_per_sample, &out_len);
    return ok ? out_len : -1;
}

RTC_BOT_API int rtc_bot_pop_video_frame(rtc_bot_handle_t handle,
                                        uint8_t* out_buf,
                                        int buf_len,
                                        int* width,
                                        int* height,
                                        int64_t* timestamp_us) {
    if (!handle || !out_buf || buf_len <= 0) return -1;

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    auto it = g_bots.find(handle);
    if (it == g_bots.end()) return -1;

    int out_len = 0;
    bool ok = it->second->PopVideoFrame(out_buf, buf_len, width, height,
                                        timestamp_us, &out_len);
    return ok ? out_len : -1;
}

RTC_BOT_API int rtc_bot_get_state(rtc_bot_handle_t handle, char* out_json, int buf_len) {
    if (!handle || !out_json || buf_len <= 0) return -1;

    std::lock_guard<std::mutex> lock(g_handle_mutex);
    auto it = g_bots.find(handle);
    if (it == g_bots.end()) return -1;

    std::string state = it->second->GetStateString();
    int copy_len = static_cast<int>(state.size());
    if (copy_len >= buf_len) copy_len = buf_len - 1;
    std::memcpy(out_json, state.data(), copy_len);
    out_json[copy_len] = '\0';
    return copy_len;
}

RTC_BOT_API const char* rtc_bot_version(void) {
    static const char* kVersion = "1.0.0";
    return kVersion;
}

}  // extern "C"
