import React, { useState } from 'react'
import { Card, Typography, Form, Input, Button, Space, Select, message } from 'antd'
import api from '../../services/api.js'

const { Title, Text } = Typography

export default function Register({ onDone, onGoLogin }) {
  const [submitting, setSubmitting] = useState(false)

  const errText = (e) => {
    const detail = e?.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) return detail
    if (Array.isArray(detail) && detail.length) return String(detail[0]?.msg || '参数错误')
    if (detail && typeof detail === 'object') return String(detail.msg || '参数错误')
    const msg = e?.message
    return String(msg || '注册失败')
  }

  const submit = async (values) => {
    if (values.password !== values.password2) {
      message.error('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    try {
      await api.register({ employee_id: values.employee_id, full_name: values.full_name, password: values.password, role: values.role })
      message.success('注册成功')
      await onDone?.()
    } catch (e) {
      message.error(errText(e))
    }
    setSubmitting(false)
  }

  return (
    <Card style={{ borderRadius: 16 }} styles={{ body: { padding: 20 } }}>
      <Title level={4} style={{ marginTop: 0, marginBottom: 8 }}>注册</Title>
      <Text type="secondary">工号为账号唯一标识（不可重复）</Text>
      <Form layout="vertical" style={{ marginTop: 16 }} onFinish={submit} initialValues={{ role: 'worker' }}>
        <Form.Item label="工号" name="employee_id" rules={[{ required: true, message: '请输入工号' }]}>
          <Input placeholder="工号（账户唯一标识）" autoComplete="username" />
        </Form.Item>
        <Form.Item label="姓名" name="full_name">
          <Input placeholder="姓名（可重复）" />
        </Form.Item>
        <Form.Item label="角色" name="role" rules={[{ required: true, message: '请选择角色' }]}>
          <Select
            options={[
              { value: 'worker', label: '工人' },
              { value: 'expert', label: '专家' },
            ]}
          />
        </Form.Item>
        <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="至少6位" autoComplete="new-password" />
        </Form.Item>
        <Form.Item label="确认密码" name="password2" rules={[{ required: true, message: '请再次输入密码' }]}>
          <Input.Password placeholder="再次输入密码" autoComplete="new-password" />
        </Form.Item>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button type="link" onClick={onGoLogin}>已有账号，去登录</Button>
          <Button type="primary" htmlType="submit" loading={submitting}>注册</Button>
        </Space>
      </Form>
    </Card>
  )
}
