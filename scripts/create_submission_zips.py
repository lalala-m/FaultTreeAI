import os
import shutil
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SUBMIT_DIR = PROJECT_ROOT / "submit"
TEAM_ID = "09011551"

# 文件与目录排除模式（用于源码包）
SOURCE_IGNORE_PATTERNS = (
    ".git", ".venv", "node_modules", ".gradle", ".kotlin", ".idea",
    "__pycache__", "*.pyc", "*.pyo", ".DS_Store", "Thumbs.db",
    "desktop.ini", "*.log", "~$*.docx", "*.tmp", "*.bak",
    "submit", "NUL",
)


def clean_pycache(stage: Path):
    for p in list(stage.rglob("__pycache__")):
        shutil.rmtree(p, ignore_errors=True)
    for p in list(stage.rglob("*.pyc")):
        p.unlink(missing_ok=True)


def zip_directory(src_dir: Path, zip_path: Path):
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(src_dir):
            for f in files:
                fp = Path(root) / f
                rel = fp.relative_to(src_dir)
                zf.write(fp, rel)
    return zip_path.stat().st_size


def stage_work():
    """作品安装/可执行文件：部署运行包"""
    stage = SUBMIT_DIR / "work"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    # 后端源码（运行时必需）
    shutil.copytree(PROJECT_ROOT / "backend", stage / "backend")

    # 前端构建产物
    shutil.copytree(PROJECT_ROOT / "frontend" / "dist", stage / "dist")

    # 数据：模型、样本、模板、初始化 SQL
    (stage / "data").mkdir()
    shutil.copytree(PROJECT_ROOT / "data" / "models", stage / "data" / "models")
    shutil.copytree(PROJECT_ROOT / "data" / "samples", stage / "data" / "samples")
    shutil.copytree(PROJECT_ROOT / "data" / "templates", stage / "data" / "templates")
    shutil.copy(PROJECT_ROOT / "data" / "import_knowledge.sql", stage / "data" / "import_knowledge.sql")

    # 依赖与配置模板
    shutil.copy(PROJECT_ROOT / "requirements.txt", stage / "requirements.txt")
    shutil.copy(PROJECT_ROOT / ".env.example", stage / ".env.example")
    shutil.copy(PROJECT_ROOT / ".env.docker", stage / ".env.docker")

    # 部署文件
    for f in ["docker-compose.yml", "Dockerfile", "nginx.conf", "start.bat"]:
        if (PROJECT_ROOT / f).exists():
            shutil.copy(PROJECT_ROOT / f, stage / f)
    if (PROJECT_ROOT / "frontend" / "Dockerfile").exists():
        shutil.copy(PROJECT_ROOT / "frontend" / "Dockerfile", stage / "frontend.Dockerfile")

    # 部署脚本
    shutil.copy(PROJECT_ROOT / "scripts" / "deploy_kylin.sh", stage / "deploy_kylin.sh")

    # deploy/vm（不含 .env 敏感信息）
    if (PROJECT_ROOT / "deploy" / "vm").exists():
        shutil.copytree(
            PROJECT_ROOT / "deploy" / "vm",
            stage / "deploy",
            ignore=shutil.ignore_patterns(".env"),
        )

    # 说明文档
    shutil.copy(PROJECT_ROOT / "README.md", stage / "README.md")
    shutil.copy(
        PROJECT_ROOT / "deliverables" / "competition_docs" / "5.软件安装包及部署文档.docx",
        stage / "5.软件安装包及部署文档.docx",
    )

    install_md = stage / "README-安装说明.md"
    install_md.write_text(
        """# 故障检修系统 安装说明

本压缩包为 B/S 架构 Web 应用的部署运行包，支持在银河麒麟高级服务器操作系统 V10/V11（LoongArch）上部署。

## 1. 环境要求

- 银河麒麟高级服务器操作系统 V10/V11（LoongArch）
- Python 3.11+
- PostgreSQL 14+（需安装 pgvector 扩展）
- Node.js 18+（前端已预编译，部署时无需 Node，二次开发需要）

## 2. 快速部署步骤

1. 解压本压缩包到服务器目录，如 `/opt/faulttree`。  
2. 复制 `.env.example` 为 `.env`，填写数据库、LLM API、VLM API、RTC 等配置。  
3. 创建 PostgreSQL 数据库并启用 pgvector：  
   `CREATE DATABASE faulttree; CREATE EXTENSION IF NOT EXISTS vector;`  
4. 安装后端依赖：  
   `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`  
5. 启动后端：  
   `python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000`  
6. 使用 Nginx 将 `dist/` 目录作为静态站点，并将 `/api` 反向代理到 `http://127.0.0.1:8000`。  

详细说明请查看 `5.软件安装包及部署文档.docx` 与 `deploy_kylin.sh` 脚本。

## 3. 移动端

Android App 源码见 `09011551源码.zip`，构建 APK 后安装即可。
""",
        encoding="utf-8",
    )

    clean_pycache(stage)
    return stage


