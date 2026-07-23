#pragma once

#include <cstdint>
#include <cstddef>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef _WIN32
    #ifdef RTC_BOT_EXPORTS
        #define RTC_BOT_API __declspec(dllexport)
    #else
        #define RTC_BOT_API __declspec(dllimport)
    #endif
#else
    #define RTC_BOT_API __attribute__((visibility("default")))
#endif

/**
 * @brief Bot 实例句柄
 */
typedef void* rtc_bot_handle_t;

/**
 * @brief 创建 Bot 实例
 * @param app_id BytePlus RTC AppID
 * @param work_dir 工作目录（用于日志等）
 * @return 非 NULL 句柄表示成功
 */
RTC_BOT_API rtc_bot_handle_t rtc_bot_create(const char* app_id, const char* work_dir);

/**
 * @brief 销毁 Bot 实例
 */
RTC_BOT_API int rtc_bot_destroy(rtc_bot_handle_t handle);

/**
 * @brief 加入 RTC 房间
 * @param token 进房 Token
 * @param room_id 房间 ID
 * @param user_id Bot 用户 ID（即 ai_user_id）
 */
RTC_BOT_API int rtc_bot_join_room(rtc_bot_handle_t handle,
                                  const char* token,
                                  const char* room_id,
                                  const char* user_id);

/**
 * @brief 离开 RTC 房间
 */
RTC_BOT_API int rtc_bot_leave_room(rtc_bot_handle_t handle);

/**
 * @brief 推送 AI 语音 PCM 数据到房间
 * @param pcm_data PCM 数据指针
 * @param data_len 数据长度（字节）
 * @param sample_rate 采样率，如 16000
 * @param channels 声道数，如 1
 * @param bits_per_sample 位深，如 16
 */
RTC_BOT_API int rtc_bot_push_audio(rtc_bot_handle_t handle,
                                   const uint8_t* pcm_data,
                                   int data_len,
                                   int sample_rate,
                                   int channels,
                                   int bits_per_sample);

/**
 * @brief 读取用户语音 PCM 数据
 * @param out_buf 输出缓冲区
 * @param buf_len 缓冲区长度（字节）
 * @param sample_rate 输出采样率
 * @param channels 输出声道数
 * @param bits_per_sample 输出位深
 * @return 实际读取的字节数，<=0 表示无数据
 */
RTC_BOT_API int rtc_bot_pop_audio(rtc_bot_handle_t handle,
                                  uint8_t* out_buf,
                                  int buf_len,
                                  int* sample_rate,
                                  int* channels,
                                  int* bits_per_sample);

/**
 * @brief 读取一帧视频数据（RGBA 格式）
 * @param out_buf 输出缓冲区
 * @param buf_len 缓冲区长度（字节）
 * @param width 输出宽度
 * @param height 输出高度
 * @param timestamp_us 输出时间戳（微秒）
 * @return 实际读取的字节数，<=0 表示无数据
 */
RTC_BOT_API int rtc_bot_pop_video_frame(rtc_bot_handle_t handle,
                                        uint8_t* out_buf,
                                        int buf_len,
                                        int* width,
                                        int* height,
                                        int64_t* timestamp_us);

/**
 * @brief 获取 Bot 状态 JSON 字符串
 * @param out_json 输出缓冲区
 * @param buf_len 缓冲区长度
 * @return 实际写入长度
 */
RTC_BOT_API int rtc_bot_get_state(rtc_bot_handle_t handle, char* out_json, int buf_len);

/**
 * @brief 获取 SDK 版本字符串
 */
RTC_BOT_API const char* rtc_bot_version(void);

#ifdef __cplusplus
}
#endif
