@echo off
title Codai Pro - Offline AI Assistant
color 0B

echo ========================================================
echo.
echo    ██████╗ ██████╗ ██████╗  █████╗ ██╗   ██████╗ ██████╗  ██████╗ 
echo   ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██║   ██╔══██╗██╔══██╗██╔═══██╗
echo   ██║     ██║   ██║██║  ██║███████║██║   ██████╔╝██████╔╝██║   ██║
echo   ██║     ██║   ██║██║  ██║██╔══██║██║   ██╔═══╝ ██╔══██╗██║   ██║
echo   ╚██████╗╚██████╔╝██████╔╝██║  ██║██║   ██║     ██║  ██║╚██████╔╝
echo    ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝   ╚═╝     ╚═╝  ╚═╝ ╚═════╝ 
echo.
echo ========================================================
echo.
echo   [SYSTEM] Production-grade offline AI runtime
echo   [ENGINE] Gemma 3 1B (Q4_K_M) on llama-server
echo   [MODE]   CPU-only, auto-tuned for your hardware
echo   [LOGS]   logs\codai.log, logs\engine.log
echo.
echo   Press Ctrl+C in this window to shut down safely.
echo.
echo ========================================================
echo.

:: Check if already running via lock file
if exist "logs\codai.lock" (
    echo [WARNING] A Codai instance may already be running.
    echo [WARNING] If not, delete logs\codai.lock and retry.
    echo.
    pause
    exit /b 1
)

:: Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

:: Check for compiled exe first, fall back to Python
if exist "Codai.exe" (
    echo [BOOT] Starting Codai.exe...
    Codai.exe
) else (
    echo [BOOT] Running from source via Python...
    python dev\controller.py
)

:: If we reach here, the process has exited
echo.
echo [SYSTEM] Codai has shut down.
pause
