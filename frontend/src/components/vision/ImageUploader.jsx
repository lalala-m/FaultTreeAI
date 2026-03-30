/**
 * 图片上传组件
 * 支持拖拽上传、点击上传、批量上传、图片预览
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Upload, Button, message, Card } from 'antd';
import { UploadOutlined, DeleteOutlined, ThunderboltOutlined, InboxOutlined } from '@ant-design/icons';
import './ImageUploader.css';

const { Dragger } = Upload;

/**
 * 图片上传组件
 */
export default function ImageUploader({ onUpload, onDetect, loading = false, maxCount = 9 }) {
  const [fileList, setFileList] = useState([]);

  // 处理文件变化
  const handleChange = useCallback((info) => {
    let newFileList = [...info.fileList];
    
    // 只保留已上传和上传中的文件
    newFileList = newFileList.slice(-maxCount);
    
    // 为每个文件生成预览URL
    newFileList = newFileList.map(file => {
      if (!file.url && !file.preview && file.originFileObj) {
        file.preview = URL.createObjectURL(file.originFileObj);
      }
      return file;
    });
    
    setFileList(newFileList);
    
    if (onUpload) {
      onUpload(newFileList);
    }
  }, [onUpload, maxCount]);

  // 上传前的验证
  const beforeUpload = useCallback((file) => {
    const isImage = file.type.startsWith('image/');
    if (!isImage) {
      message.error('只能上传图片文件');
      return false;
    }
    
    const isLt10M = file.size / 1024 / 1024 < 10;
    if (!isLt10M) {
      message.error('图片大小不能超过 10MB');
      return false;
    }
    
    // 阻止自动上传，让组件自己管理文件列表
    return false;
  }, []);

  // 删除文件
  const handleRemove = useCallback((file) => {
    const newFileList = fileList.filter(f => f.uid !== file.uid);
    setFileList(newFileList);
    if (onUpload) {
      onUpload(newFileList);
    }
    return false; // 阻止默认删除行为
  }, [fileList, onUpload]);

  // 预览
  const handlePreview = useCallback((file) => {
    const src = file.url || file.preview;
    if (src) {
      const img = window.open(src);
      if (img) img.document.write(`<img src='${src}' style='max-width:100%'/>`);
    }
  }, []);

  const uploadButton = (
    <div>
      <InboxOutlined style={{ fontSize: 48, color: '#999' }} />
      <p className="ant-upload-text">点击或拖拽上传设备图片</p>
      <p className="ant-upload-hint">支持 jpg、png、bmp 格式，单张不超过 10MB</p>
    </div>
  );

  return (
    <div className="image-uploader">
      <Dragger
        name="file"
        multiple
        listType="picture-card"
        fileList={fileList}
        beforeUpload={beforeUpload}
        onChange={handleChange}
        onRemove={handleRemove}
        onPreview={handlePreview}
        accept="image/*"
        showUploadList={{
          showPreviewIcon: true,
          showRemoveIcon: true,
        }}
      >
        {fileList.length >= maxCount ? null : uploadButton}
      </Dragger>

      <div style={{ marginTop: 12 }}>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={onDetect}
          loading={loading}
          disabled={fileList.length === 0}
          size="large"
          block
        >
          开始识别 {fileList.length > 0 && `(${fileList.length}张)`}
        </Button>
      </div>

      <Card size="small" style={{ marginTop: 12 }}>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: '#666' }}>
          <li>图片应清晰展示设备外观和故障部位</li>
          <li>推荐使用正面拍摄，避免强光和阴影</li>
          <li>异常部位尽量占据图片主体</li>
        </ul>
      </Card>
    </div>
  );
}
