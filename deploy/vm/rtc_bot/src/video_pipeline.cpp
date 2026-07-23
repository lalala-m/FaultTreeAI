#include "video_pipeline.h"

#include <algorithm>
#include <cstring>

namespace rtc_bot {

void VideoPipeline::Push(const uint8_t* data, int len,
                         int width, int height, int64_t timestamp_us) {
    if (!data || len <= 0 || width <= 0 || height <= 0) return;

    std::lock_guard<std::mutex> lock(mutex_);
    latest_frame_.emplace();
    latest_frame_->data.assign(data, data + len);
    latest_frame_->width = width;
    latest_frame_->height = height;
    latest_frame_->timestamp_us = timestamp_us;
}

bool VideoPipeline::Pop(uint8_t* out_buf, int buf_len,
                        int* width, int* height, int64_t* timestamp_us,
                        int* out_len) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!latest_frame_) {
        return false;
    }

    int copy_len = std::min(buf_len, static_cast<int>(latest_frame_->data.size()));
    if (copy_len > 0 && out_buf) {
        std::memcpy(out_buf, latest_frame_->data.data(), copy_len);
    }
    if (width) *width = latest_frame_->width;
    if (height) *height = latest_frame_->height;
    if (timestamp_us) *timestamp_us = latest_frame_->timestamp_us;
    if (out_len) *out_len = copy_len;
    return true;
}

void VideoPipeline::Clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    latest_frame_.reset();
}

std::vector<uint8_t> ConvertVideoFrameToRgba(IVideoFrame* frame) {
    if (!frame) return {};

    int width = frame->width();
    int height = frame->height();
    if (width <= 0 || height <= 0) return {};

    bytertc::VideoPixelFormat fmt = frame->pixelFormat();

    std::vector<uint8_t> rgba(width * height * 4, 0);

    if (fmt == bytertc::kVideoPixelFormatRGBA) {
        uint8_t* src = frame->planeData(0);
        if (!src) return {};
        int stride = frame->planeStride(0);
        if (stride <= 0) stride = width * 4;

        for (int row = 0; row < height; ++row) {
            const uint8_t* src_row = src + row * stride;
            uint8_t* dst_row = rgba.data() + row * width * 4;
            std::memcpy(dst_row, src_row, width * 4);
        }
        return rgba;
    }

    if (fmt == bytertc::kVideoPixelFormatI420) {
        uint8_t* y_plane = frame->planeData(0);
        uint8_t* u_plane = frame->planeData(1);
        uint8_t* v_plane = frame->planeData(2);
        if (!y_plane || !u_plane || !v_plane) return {};

        int y_stride = frame->planeStride(0);
        int u_stride = frame->planeStride(1);
        int v_stride = frame->planeStride(2);
        if (y_stride <= 0) y_stride = width;
        if (u_stride <= 0) u_stride = width / 2;
        if (v_stride <= 0) v_stride = width / 2;

        for (int row = 0; row < height; ++row) {
            for (int col = 0; col < width; ++col) {
                int y = y_plane[row * y_stride + col];
                int u = u_plane[(row / 2) * u_stride + (col / 2)] - 128;
                int v = v_plane[(row / 2) * v_stride + (col / 2)] - 128;

                int r = y + static_cast<int>(1.402 * v);
                int g = y - static_cast<int>(0.344 * u) - static_cast<int>(0.714 * v);
                int b = y + static_cast<int>(1.772 * u);

                r = std::clamp(r, 0, 255);
                g = std::clamp(g, 0, 255);
                b = std::clamp(b, 0, 255);

                int idx = (row * width + col) * 4;
                rgba[idx + 0] = static_cast<uint8_t>(r);
                rgba[idx + 1] = static_cast<uint8_t>(g);
                rgba[idx + 2] = static_cast<uint8_t>(b);
                rgba[idx + 3] = 255;
            }
        }
        return rgba;
    }

    // 其他格式暂不处理
    return {};
}

}  // namespace rtc_bot
