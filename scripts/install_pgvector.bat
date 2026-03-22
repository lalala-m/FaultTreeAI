@echo off
echo ============================================================
echo pgvector 安装脚本（需要管理员权限运行）
echo ============================================================
echo.
echo 正在复制 vector.dll 到 PostgreSQL lib 目录...
copy /Y "C:\Users\lenovo\pgvector-pg16\pgvector-x86_64-pc-windows-msvc-pg16\lib\vector.dll" "C:\Program Files\PostgreSQL\18\lib\"
if %errorlevel% neq 0 (
    echo [错误] DLL 复制失败，请确认以管理员身份运行此脚本
    pause
    exit /b 1
)
echo.
echo 正在复制 SQL 和 control 文件到 PostgreSQL extension 目录...
xcopy /Y /I "C:\Users\lenovo\pgvector-pg16\pgvector-x86_64-pc-windows-msvc-pg16\share\extension\*.*" "C:\Program Files\PostgreSQL\18\share\extension\"
if %errorlevel% neq 0 (
    echo [错误] SQL 文件复制失败
    pause
    exit /b 1
)
echo.
echo ============================================================
echo 所有文件已复制完成！
echo 现在连接到 PostgreSQL 创建 vector 扩展...
echo ============================================================
echo.

set PGPASSWORD=123456
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -p 5432 -c "CREATE EXTENSION vector;"
if %errorlevel% neq 0 (
    echo [错误] 扩展创建失败
    pause
    exit /b 1
)

echo.
echo ============================================================
echo pgvector 安装成功！
echo ============================================================
pause
