
@echo off
chcp 65001 >nul
echo ========================================
echo   故障检修系统 一键启动
echo ========================================
echo.

REM 检查是否存在 .env 文件
if not exist ".env" (
    echo [提示] 未找到 .env 文件，正在从 .env.example 创建...
    copy ".env.example" ".env"
    echo.
    echo [!] 请编辑 .env 文件配置您的 API 密钥！
    echo.
)

REM 检查 SSL 证书
if not exist "ssl\cert.pem" (
    echo [提示] 未找到 SSL 证书，正在生成...
    python tools\generate_cert.py
    echo.
)

echo [*] 正在启动服务...
echo.

REM 尝试用 docker compose（新版本），失败则用 docker-compose（旧版本）
docker compose up -d --build 2>nul
if errorlevel 1 (
    docker-compose up -d --build
)

echo.
echo ========================================
echo   启动完成！
echo ========================================
echo.
echo 访问地址：
echo   - HTTP (浏览器): http://localhost:5173
echo   - HTTPS (App): https://192.168.43.122:8443
echo   - API 文档: http://localhost:8000/docs
echo.
echo 查看日志: docker compose logs -f ^(或 docker-compose logs -f^)
echo 停止服务: docker compose down ^(或 docker-compose down^)
echo.
pause

