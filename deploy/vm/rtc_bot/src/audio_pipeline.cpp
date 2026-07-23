#include "audio_pipeline.h"

#include <algorithm>
#include <cstring>

namespace rtc_bot {

AudioPipeline::AudioPipeline(int max_size) : max_size_(max_size) {}

void AudioPipeline::Push(const uint8_t* data, int len,
                         int sample_rate, int channels, int bits_per_sample) {
    if (!data || len <= 0) return;

    std::lock_guard<std::mutex> lock(mutex_);
    if (static_cast<int>(queue_.size()) >= max_size_) {
        queue_.pop_front();
    }
    Frame frame;
    frame.data.assign(data, data + len);
    frame.sample_rate = sample_rate;
    frame.channels = channels;
    frame.bits_per_sample = bits_per_sample;
    queue_.push_back(std::move(frame));
    cv_.notify_one();
}

bool AudioPipeline::Pop(uint8_t* out_buf, int buf_len,
                        int* sample_rate, int* channels, int* bits_per_sample,
                        int* out_len) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (queue_.empty()) {
        return false;
    }
    auto frame = std::move(queue_.front());
    queue_.pop_front();
    lock.unlock();

    int copy_len = std::min(buf_len, static_cast<int>(frame.data.size()));
    if (copy_len > 0 && out_buf) {
        std::memcpy(out_buf, frame.data.data(), copy_len);
    }
    if (sample_rate) *sample_rate = frame.sample_rate;
    if (channels) *channels = frame.channels;
    if (bits_per_sample) *bits_per_sample = frame.bits_per_sample;
    if (out_len) *out_len = copy_len;
    return true;
}

bool AudioPipeline::PopMerge(uint8_t* out_buf, int buf_len,
                             int target_sample_rate, int target_channels,
                             int* out_len) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (queue_.empty()) {
        return false;
    }

    // 简单策略：取出一帧并转换
    auto frame = std::move(queue_.front());
    queue_.pop_front();
    lock.unlock();

    if (frame.sample_rate == target_sample_rate && frame.channels == target_channels) {
        int copy_len = std::min(buf_len, static_cast<int>(frame.data.size()));
        if (copy_len > 0 && out_buf) {
            std::memcpy(out_buf, frame.data.data(), copy_len);
        }
        if (out_len) *out_len = copy_len;
        return true;
    }

    auto converted = ResamplePcm16(
        frame.data.data(), static_cast<int>(frame.data.size()),
        frame.sample_rate, frame.channels,
        target_sample_rate, target_channels);

    int copy_len = std::min(buf_len, static_cast<int>(converted.size()));
    if (copy_len > 0 && out_buf) {
        std::memcpy(out_buf, converted.data(), copy_len);
    }
    if (out_len) *out_len = copy_len;
    return true;
}

void AudioPipeline::Clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::deque<Frame> empty;
    queue_.swap(empty);
}

size_t AudioPipeline::Size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.size();
}

std::vector<uint8_t> ResamplePcm16(const uint8_t* data, int len,
                                   int src_rate, int src_channels,
                                   int dst_rate, int dst_channels) {
    if (!data || len <= 0 || src_rate <= 0 || dst_rate <= 0) {
        return {};
    }

    int src_samples = len / (2 * src_channels);
    if (src_samples <= 0) return {};

    // 先转单声道
    std::vector<int16_t> mono;
    mono.reserve(src_samples);
    const int16_t* src = reinterpret_cast<const int16_t*>(data);
    for (int i = 0; i < src_samples; ++i) {
        int32_t sum = 0;
        for (int c = 0; c < src_channels; ++c) {
            sum += src[i * src_channels + c];
        }
        mono.push_back(static_cast<int16_t>(sum / src_channels));
    }

    // 再重采样
    int dst_samples = static_cast<int>(mono.size() * static_cast<double>(dst_rate) / src_rate);
    if (dst_samples <= 0) return {};

    std::vector<int16_t> out;
    out.reserve(dst_samples * dst_channels);
    for (int i = 0; i < dst_samples; ++i) {
        double src_pos = static_cast<double>(i) * src_rate / dst_rate;
        int idx = static_cast<int>(src_pos);
        double frac = src_pos - idx;
        int16_t v0 = mono[std::min(idx, static_cast<int>(mono.size()) - 1)];
        int16_t v1 = mono[std::min(idx + 1, static_cast<int>(mono.size()) - 1)];
        int16_t v = static_cast<int16_t>(v0 * (1.0 - frac) + v1 * frac);
        for (int c = 0; c < dst_channels; ++c) {
            out.push_back(v);
        }
    }

    std::vector<uint8_t> result(out.size() * sizeof(int16_t));
    std::memcpy(result.data(), out.data(), result.size());
    return result;
}

}  // namespace rtc_bot
