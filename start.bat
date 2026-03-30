@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

set "PROJECT_ROOT=%~dp0"
set "PROJECT_ROOT=%PROJECT_ROOT:~0,-1%"
set "BACKEND_DIR=%PROJECT_ROOT%\backend"
set "FRONTEND_DIR=%PROJECT_ROOT%\frontend"
set "VENV_DIR=%PROJECT_ROOT%\.venv"

echo.
echo ===========================================
echo FaultTreeAI Startup Script
echo ===========================================
echo.

REM Check Python
where python >nul 2>&1
if errorlevel 1 (
    echo [X] Python not found
    pause
    exit /b 1
)
echo [OK] Python found

REM Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js not found
    pause
    exit /b 1
)
echo [OK] Node.js found

REM Check PostgreSQL port 5432
netstat -an | findstr "5432" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [!] PostgreSQL not running on port 5432
    echo     Try: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=faulttree123 pgvector/pgvector:pg16
    pause
    exit /b 1
)
echo [OK] PostgreSQL is running

REM Create venv if not exists
if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo [*] Creating virtual environment...
    python -m venv "%VENV_DIR%"
)

REM Install Python deps
echo [*] Installing Python dependencies...
call "%VENV_DIR%\Scripts\pip.exe" install -r "%PROJECT_ROOT%\requirements.txt" -q
echo [OK] Python dependencies installed

REM Install Node deps
if not exist "%FRONTEND_DIR%\node_modules" (
    echo [*] Installing npm dependencies...
    cd /d "%FRONTEND_DIR%"
    call npm install -q
    cd /d "%PROJECT_ROOT%"
)
echo [OK] npm dependencies installed

REM Check .env file
if not exist "%PROJECT_ROOT%\.env" (
    echo [!] .env file not found, copying from .env.example...
    copy "%PROJECT_ROOT%\.env.example" "%PROJECT_ROOT%\.env"
)
echo [OK] .env file ready

echo.
echo ===========================================
echo Starting Backend on http://localhost:8000
echo ===========================================
start "FaultTreeAI Backend" cmd /k "cd /d %BACKEND_DIR% && %VENV_DIR%\Scripts\python.exe -m uvicorn main:app --reload --host 0.0.0.0 --port 8000"

timeout /t 2 >nul

echo.
echo ===========================================
echo Starting Frontend on http://localhost:5173
echo ===========================================
start "FaultTreeAI Frontend" cmd /k "cd /d %FRONTEND_DIR% && npm run dev"

echo.
echo ===========================================
echo Done! Check the new windows for status.
echo Open: http://localhost:5173
echo API Docs: http://localhost:8000/docs
echo ===========================================
echo.
pause
