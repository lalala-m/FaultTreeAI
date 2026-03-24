@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ============================================================
:: FaultTreeAI 一键启动脚本
:: 用法: 双击 start.bat，或在项目根目录运行 start.bat
:: ============================================================

set "PROJECT_ROOT=%~dp0"
set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"
set "BACKEND_DIR=%PROJECT_ROOT%\backend"
set "FRONTEND_DIR=%PROJECT_ROOT%\frontend"
set "VENV_DIR=%PROJECT_ROOT%\.venv"

set "GREEN=[92m"
set "YELLOW=[93m"
set "RED=[91m"
set "BLUE=[94m"
set "RESET=[0m"

:: ── 检测是否以管理员权限运行（用于启动某些服务）────────────
net session >nul 2>&1
set "IS_ADMIN=%errorlevel%"

:: ── 辅助函数 ─────────────────────────────────────────────
goto :main

:color_print
echo %~2
goto :eof

:check_command
where %1 >nul 2>&1
if errorlevel 1 (
    echo  [!] %1 未找到，请先安装
    exit /b 1
)
exit /b 0

:check_service_port
netstat -an | findstr "LISTENING" | findstr "%1" >nul 2>&1
if errorlevel 1 (exit /b 1) else (exit /b 0)
exit /b 0

:prompt_yes
set /p "ans=%~1 (Y/N): "
if /i "!ans!"=="Y" exit /b 0
exit /b 1

:: ── 步骤0：检测 Python ───────────────────────────────────
:check_python
where python >nul 2>&1
if errorlevel 1 (
    echo  [✗] Python 未安装，请从 https://www.python.org/downloads/ 安装 Python 3.11+
    pause
    exit /b 1
)
python --version 2>nul | findstr "3\." >nul 2>&1
if errorlevel 1 (
    echo  [✗] Python 版本过低，需要 3.11+
    pause
    exit /b 1
)
echo  [✓] Python 已就绪
exit /b 0

:: ── 步骤1：检测 Node.js ───────────────────────────────────
:check_node
where node >nul 2>&1
if errorlevel 1 (
    echo  [✗] Node.js 未安装，请从 https://nodejs.org/ 安装
    pause
    exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
    echo  [✗] npm 未安装
    pause
    exit /b 1
)
echo  [✓] Node.js !node -v! / npm !npm -v! 已就绪
exit /b 0

:: ── 步骤2：检测 PostgreSQL ────────────────────────────────
:check_postgres
:: 首先检查 5432 端口是否在监听
call :check_service_port 5432
if not errorlevel 1 (
    echo  [✓] PostgreSQL 已在运行 (端口 5432)
    exit /b 0
)

:: 端口未开，尝试检测 psql 命令
where psql >nul 2>&1
if not errorlevel 1 (
    echo  [!] PostgreSQL 未启动，尝试启动...
    :: 尝试启动 PostgreSQL 服务（Windows）
    sc query postgresql-x64-16 >nul 2>&1
    if not errorlevel 1 (
        sc start postgresql-x64-16 >nul 2>&1
        timeout /t 5 >nul
    )
    call :check_service_port 5432
    if not errorlevel 1 (
        echo  [✓] PostgreSQL 已启动
        exit /b 0
    )
)

echo  [✗] PostgreSQL 未运行
echo      请确保 PostgreSQL 已安装并启动（端口 5432）
echo      提示：pgvector 版本推荐 pgvector/pgvector:pg16
echo      Docker 运行: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=faulttree123 -e POSTGRES_DB=faulttree pgvector/pgvector:pg16
set /p "start_docker=  是否尝试用 Docker 启动 PostgreSQL? (Y/N): "
if /i "!start_docker!"=="Y" (
    where docker >nul 2>&1
    if errorlevel 1 (
        echo  [✗] Docker 未安装
        pause
        exit /b 1
    )
    echo  [*] 启动 Docker PostgreSQL（后台运行）...
    docker run -d --name faulttree-postgres ^
        -p 5432:5432 ^
        -e POSTGRES_PASSWORD=faulttree123 ^
        -e POSTGRES_DB=faulttree ^
        pgvector/pgvector:pg16
    if errorlevel 1 (
        echo  [✗] Docker 启动失败，可能端口已被占用或 Docker 未运行
        pause
        exit /b 1
    )
    echo  [*] 等待 PostgreSQL 启动（15秒）...
    timeout /t 15 >nul
    echo  [✓] PostgreSQL Docker 容器已启动
    exit /b 0
) else (
    pause
    exit /b 1
)

