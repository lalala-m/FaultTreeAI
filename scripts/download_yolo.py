"""
下载 YOLO 模型脚本 - 使用国内镜像加速
"""
import os
import shutil

# 目标目录
data_dir = r'd:\AllProject\FaultTreeAI\data\models'
os.makedirs(data_dir, exist_ok=True)

model_file = os.path.join(data_dir, 'yolo11m.pt')

# 如果已存在则跳过
if os.path.exists(model_file):
    size = os.path.getsize(model_file) / 1024 / 1024
    if size > 30:  # 大于30MB认为下载完成
        print(f"模型已存在: {model_file} ({size:.1f} MB)")
        print("下载完成!")
        exit(0)

print("正在安装 ultralytics...")
os.system('pip install ultralytics -q')

print("\n正在下载 YOLO11m 模型...")
from ultralytics import YOLO

# ultralytics会自动下载
model = YOLO('yolo11m.pt')

# 移动到目标位置
print("\n正在复制模型到目标位置...")
cache_path = os.path.expanduser('~/.cache/ultralytics')
found = False
for root, dirs, files in os.walk(cache_path):
    for f in files:
        if f == 'yolo11m.pt':
            src = os.path.join(root, f)
            shutil.copy(src, model_file)
            found = True
            break
    if found:
        break

if not found:
    # 尝试直接在项目根目录找
    local_path = os.path.join(os.getcwd(), 'yolo11m.pt')
    if os.path.exists(local_path):
        shutil.copy(local_path, model_file)
        found = True

if os.path.exists(model_file):
    size = os.path.getsize(model_file) / 1024 / 1024
    print(f"\n✓ 模型已保存到: {model_file}")
    print(f"✓ 文件大小: {size:.2f} MB")
else:
    print("\n警告: 未能找到模型文件")

print("\n下载完成!")
