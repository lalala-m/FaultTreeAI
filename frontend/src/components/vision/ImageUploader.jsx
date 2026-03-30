/**
 * 图片上传组件
 * 支持拖拽上传、点击上传、批量上传、图片预览
 */

import React, { useState, useCallback } from 'react';
import { Upload, Button, message, Spin, Card } from 'antd';
import { UploadOutlined, DeleteOutlined, ThunderboltOutlined, InboxOutlined } from '@ant-design/icons';
import './ImageUploader.css';

const { Dragger } = Upload;

/**
 * 图片上传组件
 * 
 * @param {Function} onUpload - 上传完成回调
 * @param {Function} onDetect - 一键识别回调
 * @param {boolean} loading - 是否正在识别
 * @param {number} maxCount - 最大上传数量
 */
export default function ImageUploader({ 
  onUpload, 
  onDetect, 
  loading = false, 
  maxCount = 9 
}) {
  const [fileList, setFileList] = useState([]);
  const [uploading, setUploading] = useState(false);

  // 处理文件变化
  const handleChange = useCallback((info) => {
    const { status } = info.file;
    
    if (status === 'done') {
      message.success(`${info.file.name} 上传成功`);
    } else if (status === 'error') {
      message.error(`${info.file.name} 上传失败`);
    }
    
    // 更新文件列表
    const newFileList = info.fileList.map(file => {
      if (file.response) {
        // 已经上传过的文件，保留响应
        return {
          ...file,
          url: file.response.url || URL.createObjectURL(file.originFileObj)
        };
      }
      return file;
    });
    
    setFileList(newFileList);
    
    // 通知父组件
    if (onUpload) {
      onUpload(newFileList);
    }
  }, [onUpload]);

  // 上传前的验证
  const beforeUpload = useCallback((file) => {
    // 验证文件类型
    const isImage = file.type.startsWith('image/');
    if (!isImage) {
      message.error('只能上传图片文件');
      return false;
    }
    
    // 验证文件大小 (10MB)
    const isLt10M = file.size / 1024 / 1024 < 10;
    if (!isLt10M) {
      message.error('图片大小不能超过 10MB');
      return false;
    }
    
    // 验证文件数量
    if (fileList.length >= maxCount) {
      message.warning(`最多只能上传 ${maxCount} 张图片`);
      return false;
    }
    
    return true;
  }, [fileList, maxCount]);

  // 删除文件
  const handleRemove = useCallback((file) => {
    const newFileList = fileList.filter(f => f.uid !== file.uid);
    setFileList(newFileList);
    if (onUpload) {
      onUpload(newFileList);
    }
    return true;
  }, [fileList, onUpload]);

  // 自定义上传请求
  const customUpload = useCallback(async (options) => {
    const { file, onSuccess, onError } = options;
    
    try {
      setUploading(true);
      
      // 如果是浏览器环境，创建本地预览URL
      if (typeof window !== 'undefined') {
        const url = URL.createObjectURL(file);
        
        // 直接返回成功，图片会显示预览
        setTimeout(() => {
          onSuccess({ url, name: file.name });
          setUploading(false);
        }, 100);
      }
    } catch (error) {
      onError(error);
      setUploading(false);
    }
  }, []);

  // 预览图片
  const previewImage = useCallback((file) => {
    if (!file.url && !file.preview) {
      file.preview = URL.createObjectURL(file.originFileObj || file);
    }
    return file.preview;
  }, []);

  // 拖拽属性
  const draggerProps = {
    name: 'file',
    multiple: true,
    maxCount,
    fileList,
    listType: 'picture-card',
    beforeUpload,
    onChange: handleChange,
    onRemove: handleRemove,
    customRequest: customUpload,
    previewFile: previewImage,
    accept: 'image/*',
    showUploadList: {
      showPreviewIcon: true,
      showRemoveIcon: true,
      showDownloadIcon: false,
    },
    removeIcon: <DeleteOutlined />,
  };

  return (
    <div className="image-uploader">
      {/* 上传区域 */}
      <Dragger {...draggerProps} className="upload-dragger">
        {uploading ? (
          <Spin size="large" />
        ) : (
          <>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">点击或拖拽上传设备图片</p>
            <p className="ant-upload-hint">
              支持单张或批量上传，支持 jpg、png、bmp 格式
            </p>
            <p className="ant-upload-hint" style={{ color: '#999' }}>
              最多上传 {maxCount} 张图片，单张不超过 10MB
            </p>
          </>
        )}
      </Dragger>

      {/* 操作按钮 */}
      <div className="upload-actions">
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

      {/* 提示信息 */}
      <div className="upload-tips">
        <Card size="small" title="识别提示">
          <ul>
            <li>图片应清晰展示设备外观和故障部位</li>
            <li>推荐使用正面拍摄，避免强光和阴影</li>
            <li>异常部位尽量占据图片主体</li>
            <li>识别完成后可点击"生成故障树"继续分析</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

// 导出上传组件
export { Upload };
