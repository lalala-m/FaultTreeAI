import React, { useState } from 'react'
import { Card, Typography, Form, Input, Button, Space, message } from 'antd'
import api from '../../services/api.js'

const { Title, Text } = Typography

export default function Login({ onDone, onGoRegister }) {
  const [submitting, setSubmitting] = useState(false)

  const errText = (e) => {
    const detail = e?.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) return detail
    if (Array.isArray(detail) && detail.length) return String(detail[0]?.msg || '参数错误')
    if (detail && typeof detail === 'object') return String(detail.msg || '参数错误')
    const msg = e?.message
    return String(msg || '登录失败')
  }

  const submit = async (values) => {
    setSubmitting(true)
    try {
      await api.login({ employee_id: values.employee_id, password: values.password })
      message.success('登录成功')
      await onDone?.()
    } catch (e) {
      message.error(errText(e))
    }
    setSubmitting(false)
  }

  return (
    <Card style={{ borderRadius: 16 }} styles={{ body: { padding: 20 } }}>
      <Title level={4} style={{ marginTop: 0, marginBottom: 8 }}>登录</Title>
      <Text type="secondary">使用工号与密码登录系统</Text>
      <Form layout="vertical" style={{ marginTop: 16 }} onFinish={submit}>
        <Form.Item label="工号" name="employee_id" rules={[{ required: true, message: '请输入工号' }]}>
          <Input placeholder="请输入工号" autoComplete="username" />
        </Form.Item>
        <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="请输入密码" autoComplete="current-password" />
        </Form.Item>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button type="link" onClick={onGoRegister}>注册新账号</Button>
          <Button type="primary" htmlType="submit" loading={submitting}>登录</Button>
        </Space>
      </Form>
    </Card>
  )
}
