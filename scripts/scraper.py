#!/usr/bin/env python3
"""
设备手册爬虫脚本 - 命令行版本
用法: python scripts/scraper.py --mode download --url "URL"

注意：请确保遵守目标网站的 robots.txt 和使用条款
"""

import argparse
import asyncio
import os
import re
import json
import time
from pathlib import Path
from typing import List, Dict, Optional
from urllib.parse import urljoin, urlparse
import aiohttp
import aiofiles
from bs4 import BeautifulSoup
import hashlib

# 配置
DOWNLOAD_DIR = Path("data/manuals")
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


class ManualScraper:
    """设备手册爬虫"""
    
    def __init__(self, max_concurrent: int = 3, timeout: int = 30):
        self.max_concurrent = max_concurrent
        self.timeout = timeout
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.session: Optional[aiohttp.ClientSession] = None
        self.downloaded_files: List[Dict] = []
        
    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            headers=HEADERS,
            timeout=aiohttp.ClientTimeout(total=self.timeout)
        )
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()
    
    def _get_file_extension(self, url: str) -> str:
        parsed = urlparse(url)
        path = parsed.path.lower()
        for ext in ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.xls']:
            if ext in path:
                return ext
        return ''
    
    def _sanitize_filename(self, name: str) -> str:
        name = re.sub(r'[<>:"/\\|?*]', '', name)
        return name[:200] if len(name) > 200 else name
    
    async def download_file(self, url: str, filename: str = None) -> Optional[str]:
        async with self.semaphore:
            try:
                ext = self._get_file_extension(url)
                if not ext:
                    return None
                
                if not filename:
                    filename = url.split('/')[-1]
                    if '.' not in filename:
                        filename += ext
                
                filename = self._sanitize_filename(filename)
                filepath = DOWNLOAD_DIR / filename
                
                if filepath.exists():
                    print(f"  [跳过] 文件已存在: {filename}")
                    return str(filepath)
                
                print(f"  [下载] {url[:80]}...")
                
                async with self.session.get(url) as response:
                    if response.status == 200:
                        content = await response.read()
                        async with aiofiles.open(filepath, 'wb') as f:
                            await f.write(content)
                        
                        file_info = {
                            "url": url,
                            "filename": filename,
                            "size": len(content),
                        }
                        self.downloaded_files.append(file_info)
                        print(f"  [完成] {filename} ({len(content)} bytes)")
                        return str(filepath)
                    else:
                        print(f"  [失败] {response.status}: {url[:50]}")
                        return None
            except Exception as e:
                print(f"  [错误] {e}")
                return None
    
    async def scrape_page(self, url: str) -> List[str]:
        try:
            async with self.session.get(url) as response:
                if response.status != 200:
                    return []
                
                html = await response.text()
                soup = BeautifulSoup(html, 'html.parser')
                
                links = []
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    if any(ext in href.lower() for ext in ['.pdf', '.docx', '.doc', '.txt']):
                        full_url = urljoin(url, href)
                        links.append(full_url)
                
                return list(set(links))
        except Exception as e:
            print(f"  [错误] 爬取页面: {e}")
            return []


async def download_urls(urls: List[str]):
    """下载URL列表"""
    async with ManualScraper(max_concurrent=2) as scraper:
        for url in urls:
            print(f"\n处理: {url}")
            links = await scraper.scrape_page(url)
            if links:
                print(f"  找到 {len(links)} 个文件链接")
                tasks = [scraper.download_file(link) for link in links[:5]]  # 限制5个
                await asyncio.gather(*tasks)
            else:
                await scraper.download_file(url)
        
        print(f"\n=== 共下载 {len(scraper.downloaded_files)} 个文件 ===")


async def process_files():
    """处理已下载的文件"""
    from backend.core.parser.document import parse_document
    import uuid
    
    files = list(DOWNLOAD_DIR.glob("*"))
    print(f"找到 {len(files)} 个文件")
    
    processed = 0
    for file in files:
        if file.suffix.lower() in ['.pdf', '.txt', '.docx', '.doc']:
            print(f"\n处理: {file.name}")
            try:
                chunks = parse_document(str(file))
                print(f"  提取 {len(chunks)} 个文本块")
                processed += 1
            except Exception as e:
                print(f"  错误: {e}")
    
    print(f"\n=== 共处理 {processed} 个文件 ===")


# 预设的公开知识资源（可直接使用）
PRESET_URLS = [
    # 技术标准网站示例
    "https://www.s私有.com/some-document.pdf",  # 示例
]


def main():
    parser = argparse.ArgumentParser(description="设备手册爬虫")
    parser.add_argument("--mode", choices=["download", "process", "list"], default="list",
                        help="模式: download=下载, process=处理文件, list=列出预设URL")
    parser.add_argument("--url", help="指定URL下载")
    parser.add_argument("--limit", type=int, default=5, help="下载数量限制")
    
    args = parser.parse_args()
    
    print("=" * 50)
    print("设备手册爬虫 - 命令行版本")
    print("=" * 50)
    
    if args.mode == "list":
        print("\n预设的公开资源URL（需要自行添加有效链接）:")
        print("-" * 40)
        print("1. GitHub 搜索: maintenance manual pdf")
        print("2. 技术博客文章")
        print("3. 行业标准摘要")
        print("\n用法示例:")
        print("  python scripts/scraper.py --mode download --url 'https://example.com/manual.pdf'")
        print("  python scripts/scraper.py --mode process")
        
    elif args.mode == "download":
        if args.url:
            asyncio.run(download_urls([args.url]))
        else:
            print("错误: 需要指定 --url 参数")
            print("示例: python scripts/scraper.py --mode download --url 'https://...'")
    
    elif args.mode == "process":
        asyncio.run(process_files())


if __name__ == "__main__":
    main()
