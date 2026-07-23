#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "bytertc_engine.h"
#include "bytertc_room.h"
#include "bytertc_engine_event_handler.h"
#include "bytertc_room_event_handler.h"
#include "rtc/bytertc_audio_frame.h"
#include "rtc/bytertc_video_defines.h"
#include "rtc/bytertc_video_frame.h"

namespace rtc_bot {

using bytertc::IRTCEngine;
using bytertc::IRTCRoom;
using bytertc::IAudioFrameObserver;
using bytertc::IAudioFrame;
using bytertc::IVideoSink;
using bytertc::IVideoFrame;

struct PcmFrame {
    std::vector<uint8_t> data;
    int sample_rate = 16000;
    int channels = 1;
    int bits_per_sample = 16;
};

struct VideoFrame {
    std::vector<uint8_t> data;
    int width = 0;
    int height = 0;
    int64_t timestamp_us = 0;
};

class AudioPipeline;
class VideoPipeline;

class RtcBot : public bytertc::IRTCEngineEventHandler,
               public bytertc::IRTCRoomEventHandler,
               public IAudioFrameObserver,
               public IVideoSink {
public:
    explicit RtcBot(const std::string& app_id, const std::string& work_dir);
    ~RtcBot() override;

    bool JoinRoom(const std::string& token,
                  const std::string& room_id,
                  const std::string& user_id);
    void LeaveRoom();

    // 状态
    enum class State { kIdle, kJoining, kJoined, kLeaving, kError };
    State GetState() const { return state_.load(); }
    std::string GetStateString() const;
    std::string GetRoomId() const { return room_id_; }
    std::string GetUserId() const { return user_id_; }

    // 音频输出（TTS 写入）
    bool PushAudio(const uint8_t* data, int len,
                   int sample_rate, int channels, int bits_per_sample);
    // 音频输入（用户语音）
    bool PopAudio(uint8_t* out_buf, int buf_len,
                  int* sample_rate, int* channels, int* bits_per_sample,
                  int* out_len);

    // 视频帧
    bool PopVideoFrame(uint8_t* out_buf, int buf_len,
                       int* width, int* height, int64_t* timestamp_us,
                       int* out_len);

    // IRTCEngineEventHandler
    void onError(int error_code) override;
    void onWarning(int warning_code) override;
    void onConnectionStateChanged(bytertc::ConnectionState state) override;

    // IRTCRoomEventHandler
    void onRoomStateChanged(const char* room_id, const char* uid,
                            int state, const char* extra_info) override;
    void onUserJoined(const bytertc::UserInfo& user_info) override;
    void onUserLeave(const char* uid, bytertc::UserOfflineReason reason) override;
    void onUserPublishStreamVideo(const char* stream_id,
                                  const bytertc::StreamInfo& stream_info,
                                  bool is_publish) override;
    void onUserPublishStreamAudio(const char* stream_id,
                                  const bytertc::StreamInfo& stream_info,
                                  bool is_publish) override;
    void onVideoPublishStateChanged(const char* stream_id,
                                    const bytertc::StreamInfo& stream_info,
                                    bytertc::PublishState state,
                                    bytertc::PublishStateChangeReason reason) override;
    void onAudioPublishStateChanged(const char* stream_id,
                                    const bytertc::StreamInfo& stream_info,
                                    bytertc::PublishState state,
                                    bytertc::PublishStateChangeReason reason) override;

    // IAudioFrameObserver
    void onRecordAudioFrameOriginal(const IAudioFrame& audio_frame) override {}
    void onRecordAudioFrame(const IAudioFrame& audio_frame) override {}
    void onPlaybackAudioFrame(const IAudioFrame& audio_frame) override {}
    void onRemoteUserAudioFrame(const char* stream_id,
                                const bytertc::StreamInfo& stream_info,
                                const IAudioFrame& audio_frame) override;
    void onMixedAudioFrame(const IAudioFrame& audio_frame) override {}
    void onRecordScreenAudioFrame(const IAudioFrame& audio_frame) override {}
    void onCaptureMixedAudioFrame(const IAudioFrame& audio_frame) override {}

    // IVideoSink
    bool onFrame(IVideoFrame* video_frame) override;
    int getRenderElapse() override { return 0; }

private:
    void RunAudioPushThread();
    void SubscribeUserIfNeeded(const std::string& uid);

    std::string app_id_;
    std::string work_dir_;
    std::string room_id_;
    std::string user_id_;
    std::string remote_user_id_;

    std::atomic<State> state_{State::kIdle};
    std::atomic<bool> running_{false};
    std::atomic<bool> joined_{false};

    IRTCEngine* engine_ = nullptr;
    IRTCRoom* room_ = nullptr;

    std::unique_ptr<AudioPipeline> audio_in_;   // 远端用户音频输入
    std::unique_ptr<AudioPipeline> audio_out_;  // AI 语音输出
    std::unique_ptr<VideoPipeline> video_in_;

    std::thread audio_push_thread_;

    mutable std::mutex mutex_;
    int last_error_code_ = 0;
    std::string last_error_msg_;
};

}  // namespace rtc_bot
