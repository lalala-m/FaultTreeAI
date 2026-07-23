import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 语音输入/输出 Hook
 *
 * 封装浏览器 Web Speech API，提供：
 * - startListening / stopListening：语音转文字
 * - speak / cancel：文字转语音
 * - supported：当前环境是否支持
 */
export function useSpeech(options = {}) {
  const { onResult, onError, lang = 'zh-CN', rate = 1, pitch = 1, backendTtsUrl = '' } = options;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recognitionRef = useRef(null);
  const backendAudioRef = useRef(null);
  const speakCancelledRef = useRef(false);
  const audioUnlockedRef = useRef(false);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const SS = window.speechSynthesis;
    const supported = typeof SR === 'function' && !!SS;
    console.log('[Speech] recognition supported:', typeof SR === 'function', 'synthesis supported:', !!SS)
    setSupported(supported);
    // 某些浏览器需要触发一次 getVoices 才会加载语音列表
    if (SS) {
      SS.getVoices();
      SS.onvoiceschanged = () => {
        console.log('[Speech] voices loaded:', SS.getVoices().length)
      };
    }
  }, []);

  // 移动端 WebView 需要用户交互后才能自动播放音频，这里用静音音频解锁
  useEffect(() => {
    const unlockAudio = async () => {
      if (audioUnlockedRef.current) return
      try {
        const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=')
        audio.volume = 0.01
        await audio.play()
        audioUnlockedRef.current = true
        console.log('[TTS] audio autoplay unlocked')
      } catch (err) {
        console.warn('[TTS] audio unlock failed:', err)
      }
    }
    window.addEventListener('touchstart', unlockAudio, { once: true })
    window.addEventListener('mousedown', unlockAudio, { once: true })
    return () => {
      window.removeEventListener('touchstart', unlockAudio)
      window.removeEventListener('mousedown', unlockAudio)
    }
  }, [])

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      onError?.(new Error('当前浏览器不支持语音识别'));
      return false;
    }
    if (listening) return true;

    try {
      window.speechSynthesis?.cancel?.();
      const recognition = new SR();
      recognitionRef.current = recognition;
      recognition.lang = lang;
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => setListening(true);
      recognition.onend = () => {
        setListening(false);
        // 兜底：如果浏览器没有触发 final 结果（如飞书内置浏览器、部分 WebView），
        // 将最后一次中间结果作为识别输出，避免用户说了话但没有任何响应。
        const interim = recognitionRef.current?.__lastInterim;
        if (interim) {
          onResult?.(interim);
          recognitionRef.current.__lastInterim = '';
        }
        recognitionRef.current = null;
      };
      // 某些浏览器（如飞书内置浏览器）可能没有任何 onresult 事件，
      // 此时在 onend 中把最后一次中间结果作为兜底输出，避免话说了但没有任何触发。
      recognition.onnomatch = () => {
        onError?.(new Error('未能识别到语音，请重试'));
      };
      recognition.onerror = (event) => {
        setListening(false);
        recognitionRef.current = null;
        if (event.error !== 'aborted') {
          onError?.(new Error(`语音识别失败: ${event.error}`));
        }
      };
      recognition.onresult = (event) => {
        const results = Array.from(event.results || []);
        const finalText = results
          .filter((r) => r.isFinal)
          .map((r) => String(r?.[0]?.transcript || ''))
          .join('')
          .trim();

        // 保存最后一次中间结果，用于 onend 兜底输出
        const last = results[results.length - 1];
        if (last && !last.isFinal && last[0]) {
          recognitionRef.current.__lastInterim = String(last[0].transcript || '').trim();
        }

        if (finalText) {
          onResult?.(finalText);
          recognitionRef.current.__lastInterim = '';
        }
      };

      recognition.start();
      return true;
    } catch (e) {
      onError?.(e);
      return false;
    }
  }, [listening, onResult, onError, lang]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    setListening(false);
  }, []);

  const _unlockAudio = useCallback(async () => {
    if (audioUnlockedRef.current) return true;
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
      audio.volume = 0.01;
      await audio.play();
      audioUnlockedRef.current = true;
      console.log('[TTS] audio autoplay unlocked');
      return true;
    } catch (err) {
      console.warn('[TTS] audio unlock failed:', err);
      return false;
    }
  }, []);

  const _playBackendTts = useCallback(async (content) => {
    if (!backendTtsUrl) return false;
    speakCancelledRef.current = false;
    try {
      console.log('[TTS] fallback to backend TTS:', backendTtsUrl)
      setSpeaking(true)
      const resp = await fetch(backendTtsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content }),
      })
      if (speakCancelledRef.current) {
        console.log('[TTS] cancelled after fetch')
        setSpeaking(false)
        return false
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        console.error('[TTS] backend TTS error:', resp.status, errText)
        setSpeaking(false)
        return false
      }
      const contentType = resp.headers.get('Content-Type') || ''
      const blob = await resp.blob()
      console.log('[TTS] backend audio blob:', blob.size, 'bytes, type:', contentType)
      if (!blob.size) {
        console.error('[TTS] backend returned empty audio')
        setSpeaking(false)
        return false
      }
      if (speakCancelledRef.current) {
        console.log('[TTS] cancelled before play')
        setSpeaking(false)
        return false
      }

      const url = URL.createObjectURL(blob)
      const audio = document.createElement('audio')
      audio.src = url
      audio.style.position = 'fixed'
      audio.style.bottom = '0'
      audio.style.right = '0'
      audio.style.width = '1px'
      audio.style.height = '1px'
      audio.style.opacity = '0'
      audio.style.pointerEvents = 'none'
      audio.preload = 'auto'
      document.body.appendChild(audio)
      backendAudioRef.current = audio
      audio.onended = () => {
        console.log('[TTS] backend audio ended')
        setSpeaking(false)
        URL.revokeObjectURL(url)
        try { document.body.removeChild(audio) } catch {}
        backendAudioRef.current = null
      }
      audio.onerror = (e) => {
        console.error('[TTS] backend audio play error:', e)
        setSpeaking(false)
        URL.revokeObjectURL(url)
        try { document.body.removeChild(audio) } catch {}
        backendAudioRef.current = null
      }
      try {
        await audio.play()
        console.log('[TTS] backend audio play started')
        return true
      } catch (playErr) {
        // 自动播放被浏览器阻止，常见在飞书/微信内置浏览器首次访问
        console.warn('[TTS] backend audio autoplay blocked:', playErr?.name, playErr?.message)
        // 再尝试解锁一次，然后重试
        const unlocked = await _unlockAudio();
        if (unlocked) {
          try {
            await audio.play()
            console.log('[TTS] backend audio play started after unlock')
            return true
          } catch (retryErr) {
            console.warn('[TTS] backend audio play retry failed:', retryErr?.name, retryErr?.message)
          }
        }
        setSpeaking(false)
        // 保留 audio 元素不删除，让用户看到（或可通过点击播放）
        audio.style.opacity = '1'
        audio.style.width = '200px'
        audio.style.height = '40px'
        audio.style.zIndex = '9999'
        audio.controls = true
        audio.setAttribute('autoplay', 'false')
        return false
      }
    } catch (err) {
      console.error('[TTS] backend TTS exception:', err)
      setSpeaking(false)
      return false
    }
  }, [backendTtsUrl])

  const _shouldUseBackendTts = useCallback(() => {
    // 飞书、微信等内置浏览器原生 TTS 基本不可用，强制走后端
    const ua = navigator.userAgent || ''
    const isEmbeddedBrowser = /Lark|Feishu|飞书|MicroMessenger|WeChat|DingTalk/i.test(ua)
    const hasNativeTts = 'speechSynthesis' in window && window.speechSynthesis.getVoices().length > 0
    console.log('[TTS] UA:', ua.slice(0, 80), 'isEmbedded:', isEmbeddedBrowser, 'hasNative:', hasNativeTts)
    return isEmbeddedBrowser || !hasNativeTts
  }, [])

  const speak = useCallback((text) => {
    const content = String(text || '').trim();
    console.log('[TTS] speak called, content length:', content.length)
    if (!content) {
      console.warn('[TTS] empty content, skip')
      return false;
    }

    // 尝试解锁自动播放（在用户交互的延续期内调用成功率最高）
    _unlockAudio().catch(() => {});

    // 飞书/微信等内置浏览器直接走后端 TTS，避免原生 TTS 实际不出声
    if (_shouldUseBackendTts()) {
      console.log('[TTS] use backend TTS directly for embedded browser')
      return _playBackendTts(content);
    }

    // 优先浏览器原生 TTS
    if ('speechSynthesis' in window) {
      const voices = window.speechSynthesis.getVoices();
      console.log('[TTS] available voices:', voices.length)
      if (voices.length > 0) {
        try {
          window.speechSynthesis.cancel();
          const utter = new window.SpeechSynthesisUtterance(content);
          utter.lang = lang;
          utter.rate = rate;
          utter.pitch = pitch;
          utter.onstart = () => {
            console.log('[TTS] onstart')
            setSpeaking(true)
          };
          utter.onend = () => {
            console.log('[TTS] onend')
            setSpeaking(false)
          };
          utter.onerror = (event) => {
            console.error('[TTS] onerror:', event.error, event)
            setSpeaking(false)
          };
          window.speechSynthesis.speak(utter);
          console.log('[TTS] speak requested')
          return true;
        } catch (err) {
          console.error('[TTS] speak exception:', err)
          // 原生失败时尝试后端降级
        }
      }
    }

    // 原生不支持或没有可用语音时，使用后端 TTS 降级
    return _playBackendTts(content);
  }, [lang, rate, pitch, _playBackendTts, _shouldUseBackendTts]);

  const cancel = useCallback(() => {
    speakCancelledRef.current = true;
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    if (backendAudioRef.current) {
      const item = backendAudioRef.current;
      if (item instanceof HTMLElement) {
        try { item.pause(); item.currentTime = 0; } catch {}
        try { document.body.removeChild(item) } catch {}
      }
      backendAudioRef.current = null;
    }
    setSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      stopListening();
      cancel();
    };
  }, [stopListening, cancel]);

  return {
    supported,
    listening,
    speaking,
    startListening,
    stopListening,
    speak,
    cancel,
  };
}
