import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 浏览器麦克风录音 Hook（输出 16kHz 16bit 单声道 WAV）。
 *
 * 作为 Web Speech API 不可用时的降级方案：
 * - supported：当前环境是否支持 getUserMedia + AudioContext
 * - recording：是否正在录音
 * - start() / stop()：开始/结束录音
 * - getWavBlob()：获取最近一次录音的 WAV Blob
 *
 * 注意：
 * - MediaStream 和 AudioContext 只创建一次，避免重复触发麦克风权限。
 * - 每次录音只重建 ScriptProcessorNode，避免频繁 getUserMedia。
 */
export function useAudioRecorder(options = {}) {
  const { sampleRate = 16000, maxDurationMs = 30000 } = options;
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [blob, setBlob] = useState(null);
  const [lastRms, setLastRms] = useState(0);

  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const chunksRef = useRef([]);
  const maxTimeoutRef = useRef(null);
  const recordingRef = useRef(false);

  useEffect(() => {
    const ok = !!(
      navigator?.mediaDevices?.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext)
    );
    setSupported(ok);
  }, []);

  const _cleanupProcessor = useCallback(() => {
    try {
      processorRef.current?.disconnect?.();
    } catch {
      // ignore
    }
    try {
      sourceRef.current?.disconnect?.();
    } catch {
      // ignore
    }
    processorRef.current = null;
    sourceRef.current = null;
    chunksRef.current = [];
  }, []);

  const _cleanupAll = useCallback(() => {
    _cleanupProcessor();
    try {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {
      // ignore
    }
    try {
      audioContextRef.current?.close?.();
    } catch {
      // ignore
    }
    streamRef.current = null;
    audioContextRef.current = null;
    recordingRef.current = false;
  }, [_cleanupProcessor]);

  const stop = useCallback(async () => {
    if (!recordingRef.current) return null;

    if (maxTimeoutRef.current) {
      clearTimeout(maxTimeoutRef.current);
      maxTimeoutRef.current = null;
    }

    recordingRef.current = false;
    setRecording(false);

    const sourceRate = audioContextRef.current?.sampleRate || 48000;
    const chunks = chunksRef.current.slice();
    _cleanupProcessor();

    // 合并音频块
    let totalLen = 0;
    chunks.forEach((c) => (totalLen += c.length));
    console.log('[AudioRecorder] chunks:', chunks.length, 'total samples:', totalLen, 'sourceRate:', sourceRate);
    if (totalLen === 0) {
      console.warn('[AudioRecorder] recorded zero samples');
      setBlob(null);
      return null;
    }
    const combined = new Float32Array(totalLen);
    let offset = 0;
    chunks.forEach((c) => {
      combined.set(c, offset);
      offset += c.length;
    });

    // 计算录音能量，判断是否为静音
    const rms = Math.sqrt(combined.reduce((sum, v) => sum + v * v, 0) / combined.length);
    console.log('[AudioRecorder] recorded rms:', rms, 'peak:', Math.max(...combined.map(Math.abs)));
    setLastRms(rms);

    // 重采样到目标采样率
    const resampled = resampleFloat32(combined, sourceRate, sampleRate);
    // 转换为 16bit PCM
    const pcm = float32ToInt16(resampled);
    const wavBlob = encodeWav(pcm, sampleRate, 1);

    setBlob(wavBlob);
    return wavBlob;
  }, [_cleanupProcessor, sampleRate]);

  const start = useCallback(async () => {
    if (recordingRef.current) return true;

    try {
      // 如果已有可用 stream，直接复用，避免重复申请权限
      if (!streamRef.current || !streamRef.current.active) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        const audioContext = new AudioCtx();
        audioContextRef.current = audioContext;
      }

      // 移动端 WebView 的 AudioContext 经常处于 suspended，需要显式 resume
      if (audioContextRef.current.state === 'suspended') {
        try {
          await audioContextRef.current.resume();
          console.log('[AudioRecorder] AudioContext resumed, state:', audioContextRef.current.state);
        } catch (err) {
          console.warn('[AudioRecorder] AudioContext resume failed:', err);
        }
      } else {
        console.log('[AudioRecorder] AudioContext state:', audioContextRef.current.state);
      }

      const audioContext = audioContextRef.current;
      const source = audioContext.createMediaStreamSource(streamRef.current);
      sourceRef.current = source;

      // ScriptProcessorNode 已废弃，但兼容性好；后续可迁移到 AudioWorklet
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(data));
      };

      // 不连接到 destination，避免扬声器回放麦克风声音造成回声/权限问题
      source.connect(processor);

      recordingRef.current = true;
      setRecording(true);
      setBlob(null);

      if (maxDurationMs > 0) {
        maxTimeoutRef.current = setTimeout(() => {
          stop();
        }, maxDurationMs);
      }
      return true;
    } catch (e) {
      recordingRef.current = false;
      setRecording(false);
      throw e;
    }
  }, [maxDurationMs, stop]);

  const getWavBlob = useCallback(() => blob, [blob]);

  useEffect(() => {
    return () => {
      _cleanupAll();
    };
  }, [_cleanupAll]);

  return {
    supported,
    recording,
    start,
    stop,
    getWavBlob,
    lastRms,
  };
}

function resampleFloat32(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const a = input[idx] || 0;
    const b = input[idx + 1] || 0;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

function float32ToInt16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeWav(samples, sampleRate, channels) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  return new Blob([view], { type: 'audio/wav' });
}
