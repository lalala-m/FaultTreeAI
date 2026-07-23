import React, { useEffect, useRef } from 'react';
import {
  Button,
  Input,
  Space,
  Tag,
  Switch,
  Tooltip,
  Badge,
  Empty,
} from 'antd';
import {
  AudioMutedOutlined,
  SendOutlined,
  ScanOutlined,
  RobotOutlined,
  EyeOutlined,
  LoadingOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import './RtcCallAssistant.css';

const STATUS_MAP = {
  idle: { text: '待机', color: 'default' },
  observing: { text: '观察中', color: 'processing' },
  analyzing: { text: '分析中', color: 'warning' },
  speaking: { text: '播报中', color: 'success' },
  offline: { text: '离线', color: 'default' },
  ready: { text: '就绪', color: 'success' },
  error: { text: '异常', color: 'error' },
};

export default function RtcCallAssistant({
  aiStatus = 'idle',
  messages = [],
  inputValue = '',
  onInputChange,
  onSendText,
  onAnalyzeFrame,
  autoAnalyze = false,
  onAutoAnalyzeChange,
  autoSec = 8,
  onAutoSecChange,
  loading = false,
  assistantVoiceEnabled = true,
  onVoiceEnabledChange,
  speaking = false,
}) {
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const status = STATUS_MAP[aiStatus] || STATUS_MAP.idle;

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendText?.();
    }
  };

  return (
    <div className="rtc-call-assistant">
      <div className="rtc-assistant-header">
        <Badge status={status.color} />
        <span className="rtc-assistant-status">AI {status.text}</span>
        {speaking && (
          <Tag icon={<SoundOutlined />} color="success">
            播报中
          </Tag>
        )}
        <div className="rtc-assistant-actions">
          <Tooltip title={assistantVoiceEnabled ? '关闭 AI 语音播报' : '开启 AI 语音播报'}>
            <Button
              size="small"
              icon={assistantVoiceEnabled ? <SoundOutlined /> : <AudioMutedOutlined />}
              type={assistantVoiceEnabled ? 'primary' : 'default'}
              onClick={() => onVoiceEnabledChange?.(!assistantVoiceEnabled)}
            />
          </Tooltip>
        </div>
      </div>

      <div className="rtc-messages">
        {messages.length === 0 ? (
          <Empty description="暂无对话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          messages.map((msg, idx) => (
            <div
              key={idx}
              className={`rtc-message ${msg.role === 'user' ? 'rtc-message-user' : 'rtc-message-assistant'}`}
            >
              <div className="rtc-message-avatar">
                {msg.role === 'user' ? '🧑‍🔧' : <RobotOutlined />}
              </div>
              <div className="rtc-message-bubble">
                <div className="rtc-message-content">{msg.content}</div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="rtc-assistant-controls">
        <div className="rtc-auto-row">
          <Space>
            <Switch
              size="small"
              checked={autoAnalyze}
              onChange={onAutoAnalyzeChange}
              checkedChildren="自动"
              unCheckedChildren="手动"
            />
            <span className="rtc-auto-label">自动观察画面</span>
            {autoAnalyze && (
              <select
                className="rtc-auto-sec"
                value={autoSec}
                onChange={(e) => onAutoSecChange?.(Number(e.target.value))}
              >
                <option value={3}>3秒</option>
                <option value={5}>5秒</option>
                <option value={8}>8秒</option>
                <option value={15}>15秒</option>
              </select>
            )}
          </Space>
          <Tooltip title="立即分析当前画面">
            <Button
              size="small"
              icon={loading ? <LoadingOutlined /> : <ScanOutlined />}
              loading={loading}
              onClick={onAnalyzeFrame}
            >
              分析画面
            </Button>
          </Tooltip>
        </div>

        <div className="rtc-input-row">
          <Input.TextArea
            className="rtc-input"
            rows={2}
            placeholder="输入问题..."
            value={inputValue}
            onChange={(e) => onInputChange?.(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Tooltip title="发送">
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={onSendText}
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
