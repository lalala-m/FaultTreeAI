#!/usr/bin/env python3
"""
项目磁盘清理脚本
安全删除可重建的构建产物、依赖和缓存，不影响功能数据。
"""

import os
import shutil
import sys
from pathlib import Path

# Windows 终端兼容：优先使用 UTF-8 输出中文
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 安全可删除的构建产物 / 依赖 / 缓存（路径相对于项目根目录）
SAFE_PATTERNS = [
    # 安卓构建产物
    "android-app/app/build",
    "android-app/app/release",
    "android-app/*.apk",
    "android-app/*.aab",
    "android-app/.gradle",
    "android-app/build",
    # 前端构建产物与依赖
    "frontend/node_modules",
    "frontend/dist",
    "frontend/.vite",
    # 部署构建产物
    "deploy/vm/frontend/dist",
    "deploy/vm/rtc_bot/build",
    "deploy/vm/rtc_bot/sdk",
    # 临时文件
    ".tmp",
    "*.log",
    "logs",
    # Python 缓存（不进入虚拟环境）
    "**/__pycache__",
    "**/.pytest_cache",
    "**/.coverage",
    "htmlcov",
    # lark cli 压缩包
    "lark-cli-*.tar.gz",
    # 模型下载临时文件
    "*.pt.tmp",
    "*.pth.tmp",
    "*.safetensors.tmp",
]

# 以下路径中的文件即使匹配也不清理（虚拟环境、依赖等）
EXCLUDED_PATH_PARTS = {
    ".venv", "venv", "env", "node_modules", ".git", ".idea", ".gradle"
}


def should_exclude(path: Path) -> bool:
    """如果路径包含任何排除目录，则跳过。"""
    return any(part in EXCLUDED_PATH_PARTS for part in path.parts)


def match_patterns(root: Path, patterns: list[str]) -> list[Path]:
    """使用 glob 匹配所有模式，返回存在的路径列表。排除虚拟环境等。"""
    matched = set()
    for pattern in patterns:
        for path in root.glob(pattern):
            if path.exists() and not should_exclude(path):
                matched.add(path.resolve())
    return sorted(matched)


def human_size(size_bytes: int) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if abs(size_bytes) < 1024:
            return f"{size_bytes:.2f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.2f} TB"


def get_path_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            total += p.stat().st_size
    return total


def find_duplicates(folder: Path, min_size: int = 1024 * 1024) -> dict[str, list[Path]]:
    """按文件内容 md5 查找重复文件（默认>=1MB）。"""
    import hashlib

    hashes: dict[str, list[Path]] = {}
    if not folder.exists():
        return hashes
    for path in folder.rglob("*"):
        if path.is_file() and path.stat().st_size >= min_size:
            h = hashlib.md5()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
            digest = h.hexdigest()
            hashes.setdefault(digest, []).append(path)
    return {h: paths for h, paths in hashes.items() if len(paths) > 1}


def main(dry_run: bool = False) -> None:
    print(f"项目根目录: {PROJECT_ROOT}")
    print(f"模式: {' dry-run ' if dry_run else ' 实际清理 '}")
    print("-" * 60)

    targets = match_patterns(PROJECT_ROOT, SAFE_PATTERNS)
    total_saved = 0

    if not targets:
        print("未找到可清理的构建产物/缓存。")
    else:
        print("发现以下可清理项：")
        for target in targets:
            size = get_path_size(target)
            total_saved += size
            rel = target.relative_to(PROJECT_ROOT)
            print(f"  {rel}  ({human_size(size)})")
            if not dry_run:
                if target.is_file():
                    target.unlink()
                else:
                    shutil.rmtree(target, ignore_errors=True)
        print("-" * 60)
        if dry_run:
            print(f"dry-run: 预计可释放 {human_size(total_saved)}")
        else:
            print(f"已释放空间: {human_size(total_saved)}")

    # 检查手册重复
    print("-" * 60)
    manuals_dirs = [PROJECT_ROOT / "backend" / "data" / "manuals", PROJECT_ROOT / "deploy" / "vm" / "backend" / "data" / "manuals"]
    for manuals_dir in manuals_dirs:
        if not manuals_dir.exists():
            continue
        dups = find_duplicates(manuals_dir)
        if dups:
            print(f"\n[注意]  {manuals_dir.relative_to(PROJECT_ROOT)} 存在重复文件（内容相同）：")
            for digest, paths in dups.items():
                print(f"  校验值 {digest}:")
                for p in paths:
                    print(f"    - {p.relative_to(PROJECT_ROOT)} ({human_size(p.stat().st_size)})")
        else:
            print(f"\n[OK] {manuals_dir.relative_to(PROJECT_ROOT)} 未发现 >=1MB 的重复文件")

    # 检查大文件
    print("-" * 60)
    print("\n当前项目较大文件（>=1MB）：")
    large_files = []
    for path in PROJECT_ROOT.rglob("*"):
        if path.is_file() and path.stat().st_size >= 1024 * 1024:
            rel = path.relative_to(PROJECT_ROOT)
            # 排除隐藏、缓存、依赖目录
            parts = set(rel.parts)
            if parts & {".git", ".venv", "venv", "node_modules", "__pycache__", ".gradle", ".idea"}:
                continue
            large_files.append((rel, path.stat().st_size))
    large_files.sort(key=lambda x: x[1], reverse=True)
    for rel, size in large_files[:30]:
        print(f"  {rel}  ({human_size(size)})")


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv or "-n" in sys.argv
    main(dry_run=dry)
