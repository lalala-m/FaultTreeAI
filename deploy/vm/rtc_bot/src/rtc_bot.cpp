#include "rtc_bot.h"

#include <chrono>
#include <cstring>
#include <sstream>
#include <thread>

#include "audio_pipeline.h"
#include "video_pipeline.h"
#include "rtc/bytertc_audio_defines.h"

namespace rtc_bot {

namespace {

std::string StateToString(RtcBot::State state) {
    switch (state) {
        case RtcBot::State::kIdle: return "idle";
        case RtcBot::State::kJoining: return "joining";
        case RtcBot::State::kJoined: return "joined";
        case RtcBot::State::kLeaving: return "leaving";
        case RtcBot::State::kError: return "error";
    }
    return "unknown";
}

}  // namespace

RtcBot::RtcBot(const std::string& app_id, const std::string& work_dir)
    : app_id_(app_id), work_dir_(work_dir) {
    audio_in_ = std::make_unique<AudioPipeline>(300);
    audio_out_ = std::make_unique<AudioPipeline>(600);
    video_in_ = std::make_unique<VideoPipeline>();
}

RtcBot::~RtcBot() {
    LeaveRoom();
}

bool RtcBot::JoinRoom(const std::string& token,
                      const std::string& room_id,
                      const std::string& user_id) {
    if (state_.load() != State::kIdle) {
        return false;
    }

    state_ = State::kJoining;
    room_id_ = room_id;
    user_id_ = user_id;

    bytertc::EngineConfig config;
    config.app_id = app_id_.c_str();

    engine_ = bytertc::IRTCEngine::createRTCEngine(config, this);
    if (!engine_) {
        state_ = State::kError;
        return false;
    }

    room_ = engine_->createRTCRoom(room_id_.c_str());
    if (!room_) {
        bytertc::IRTCEngine::destroyRTCEngine();
        engine_ = nullptr;
        state_ = State::kError;
        return false;
    }

    room_->setRTCRoomEventHandler(this);

    bytertc::UserInfo user_info;
    user_info.uid = user_id_.c_str();
    user_info.extra_info = "";

    bytertc::RTCRoomConfig room_config;
    room_config.room_profile_type = bytertc::kRoomProfileTypeCommunication;
    room_config.stream_id = nullptr;
    room_config.is_auto_publish_audio = true;
    room_config.is_auto_publish_video = false;
    room_config.is_auto_subscribe_audio = true;
    room_config.is_auto_subscribe_video = true;

    int ret = room_->joinRoom(token.c_str(), user_info, true, room_config);
    if (ret != 0) {
        state_ = State::kError;
        return false;
    }

    // 启用外部音频源用于 TTS 推送
    engine_->setAudioSourceType(bytertc::kAudioSourceTypeExternal);

    // 注册音频帧观察器，接收远端用户音频
    engine_->registerAudioFrameObserver(this);
    bytertc::AudioFormat format;
    format.sample_rate = bytertc::kAudioSampleRate16000;
    format.channel = bytertc::kAudioChannelMono;
    format.samples_per_call = 0;
    engine_->enableAudioFrameCallback(bytertc::AudioFrameCallbackMethod::kRemoteUser, format);

    running_ = true;
    audio_push_thread_ = std::thread(&RtcBot::RunAudioPushThread, this);

    return true;
}

void RtcBot::LeaveRoom() {
    if (!room_ && !engine_) {
        return;
    }

    running_ = false;
    if (audio_push_thread_.joinable()) {
        audio_push_thread_.join();
    }

    state_ = State::kLeaving;
    if (room_) {
        room_->leaveRoom();
        room_->destroy();
        room_ = nullptr;
    }
    if (engine_) {
        bytertc::IRTCEngine::destroyRTCEngine();
        engine_ = nullptr;
    }
    state_ = State::kIdle;
    joined_ = false;

    if (audio_in_) audio_in_->Clear();
    if (audio_out_) audio_out_->Clear();
    if (video_in_) video_in_->Clear();
}

std::string RtcBot::GetStateString() const {
    std::ostringstream oss;
    oss << "{"
        << "\"state\":\"" << StateToString(state_.load()) << "\","
        << "\"room_id\":\"" << room_id_ << "\","
        << "\"user_id\":\"" << user_id_ << "\","
        << "\"remote_user_id\":\"" << remote_user_id_ << "\","
        << "\"joined\":" << (joined_.load() ? "true" : "false") << ","
        << "\"last_error_code\":" << last_error_code_ << ","
        << "\"last_error_msg\":\"" << last_error_msg_ << "\""
        << "}";
    return oss.str();
}

bool RtcBot::PushAudio(const uint8_t* data, int len,
                       int sample_rate, int channels, int bits_per_sample) {
    if (!audio_out_) return false;
    audio_out_->Push(data, len, sample_rate, channels, bits_per_sample);
    return true;
}

bool RtcBot::PopAudio(uint8_t* out_buf, int buf_len,
                      int* sample_rate, int* channels, int* bits_per_sample,
                      int* out_len) {
    if (!audio_in_) return false;
    return audio_in_->Pop(out_buf, buf_len, sample_rate, channels, bits_per_sample, out_len);
}

bool RtcBot::PopVideoFrame(uint8_t* out_buf, int buf_len,
                           int* width, int* height, int64_t* timestamp_us,
                           int* out_len) {
    if (!video_in_) return false;
    return video_in_->Pop(out_buf, buf_len, width, height, timestamp_us, out_len);
}

void RtcBot::RunAudioPushThread() {
    const int kSampleRate = 16000;
    const int kChannels = 1;
    const int kBitsPerSample = 16;
    const int kFrameMs = 20;
    const int kFrameSamples = kSampleRate * kFrameMs / 1000;
    const int kFrameBytes = kFrameSamples * kChannels * (kBitsPerSample / 8);

    std::vector<uint8_t> buf(kFrameBytes);

    while (running_.load()) {
        int out_len = 0;
        bool ok = audio_out_->PopMerge(buf.data(), kFrameBytes,
                                       kSampleRate, kChannels, &out_len);
        if (ok && out_len > 0) {
            // 构建 IAudioFrame 并推送
            bytertc::AudioFrameBuilder builder;
            builder.data = buf.data();
            builder.data_size = out_len;
            builder.sample_rate = static_cast<bytertc::AudioSampleRate>(kSampleRate);
            builder.channel = static_cast<bytertc::AudioChannel>(kChannels);

            bytertc::IAudioFrame* frame = bytertc::buildAudioFrame(builder);
            if (frame) {
                engine_->pushExternalAudioFrame(frame);
                frame->release();
            }
        } else {
            // 无数据时推送静音帧，保持音频流活跃
            std::memset(buf.data(), 0, kFrameBytes);
            bytertc::AudioFrameBuilder builder;
            builder.data = buf.data();
            builder.data_size = kFrameBytes;
            builder.sample_rate = static_cast<bytertc::AudioSampleRate>(kSampleRate);
            builder.channel = static_cast<bytertc::AudioChannel>(kChannels);

            bytertc::IAudioFrame* frame = bytertc::buildAudioFrame(builder);
            if (frame) {
                engine_->pushExternalAudioFrame(frame);
                frame->release();
            }
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(kFrameMs));
    }
}

void RtcBot::SubscribeUserIfNeeded(const std::string& uid) {
    if (uid.empty() || uid == user_id_) return;
    remote_user_id_ = uid;

    if (room_) {
        room_->subscribeStreamVideo(uid.c_str(), true);
        room_->subscribeStreamAudio(uid.c_str(), true);
    }

    // 绑定视频 sink
    bytertc::RemoteVideoSinkConfig config;
    config.pixel_format = bytertc::kVideoPixelFormatRGBA;
    config.position = bytertc::kRemoteVideoSinkPositionAfterPostProcess;
    engine_->setRemoteVideoSink(uid.c_str(), this, config);
}

// Engine callbacks
void RtcBot::onError(int error_code) {
    std::lock_guard<std::mutex> lock(mutex_);
    last_error_code_ = error_code;
    last_error_msg_ = "engine error";
}

void RtcBot::onWarning(int warning_code) {
    (void)warning_code;
}

void RtcBot::onConnectionStateChanged(bytertc::ConnectionState state) {
    (void)state;
}

// Room callbacks
void RtcBot::onRoomStateChanged(const char* room_id, const char* uid,
                                int state, const char* extra_info) {
    (void)uid;
    (void)extra_info;
    if (room_id && room_id_ != room_id) return;

    if (state == 0) {
        joined_ = true;
        state_ = State::kJoined;
        // 进房成功后发布音频
        if (room_) {
            room_->publishStreamAudio(true);
        }
    } else {
        state_ = State::kError;
    }
}

void RtcBot::onUserJoined(const bytertc::UserInfo& user_info) {
    if (user_info.uid && user_info.uid != user_id_) {
        SubscribeUserIfNeeded(user_info.uid);
    }
}

void RtcBot::onUserLeave(const char* uid, bytertc::UserOfflineReason reason) {
    (void)reason;
    if (uid && uid == remote_user_id_) {
        remote_user_id_.clear();
    }
}

void RtcBot::onUserPublishStreamVideo(const char* stream_id,
                                      const bytertc::StreamInfo& stream_info,
                                      bool is_publish) {
    (void)stream_id;
    if (is_publish && stream_info.user_id) {
        SubscribeUserIfNeeded(stream_info.user_id);
    }
}

void RtcBot::onUserPublishStreamAudio(const char* stream_id,
                                      const bytertc::StreamInfo& stream_info,
                                      bool is_publish) {
    (void)stream_id;
    (void)stream_info;
    (void)is_publish;
}

void RtcBot::onVideoPublishStateChanged(const char* stream_id,
                                        const bytertc::StreamInfo& stream_info,
                                        bytertc::PublishState state,
                                        bytertc::PublishStateChangeReason reason) {
    (void)stream_id;
    (void)stream_info;
    (void)state;
    (void)reason;
}

void RtcBot::onAudioPublishStateChanged(const char* stream_id,
                                        const bytertc::StreamInfo& stream_info,
                                        bytertc::PublishState state,
                                        bytertc::PublishStateChangeReason reason) {
    (void)stream_id;
    (void)stream_info;
    (void)state;
    (void)reason;
}

// Audio callback
void RtcBot::onRemoteUserAudioFrame(const char* stream_id,
                                    const bytertc::StreamInfo& stream_info,
                                    const IAudioFrame& audio_frame) {
    (void)stream_id;
    (void)stream_info;
    if (!audio_in_) return;

    int sample_rate = static_cast<int>(audio_frame.sampleRate());
    int channels = static_cast<int>(audio_frame.channel());
    int bits = 16;  // PCM16
    int data_size = audio_frame.dataSize();
    const uint8_t* data = audio_frame.data();

    if (data && data_size > 0) {
        audio_in_->Push(data, data_size, sample_rate, channels, bits);
    }
}

// Video callback
bool RtcBot::onFrame(IVideoFrame* video_frame) {
    if (!video_frame || !video_in_) return false;

    auto rgba = ConvertVideoFrameToRgba(video_frame);
    if (!rgba.empty()) {
        video_in_->Push(rgba.data(), static_cast<int>(rgba.size()),
                        video_frame->width(), video_frame->height(),
                        video_frame->timestampUs());
    }
    return true;
}

}  // namespace rtc_bot
