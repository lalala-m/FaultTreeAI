#pragma once

#include <cstdint>
#include <mutex>
#include <optional>

#include "rtc_bot.h"

namespace rtc_bot {

// 线程安全的单帧视频缓冲区
class VideoPipeline {
public:
    void Push(const uint8_t* data, int len,
              int width, int height, int64_t timestamp_us);
    bool Pop(uint8_t* out_buf, int buf_len,
             int* width, int* height, int64_t* timestamp_us,
             int* out_len);
    void Clear();

private:
    struct Frame {
        std::vector<uint8_t> data;
        int width = 0;
        int height = 0;
        int64_t timestamp_us = 0;
    };

    mutable std::mutex mutex_;
    std::optional<Frame> latest_frame_;
};

// I420/RGBA 转换辅助函数
std::vector<uint8_t> ConvertVideoFrameToRgba(IVideoFrame* frame);

}  // namespace rtc_bot
