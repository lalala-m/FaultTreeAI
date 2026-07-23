cmake_minimum_required(VERSION 3.16)
project(rtc_bot VERSION 1.0.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# SDK 路径
set(RTC_SDK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/sdk")
set(RTC_SDK_INCLUDE_DIR "${RTC_SDK_DIR}/include")
set(RTC_SDK_LIB_DIR "${RTC_SDK_DIR}/lib")

if(NOT EXISTS ${RTC_SDK_DIR})
    message(FATAL_ERROR "BytePlus RTC Linux SDK not found at ${RTC_SDK_DIR}. \
Please download BytePlusRTC_Linux_3.60.104.1400_x86_64.zip and extract it to ${RTC_SDK_DIR}, \
or run deploy_kylin.sh which will download it automatically.")
endif()

if(NOT EXISTS ${RTC_SDK_INCLUDE_DIR}/bytertc_engine.h)
    message(FATAL_ERROR "SDK headers not found at ${RTC_SDK_INCLUDE_DIR}/bytertc_engine.h. \
Please check SDK extraction layout. Expected: ${RTC_SDK_DIR}/{include,lib}.")
endif()

# 源文件
set(SOURCES
    src/c_api.cpp
    src/rtc_bot.cpp
    src/audio_pipeline.cpp
    src/video_pipeline.cpp
)

add_library(rtc_bot SHARED ${SOURCES})

target_include_directories(rtc_bot
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${RTC_SDK_INCLUDE_DIR}
        ${RTC_SDK_INCLUDE_DIR}/rtc
)

# 直接指定 SDK 运行时库路径（避免 find_library 对版本号后缀识别问题）
set(BYTEPLUS_RTC_LIB "${RTC_SDK_LIB_DIR}/libBytePlusRTC.so")
set(RTC_FFMPEG_LIB "${RTC_SDK_LIB_DIR}/libRTCFFmpeg.so")
set(BYTENN_LIB "${RTC_SDK_LIB_DIR}/libbytenn.so")
set(FDK_AAC_LIB "${RTC_SDK_LIB_DIR}/libfdk-aac.so.2")
set(BYTEPLUS_RTC_FFMPEG_AUDIO_EXT_LIB "${RTC_SDK_LIB_DIR}/libbytertc_ffmpeg_audio_extension.so")
set(BYTEPLUS_RTC_NICO_EXT_LIB "${RTC_SDK_LIB_DIR}/libbytertc_nico_extension.so")

target_link_libraries(rtc_bot
    PRIVATE
        ${BYTEPLUS_RTC_LIB}
        ${RTC_FFMPEG_LIB}
        ${BYTENN_LIB}
        ${FDK_AAC_LIB}
        ${BYTEPLUS_RTC_FFMPEG_AUDIO_EXT_LIB}
        ${BYTEPLUS_RTC_NICO_EXT_LIB}
        pthread
        dl
)

# 运行时库路径
set_target_properties(rtc_bot PROPERTIES
    BUILD_RPATH "${RTC_SDK_LIB_DIR}"
    INSTALL_RPATH "${RTC_SDK_LIB_DIR}"
)

# 安装规则
install(TARGETS rtc_bot
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
    RUNTIME DESTINATION bin
)
install(FILES include/rtc_bot_c_api.h DESTINATION include)
