@echo off
title Codai Pro - Offline AI Assistant
color 0B
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
pushd "%ROOT%"
set "PROXY_PORT=8080"
set "ENGINE_PORT=8081"

if exist "config.json" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "try { $cfg = Get-Content -Raw -Path '%ROOT%config.json' | ConvertFrom-Json; if ($cfg.port) { [int]$cfg.port } else { 8080 } } catch { 8080 }"`) do set "PROXY_PORT=%%A"
    set /a ENGINE_PORT=!PROXY_PORT!+1
)

:: Use PowerShell to display Unicode art properly
powershell -Command "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Host ''; Write-Host '  ══════════════════════════════════════════════════════════' -ForegroundColor Cyan; Write-Host ''; Write-Host '   ██████╗ ██████╗ ██████╗  █████╗ ██╗  ██████╗ ██████╗  ██████╗' -ForegroundColor Green; Write-Host '  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██║  ██╔══██╗██╔══██╗██╔═══██╗' -ForegroundColor Green; Write-Host '  ██║     ██║   ██║██║  ██║███████║██║  ██████╔╝██████╔╝██║   ██║' -ForegroundColor Green; Write-Host '  ██║     ██║   ██║██║  ██║██╔══██║██║  ██╔═══╝ ██╔══██╗██║   ██║' -ForegroundColor Green; Write-Host '  ╚██████╗╚██████╔╝██████╔╝██║  ██║██║  ██║     ██║  ██║╚██████╔╝' -ForegroundColor Green; Write-Host '   ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝     ╚═╝  ╚═╝ ╚═════╝' -ForegroundColor Green; Write-Host ''; Write-Host '  ══════════════════════════════════════════════════════════' -ForegroundColor Cyan; Write-Host ''"

echo.
echo     [NETWORK] Access points:
echo               1. Frontend:    http://127.0.0.1:%PROXY_PORT%/
echo               2. Logs:        http://127.0.0.1:%PROXY_PORT%/telemetry
echo               3. Engine UI:   http://127.0.0.1:%ENGINE_PORT%/
echo.
echo     Press Ctrl+C in this window to shut down safely.
echo.

:: Check if already running via lock file
if exist "codai_proxy.lock" (
    echo   [WARNING] Codai Pro is already running in another window!
    echo   [WARNING] If not, delete codai_proxy.lock and retry.
    echo.
    pause
    exit /b 1
)

:: Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

:: Check for compiled exe first, fall back to Python
if exist "Codai.exe" (
    echo   [BOOT] Starting Codai.exe...
    echo.
    start "" /wait "%ROOT%Codai.exe"
) else (
    echo   [BOOT] Running from source via Python...
    echo.
    python "%ROOT%dev\controller.py"
)

:: If we reach here, the process has exited
echo.
echo   [SYSTEM] Codai Pro has shut down.
pause
popd
