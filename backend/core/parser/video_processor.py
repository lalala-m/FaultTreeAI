"""
视频文件解析器
流程：
1. 用 ffmpeg 提取音频为 WAV（16kHz, 16bit, 单声道）
2. 如果音频过长，按 60 秒分段（兼容百度 VOP 60 秒限制）
3. 调用 ASR（OpenAI Whisper / 百度语音）转文字
4. 按段落分块返回
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path
from typing import List

import httpx
import numpy as np

from backend.config import settings

VIDEO_EXTENSIONS = {
    ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".m4v", ".webm",
}


def _which_ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def _extract_audio(video_path: str, output_wav: str) -> None:
    """提取音频为 16kHz 单声道 WAV"""
    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        output_wav,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def _split_audio(input_wav: str, output_dir: str, segment_sec: int = 60) -> List[str]:
    """把长音频按 segment_sec 秒分段。百度 VOP 要求每段不超过 60 秒/2MB，默认 60 秒。"""
    pattern = os.path.join(output_dir, "seg_%03d.wav")
    cmd = [
        "ffmpeg", "-y", "-i", input_wav,
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "-f", "segment", "-segment_time", str(segment_sec),
        pattern,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    files = sorted([os.path.join(output_dir, f) for f in os.listdir(output_dir) if f.startswith("seg_") and f.endswith(".wav")])
    return files


def _baidu_vop_token(api_key: str, secret_key: str) -> str:
    url = (
        "https://aip.baidubce.com/oauth/2.0/token"
        f"?grant_type=client_credentials&client_id={api_key}&client_secret={secret_key}"
    )
    with httpx.Client(timeout=10) as client:
        r = client.post(url)
        r.raise_for_status()
        data = r.json()
        token = data.get("access_token", "")
        if not token:
            raise RuntimeError(f"Baidu VOP token 获取失败: {data}")
        return token


def _baidu_vop_asr(wav_bytes: bytes, token: str) -> str:
    url = f"https://vop.baidu.com/server_api?cuid=faulttreeai&token={token}"
    headers = {"Content-Type": "audio/wav; rate=16000"}
    with httpx.Client(timeout=60) as client:
        r = client.post(url, content=wav_bytes, headers=headers)
        r.raise_for_status()
        data = r.json()
        err_no = data.get("err_no")
        if err_no == 0:
            return " ".join(data.get("result", []))
        raise RuntimeError(f"Baidu ASR error {err_no}: {data.get('err_msg')} (sn={data.get('sn')})")


def _openai_whisper_asr(wav_bytes: bytes) -> str:
    api_key = getattr(settings, "OPENAI_API_KEY", "")
    base_url = getattr(settings, "OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    if not api_key:
        raise RuntimeError("OpenAI API key not configured")
    with httpx.Client(timeout=120) as client:
        r = client.post(
            f"{base_url}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            data={"model": "whisper-1", "language": "zh"},
        )
        r.raise_for_status()
        return r.json().get("text", "")


def _asr_wav(wav_path: str) -> str:
    """调用 ASR 识别 WAV 文件。

    优先复用 RTC 已配置的 ASR 能力（支持 baidu_vop / openai / volcengine），
    失败后再回退到 video_processor 内置的百度 VOP / OpenAI Whisper。
    """
    with open(wav_path, "rb") as f:
        wav_bytes = f.read()

    # 1) 优先复用 realtime/rtc 模块的 ASR（支持火山、百度、OpenAI 等）
    try:
        import wave
        from io import BytesIO
        from backend.services.rtc_bot.audio_asr_pipeline import _asr_pcm

        with wave.open(BytesIO(wav_bytes), "rb") as wf:
            channels = wf.getnchannels()
            sample_rate = wf.getframerate()
            width = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())
            if width == 1:
                pcm = (np.frombuffer(frames, dtype=np.uint8).astype(np.int16) - 128) * 256
                pcm = pcm.tobytes() if hasattr(pcm, "tobytes") else pcm.tostring()
            elif width == 2:
                pcm = frames
            elif width == 4:
                arr = np.frombuffer(frames, dtype=np.int32)
                pcm = (arr // 256).astype(np.int16)
                pcm = pcm.tobytes() if hasattr(pcm, "tobytes") else pcm.tostring()
            else:
                raise RuntimeError(f"不支持的采样位数: {width}")

        # 将 WAV 封装中的 PCM 送入已集成的 ASR 管道（支持火山/百度/OpenAI）
        def _run_asr_sync(pcm_bytes, sr, ch):
            try:
                return asyncio.run(_asr_pcm(pcm_bytes, sr, ch))
            except RuntimeError:
                # 当前线程已有事件循环在运行（如 FastAPI 后台任务），在新线程中运行
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(asyncio.run, _asr_pcm(pcm_bytes, sr, ch))
                    return future.result(timeout=120)

        print(f"[*] Trying RTC ASR pipeline for {wav_path} (sr={sample_rate}, ch={channels})")
        text = _run_asr_sync(pcm, sample_rate, channels)
        print(f"[*] RTC ASR pipeline result length: {len(text or '')}")
        if text:
            return text
    except Exception as e:
        print(f"[WARN] RTC ASR pipeline failed, fallback to built-in: {e}")

    # 2) 内置 fallback：百度 VOP
    baidu_key = getattr(settings, "BAIDU_VOP_API_KEY", "")
    baidu_secret = getattr(settings, "BAIDU_VOP_SECRET_KEY", "")
    if baidu_key and baidu_secret:
        try:
            token = _baidu_vop_token(baidu_key, baidu_secret)
            text = _baidu_vop_asr(wav_bytes, token)
            if text:
                return text
            print("[WARN] Baidu VOP returned empty text")
        except Exception as e:
            print(f"[WARN] Baidu VOP ASR failed: {e}")

    # 3) 内置 fallback：OpenAI Whisper
    openai_key = getattr(settings, "OPENAI_API_KEY", "")
    base_url = getattr(settings, "OPENAI_BASE_URL", "").rstrip("/")
    if openai_key and "qianfan" not in base_url and "baidubce" not in base_url:
        try:
            text = _openai_whisper_asr(wav_bytes)
            if text:
                return text
            print("[WARN] Whisper returned empty text")
        except Exception as e:
            print(f"[WARN] Whisper ASR failed: {e}")

    raise RuntimeError("没有可用的 ASR 服务，请配置 BAIDU_VOP_API_KEY、OPENAI_API_KEY 或 VOLCENGINE_API_KEY，并确认服务可访问")


def _split_text(text: str, max_len: int = 800) -> List[str]:
    """把长文本按段落/句子分块"""
    if not text:
        return []
    chunks = []
    current = ""
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) > max_len and current:
            chunks.append(current)
            current = para
        else:
            current = (current + "\n" + para).strip()
    if current:
        chunks.append(current)
    return chunks or [text[:max_len]]


def parse_video(file_path: str) -> List[dict]:
    """解析视频文件：提取音频 → ASR 转文字 → 分块"""
    ffmpeg = _which_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "未找到 ffmpeg，无法处理视频文件。"
            "请在服务器上安装 ffmpeg：sudo apt install ffmpeg 或 sudo yum install ffmpeg"
        )

    file_path = str(file_path)
    source_name = Path(file_path).name
    tmpdir = tempfile.mkdtemp(prefix="video_parse_")
    full_text_parts: List[str] = []

    try:
        wav_path = os.path.join(tmpdir, "audio.wav")
        _extract_audio(file_path, wav_path)

        # 分段处理：百度 VOP 单段限制 60 秒/2MB；Whisper 可更长但分段也安全
        wav_size = os.path.getsize(wav_path)
        segment_sec = 60
        if wav_size > segment_sec * 16000 * 2:  # > 60 秒音频则分段
            segments = _split_audio(wav_path, tmpdir, segment_sec=segment_sec)
        else:
            segments = [wav_path]

        for i, seg in enumerate(segments):
            try:
                print(f"[*] ASR segment {i + 1}/{len(segments)}: {seg}")
                text = _asr_wav(seg)
                print(f"[*] ASR segment {i + 1} result length: {len(text or '')}")
                if text:
                    full_text_parts.append(text)
            except Exception as e:
                print(f"[WARN] ASR segment {i + 1} failed: {e}")
                continue

        full_text = "\n".join(full_text_parts).strip()
        print(f"[*] Video full text length: {len(full_text)}")
        if not full_text:
            raise RuntimeError("未能从视频中提取到有效文字，请检查 ASR 服务配置或视频是否有声音")

        chunks = _split_text(full_text)
        print(f"[*] Video chunks count: {len(chunks)}")
        return [
            {
                "text": chunk,
                "source": source_name,
                "page": 0,
                "chunk_index": i,
            }
            for i, chunk in enumerate(chunks)
        ]
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