:: ── 步骤3：检测 Ollama ────────────────────────────────────
:check_ollama
call :check_service_port 11434
if not errorlevel 1 (
    echo  [✓] Ollama 已在运行 (端口 11434)
    exit /b 0
)

where ollama >nul 2>&1
if errorlevel 1 (
    echo  [✗] Ollama 未安装
    echo      请从 https://ollama.com/ 下载安装
    echo      安装后运行: ollama pull qwen2.5:14b-instruct
    set /p "install_ollama=  是否继续（仅使用 MiniMax 云端 API，不使用本地模型）? (Y/N): "
    if /i "!install_ollama!"=="Y" (
        exit /b 0
    ) else (
        pause
        exit /b 1
    )
)

echo  [!] Ollama 服务未启动，正在启动...
start "" ollama serve
echo  [*] 等待 Ollama 启动（10秒）...
timeout /t 10 >nul
call :check_service_port 11434
if not errorlevel 1 (
    echo  [✓] Ollama 已启动
    exit /b 0
)
echo  [!] Ollama 启动可能有问题，将使用 MiniMax 作为 fallback
exit /b 0

:: ── 步骤4：检查依赖安装 ──────────────────────────────────
:check_deps
:: Python 依赖
if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo  [*] 创建 Python 虚拟环境...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo  [✗] 虚拟环境创建失败
        pause
        exit /b 1
    )
)

echo  [*] 安装后端 Python 依赖（首次约需 3-5 分钟）...
call "%VENV_DIR%\Scripts\pip.exe" install -r "%PROJECT_ROOT%\requirements.txt" --quiet
if errorlevel 1 (
    echo  [!] pip 安装有警告，请检查 requirements.txt
)

:: Node 依赖
if not exist "%FRONTEND_DIR%\node_modules" (
    echo  [*] 安装前端 npm 依赖（首次约需 2-3 分钟）...
    cd /d "%FRONTEND_DIR%"
    call npm install --silent
    if errorlevel 1 (
        echo  [✗] npm install 失败
        pause
        exit /b 1
    )
    cd /d "%PROJECT_ROOT%"
)
echo  [✓] 依赖检查完成
exit /b 0

:: ── 步骤5：检查数据库 Schema ────────────────────────────
:check_db_schema
where psql >nul 2>&1
if errorlevel 1 (
    echo  [!] psql 未安装，跳过 Schema 检查（请手动执行 scripts/init_db.sql）
    exit /b 0
)

echo  [*] 检查数据库 Schema...
psql -h localhost -U postgres -d faulttree -c "SELECT 1" >nul 2>&1
if errorlevel 1 (
    echo  [!] 无法连接数据库，请检查 .env 中的 DB_HOST/DB_PASSWORD
    echo      或手动执行:
    echo      psql -U postgres -d postgres -c "CREATE DATABASE faulttree;"
    echo      psql -U postgres -d faulttree -c "CREATE EXTENSION vector;"
    echo      psql -U postgres -d faulttree -f scripts^init_db.sql
    set /p "skip=  是否跳过并继续启动? (Y/N): "
    if /i "!skip!"=="N" (
        pause
        exit /b 1
    )
    exit /b 0
)

psql -h localhost -U postgres -d faulttree -c "SELECT tablename FROM pg_tables WHERE schemaname='public'" 2>nul | findstr "documents" >nul 2>&1
if errorlevel 1 (
    echo  [!] 数据库 Schema 未初始化，执行 init_db.sql...
    psql -h localhost -U postgres -d faulttree -f "%PROJECT_ROOT%\scripts\init_db.sql" >nul 2>&1
    if errorlevel 1 (
        echo  [!] Schema 初始化失败，请手动执行 scripts^init_db.sql
    ) else (
        echo  [✓] 数据库 Schema 已初始化
    )
) else (
    echo  [✓] 数据库 Schema 已就绪
)
exit /b 0