def stage_source():
    """作品源码：完整源代码与文档"""
    stage = SUBMIT_DIR / "source"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    ignore = shutil.ignore_patterns(*SOURCE_IGNORE_PATTERNS)

    def _should_skip(name: str) -> bool:
        if name in SOURCE_IGNORE_PATTERNS or name == "submit":
            return True
        for pat in SOURCE_IGNORE_PATTERNS:
            if pat.startswith("*") and name.endswith(pat[1:]):
                return True
        return False

    for item in PROJECT_ROOT.iterdir():
        if _should_skip(item.name):
            continue
        if item.is_dir():
            shutil.copytree(item, stage / item.name, ignore=ignore)
        else:
            shutil.copy(item, stage / item.name)

    # 清理构建产物（源码包中不需要 dist）
    if (stage / "frontend" / "dist").exists():
        shutil.rmtree(stage / "frontend" / "dist")

    clean_pycache(stage)
    return stage


def stage_intro():
    """介绍 PPT/演示视频和文档"""
    stage = SUBMIT_DIR / "intro"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    ppt = PROJECT_ROOT / "deliverables" / "故障检修系统_项目介绍.pptx"
    if ppt.exists():
        shutil.copy(ppt, stage / "故障检修系统_项目介绍.pptx")

    docs_dir = PROJECT_ROOT / "deliverables" / "competition_docs"
    for f in docs_dir.glob("*.docx"):
        if f.name.startswith("~$"):
            continue
        shutil.copy(f, stage / f.name)

    (stage / "请把演示视频放到本目录后重新压缩.txt").write_text(
        "要求：avi、mp4、wmv 之一，时长不超过 7 分钟。\n"
        "请将视频文件放入本目录后，重新压缩为 09011551介绍.zip。\n",
        encoding="utf-8",
    )
    return stage


def stage_registration():
    """报名表和学生证：仅生成占位说明，需要用户自行补齐"""
    stage = SUBMIT_DIR / "registration"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    (stage / "请把报名表和学生证放到本目录后重新压缩.txt").write_text(
        "请将报名表扫描件（或照片）和学生证扫描件（或照片）放入本目录，\n"
        "然后重新压缩为 09011551报名.zip。\n",
        encoding="utf-8",
    )
    return stage


def main():
    SUBMIT_DIR.mkdir(parents=True, exist_ok=True)

    mapping = {
        "work": "作品",
        "source": "源码",
        "intro": "介绍",
        "registration": "报名",
    }

    stagers = {
        "work": stage_work,
        "source": stage_source,
        "intro": stage_intro,
        "registration": stage_registration,
    }

    for key, stager in stagers.items():
        s = stager()
        zip_name = f"{TEAM_ID}{mapping[key]}.zip"
        zip_path = SUBMIT_DIR / zip_name
        size = zip_directory(s, zip_path)
        print(f"已生成 {zip_name}，大小 {size / 1024 / 1024:.2f} MB")

    print(f"\n所有打包文件位于：{SUBMIT_DIR}")


if __name__ == "__main__":
    main()
