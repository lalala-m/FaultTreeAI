#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <vector>

#include "rtc_bot.h"

namespace rtc_bot {

// 线程安全的 PCM 帧队列
class AudioPipeline {
public:
    explicit AudioPipeline(int max_size = 300);  // 约 6 秒 @ 16kHz mono 16bit

    void Push(const uint8_t* data, int len,
              int sample_rate, int channels, int bits_per_sample);
    bool Pop(uint8_t* out_buf, int buf_len,
             int* sample_rate, int* channels, int* bits_per_sample,
             int* out_len);

    // 合并读取：将队列中的数据按目标格式重采样/混音后写入 out_buf
    bool PopMerge(uint8_t* out_buf, int buf_len,
                  int target_sample_rate, int target_channels,
                  int* out_len);

    void Clear();
    size_t Size() const;

private:
    struct Frame {
        std::vector<uint8_t> data;
        int sample_rate;
        int channels;
        int bits_per_sample;
    };

    int max_size_;
    std::deque<Frame> queue_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
};

// 简单的 16-bit PCM 重采样（线性插值）
std::vector<uint8_t> ResamplePcm16(const uint8_t* data, int len,
                                   int src_rate, int src_channels,
                                   int dst_rate, int dst_channels);

}  // namespace rtc_bot
