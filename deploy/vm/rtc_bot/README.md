# RTC AI Bot（BytePlus RTC Linux SDK）

本目录包含 RTC AI Bot 的 C++ 封装源码，用于在 Linux/Kylin 服务端以 `ai_user_id` 身份加入 RTC 房间，实现：

- 订阅用户摄像头视频流，供 VLM 分析
- 订阅用户麦克风音频流，供 ASR 识别
- 将 AI 回复通过 TTS 合成为 PCM 音频，推送到 RTC 房间

## 目录结构

```
rtc_bot/
├── CMakeLists.txt          # 构建脚本
├── include/                # C++ 头文件
├── src/                    # C++ 源文件
├── sdk/                    # BytePlus RTC Linux SDK（二进制，不提交到 Git）
└── build/                  # 编译输出目录
```

## 准备 SDK

### 方式一：自动下载（推荐）

运行 `deploy/vm/scripts/deploy_kylin.sh` 时会自动尝试下载并解压 SDK。

### 方式二：手动放置

1. 从 BytePlus RTC 官方文档下载 Linux x86_64 SDK：
   `BytePlusRTC_Linux_3.60.104.1400_x86_64.zip`
2. 将 zip 放到 `deploy/vm/rtc_bot/` 目录下
3. 运行部署脚本或手动解压：

```bash
cd deploy/vm/rtc_bot
unzip BytePlusRTC_Linux_3.60.104.1400_x86_64.zip
# 若解压后多一层目录，整理为 sdk/include 和 sdk/lib
mkdir -p build && cd build
cmake ..
make -j$(nproc)
```

## 编译

```bash
cd deploy/vm/rtc_bot
mkdir -p build && cd build
cmake ..
make -j$(nproc)
```

成功后将生成 `build/librtc_bot.so`。

## 配置

在 `deploy/vm/.env` 中启用 Bot：

```env
RTC_BOT_ENABLED=true
RTC_BOT_SO_PATH=deploy/vm/rtc_bot/build/librtc_bot.so
RTC_ASR_PROVIDER=baidu_vop
RTC_TTS_PROVIDER=baidu_vop
```

并确保已配置 `BAIDU_VOP_API_KEY`、`BAIDU_VOP_SECRET_KEY` 或 OpenAI 相关密钥。

## 运行

启动后端服务时会自动设置 `LD_LIBRARY_PATH` 并加载 `.so`：

```bash
cd deploy/vm
./scripts/start_kylin.sh
```

当客户端调用 `/api/vision/rtc/session/start` 时，后端会 fork 一个 Bot 子进程进房。