:: ── 步骤6：启动后端 ──────────────────────────────────────
:start_backend
echo.
echo  ═══════════════════════════════════════════════════════
echo   启动后端 FastAPI (http://localhost:8000)
echo   API 文档: http://localhost:8000/docs
echo  ═══════════════════════════════════════════════════════
echo.
cd /d "%BACKEND_DIR%"
start "FaultTreeAI - Backend" cmd /k "cd /d %BACKEND_DIR% && %VENV_DIR%\Scripts\python.exe -m uvicorn main:app --reload --host 0.0.0.0 --port 8000"
exit /b 0

:: ── 步骤7：启动前端 ──────────────────────────────────────
:start_frontend
echo.
echo  ═══════════════════════════════════════════════════════
echo   启动前端 React (http://localhost:5173)
echo  ═══════════════════════════════════════════════════════
echo.
start "FaultTreeAI - Frontend" cmd /k "cd /d %FRONTEND_DIR% && npm run dev"
exit /b 0

:: ── 步骤8：运行 A/B Benchmark ────────────────────────────
:run_benchmark
set /p "run=  是否运行 LLM Provider A/B 对比测试? (Y/N): "
if /i "!run!"=="Y" (
    echo  [*] 运行 benchmark（Ollama vs MiniMax，约需 5-10 分钟）...
    cd /d "%PROJECT_ROOT%"
    call "%VENV_DIR%\Scripts\python.exe" -m scripts.benchmark_providers
    echo  [*] Benchmark 结果保存在 benchmark_results.json
)
exit /b 0

:: ════════════════════════════════════════════════════════
:: 主流程
:: ════════════════════════════════════════════════════════
:main
cls
echo.
echo  ██████╗  ██████╗ ██████╗ ██╗   ██╗██╗      █████╗ ████████╗██╗ ██████╗ ███╗   ██╗
echo  ██╔══██╗██╔═══██╗██╔══██╗██║   ██║██║     ██╔══██╗╚══██╔══╝██║██╔═══██╗████╗  ██║
echo  ██████╔╝██║   ██║██████╔╝██║   ██║██║     ███████║   ██║   ██║██║   ██║██╔██╗ ██║
echo  ██╔═══╝ ██║   ██║██╔═══╝ ██║   ██║██║     ██╔══██║   ██║   ██║██║   ██║██║╚██╗██║
echo  ██║     ╚██████╔╝██║     ╚██████╔╝███████╗██║  ██║   ██║   ██║╚██████╔╝██║ ╚████║
echo  ╚═╝      ╚═════╝ ╚═╝      ╚═════╝ ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
echo.
echo   工业设备故障树智能生成与辅助构建系统
echo   v3.1 - Multi-Provider LLM (Ollama + MiniMax)
echo.
echo  ───────────────────────────────────────────────────────

call :check_python
if errorlevel 1 exit /b 1

call :check_node
if errorlevel 1 exit /b 1

echo.
echo  ── 环境检测 ───────────────────────────────────────────

call :check_postgres
if errorlevel 1 exit /b 1

call :check_ollama
:: Ollama 失败不阻止启动（MiniMax 可作为 fallback）

echo.
echo  ── 依赖检查 ───────────────────────────────────────────
call :check_deps
if errorlevel 1 exit /b 1

call :check_db_schema
:: Schema 检查失败不阻止启动

echo.
echo  ── 启动服务 ───────────────────────────────────────────

call :start_backend
timeout /t 3 >nul

call :start_frontend

echo.
echo  ── 后续操作 ───────────────────────────────────────────
echo   [1] 打开浏览器访问 http://localhost:5173
echo   [2] API 文档 http://localhost:8000/docs
echo   [3] 运行 benchmark: python -m scripts.benchmark_providers
echo.
echo   LLM 配置 (.env):
echo     LLM_PROVIDER=%LLM_PROVIDER%   (当前主 Provider)
echo     LLM_FALLBACK_PROVIDER=%LLM_FALLBACK_PROVIDER%  (自动回退)
echo.
call :run_benchmark

echo.
echo  全部完成！按任意键退出此窗口...
pause >nul
