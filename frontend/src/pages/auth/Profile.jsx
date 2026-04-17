import React, { useEffect, useState } from 'react'
import { Card, Typography, Form, Input, Button, Space, Avatar, Upload, message } from 'antd'
import { UploadOutlined, SaveOutlined } from '@ant-design/icons'
import api from '../../services/api.js'

const { Title, Text } = Typography

export default function Profile({ user, onUserChange }) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (!user) return
    form.setFieldsValue({
      role: user.role,
      full_name: user.full_name,
      phone: user.phone,
      employee_id: user.employee_id,
      title: user.title,
    })
  }, [user, form])

  const save = async () => {
    const values = await form.validateFields(['full_name', 'phone', 'employee_id', 'title'])
    setSaving(true)
    try {
      const res = await api.updateMe(values)
      onUserChange?.(res?.user || null)
      message.success('已保存')
    } catch (e) {
      message.error(e?.response?.data?.detail || e?.message || '保存失败')
    }
    setSaving(false)
  }

  const beforeUpload = async (file) => {
    setUploading(true)
    try {
      const res = await api.uploadMyAvatar(file)
      onUserChange?.(res?.user || null)
      message.success('头像已更新')
    } catch (e) {
      message.error(e?.response?.data?.detail || e?.message || '上传失败')
    }
    setUploading(false)
    return false
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Card style={{ borderRadius: 16 }} styles={{ body: { padding: 20 } }}>
        <Space align="start" size={16}>
          <div>
            <Avatar
              size={72}
              src={user?.avatar_base64 ? `data:image/*;base64,${user.avatar_base64}` : undefined}
            >
              {String(user?.full_name || user?.username || 'U').slice(0, 1).toUpperCase()}
            </Avatar>
            <div style={{ marginTop: 12 }}>
              <Upload showUploadList={false} beforeUpload={beforeUpload} accept="image/*">
                <Button icon={<UploadOutlined />} loading={uploading}>更换头像</Button>
              </Upload>
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <Title level={4} style={{ marginTop: 0, marginBottom: 8 }}>个人中心</Title>
            <Text type="secondary">修改个人信息（姓名、电话、工号、职位）</Text>
            <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
              <Space size={16} style={{ width: '100%' }} align="start">
                <div style={{ flex: 1 }}>
                  <Form.Item label="工号" name="employee_id" rules={[{ required: true, message: '请输入工号' }]}>
                    <Input disabled />
                  </Form.Item>
                </div>
                <div style={{ width: 160 }}>
                  <Form.Item label="角色" name="role">
                    <Input disabled />
                  </Form.Item>
                </div>
              </Space>
              <Space size={16} style={{ width: '100%' }} align="start">
                <div style={{ flex: 1 }}>
                  <Form.Item label="姓名" name="full_name">
                    <Input placeholder="请输入姓名" />
                  </Form.Item>
                </div>
                <div style={{ flex: 1 }}>
                  <Form.Item label="电话" name="phone">
                    <Input placeholder="请输入电话" />
                  </Form.Item>
                </div>
              </Space>
              <Space size={16} style={{ width: '100%' }} align="start">
                <div style={{ flex: 1 }}>
                  <Form.Item label="职位" name="title">
                    <Input placeholder="请输入职位" />
                  </Form.Item>
                </div>
              </Space>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="primary" icon={<SaveOutlined />} onClick={save} loading={saving}>保存</Button>
              </div>
            </Form>
          </div>
        </Space>
      </Card>
    </div>
  )
}
