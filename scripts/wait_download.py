"""等待下载完成并复制模型"""
import os
import shutil
import time

src = r'd:\AllProject\FaultTreeAI\yolo11m.pt'
dst = r'd:\AllProject\FaultTreeAI\data\models\yolo11m.pt'

os.makedirs(os.path.dirname(dst), exist_ok=True)

print("等待下载完成...")
while True:
    if os.path.exists(src):
        size = os.path.getsize(src)
        if size > 40000000:  # 大于40MB认为下载完成
            print(f"下载完成! 大小: {size / 1024 / 1024:.1f} MB")
            break
        print(f"当前大小: {size / 1024 / 1024:.1f} MB / 38.8 MB ({size/40000000*100:.0f}%)", end='\r')
    time.sleep(2)

print("\n复制模型到 data/models...")
shutil.copy(src, dst)
print(f"✓ 模型已保存到: {dst}")

# 验证
final_size = os.path.getsize(dst)
print(f"✓ 最终大小: {final_size / 1024 / 1024:.2f} MB")
print("\n完成!")
