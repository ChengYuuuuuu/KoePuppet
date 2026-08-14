@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   对口型是不对的 - 一键启动脚本
echo ========================================
echo.

REM Check ports
netstat -ano | findstr ":8001 " >nul 2>&1
if %errorlevel% equ 0 echo [WARNING] Port 8001 may already be in use!

REM Python backend (port 8001)
echo [1/2] Starting Python backend (FastAPI) ...
start "Backend" /min cmd /c "cd /d "%~dp0backend" && python server.py"

REM Vite frontend (port 5173, stays in this window)
echo [2/2] Starting Vite dev server ...
echo.
echo All services started! Press Ctrl+C to stop the frontend.
echo   Backend  : http://localhost:8001
echo   Frontend : http://localhost:5173
echo.
npx vite
pause
