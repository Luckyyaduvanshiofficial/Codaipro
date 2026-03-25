@echo off
title Codai Pro - Offline AI Assistant
color 0B
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
pushd "%ROOT%"

set "PROXY_PORT=8080"
set "ENGINE_PORT=8081"
set "MODEL_NAME=gemma-3-1b-it-Q4_K_M.gguf"
set "START_URL=http://127.0.0.1:8080/"
set "HEALTH_URL=http://127.0.0.1:8080/health"
set "SHUTDOWN_URL=http://127.0.0.1:8080/shutdown"
set "CODAI_PID="
set "START_MODE="
set "HAS_PYTHON=0"
set "RETRIED_WITH_PYTHON=0"
set "WAIT_SECONDS=60"

if not exist "logs" mkdir logs

call :read_config_ports
call :read_config_model
set "START_URL=http://127.0.0.1:%PROXY_PORT%/"
set "HEALTH_URL=http://127.0.0.1:%PROXY_PORT%/health"
set "SHUTDOWN_URL=http://127.0.0.1:%PROXY_PORT%/shutdown"

call :print_banner
call :print_runtime_summary
call :preflight_checks
if errorlevel 1 goto :launcher_fail

call :check_existing_instance
if errorlevel 1 goto :launcher_fail

call :launch_runtime
if errorlevel 1 goto :launcher_fail

call :wait_for_health
if errorlevel 1 goto :startup_not_ready

echo.
echo   [READY] Codai responded successfully on %START_URL%
echo   [OPEN ] Launching browser...
start "" "%START_URL%"
echo.
echo   [INFO ] Runtime PID: %CODAI_PID%
echo   [INFO ] This launcher window will stay open.
echo   [INFO ] Press any key here to stop Codai safely.
echo.

call :wait_for_user_stop
call :stop_runtime
if errorlevel 1 goto :launcher_fail
goto :shutdown_summary

:startup_not_ready
if /i "%START_MODE%"=="exe" if "%HAS_PYTHON%"=="1" if "%RETRIED_WITH_PYTHON%"=="0" (
    echo.
    echo   [WARN ] Codai.exe did not become ready. Retrying with Python source runtime...
    set "RETRIED_WITH_PYTHON=1"
    set "START_MODE=python"
    set "CODAI_PID="
    call :launch_runtime
    if errorlevel 1 goto :launcher_fail
    call :wait_for_health
    if not errorlevel 1 goto :startup_ready
)
echo.
echo   [ERROR] Codai did not become ready within %WAIT_SECONDS% seconds.
echo   [ERROR] The process may have failed during startup.
if defined CODAI_PID (
    echo   [ERROR] Runtime PID: %CODAI_PID%
)
echo   [ERROR] Check logs\codai.log and logs\crash.log for details.
echo.
call :print_log_tail "logs\codai.log"
goto :launcher_fail

:startup_ready
echo.
echo   [READY] Codai responded successfully on %START_URL%
echo   [OPEN ] Launching browser...
start "" "%START_URL%"
echo.
echo   [INFO ] Runtime PID: %CODAI_PID%
echo   [INFO ] This launcher window will stay open.
echo   [INFO ] Press any key here to stop Codai safely.
echo.

call :wait_for_user_stop
call :stop_runtime
if errorlevel 1 goto :launcher_fail
goto :shutdown_summary

:shutdown_summary
echo.
echo   [SYSTEM] Codai Pro has shut down.
call :print_log_tail "logs\codai.log"
echo.
pause
popd
exit /b 0

:launcher_fail
echo.
echo   [SYSTEM] Launcher finished with an error.
echo.
pause
popd
exit /b 1

:read_config_ports
if exist "config.json" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "try { $cfg = Get-Content -Raw -Path '%ROOT%config.json' | ConvertFrom-Json; if ($cfg.port) { [int]$cfg.port } else { 8080 } } catch { 8080 }"`) do set "PROXY_PORT=%%A"
)
set /a ENGINE_PORT=%PROXY_PORT%+1
exit /b 0

:read_config_model
if exist "config.json" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "try { $cfg = Get-Content -Raw -Path '%ROOT%config.json' | ConvertFrom-Json; if ($cfg.model_name) { [string]$cfg.model_name } else { 'gemma-3-1b-it-Q4_K_M.gguf' } } catch { 'gemma-3-1b-it-Q4_K_M.gguf' }"`) do set "MODEL_NAME=%%A"
)
exit /b 0

:print_banner
echo.
echo   ==========================================================
echo                     CODAI PRO LAUNCHER
echo   ==========================================================
echo.
exit /b 0

:print_runtime_summary
echo.
echo     [RUNTIME] Local startup summary:
echo               Proxy URL:   %START_URL%
echo               Health URL:  %HEALTH_URL%
echo               Shutdown:    %SHUTDOWN_URL%
echo               Engine URL:  http://127.0.0.1:%ENGINE_PORT%/
echo               Base Path:   %ROOT%
echo.
exit /b 0

:preflight_checks
if exist "dev\controller.py" (
    where python >nul 2>nul
    if not errorlevel 1 set "HAS_PYTHON=1"
)

if not exist "engine\llama-server.exe" (
    echo   [ERROR] Missing engine binary: engine\llama-server.exe
    exit /b 1
)

if not exist "ui\index.html" (
    echo   [ERROR] Missing UI entry file: ui\index.html
    exit /b 1
)

if not exist "models\%MODEL_NAME%" (
    echo   [ERROR] Missing model file: models\%MODEL_NAME%
    echo   [ERROR] Install or copy the configured GGUF model before launching Codai.
    exit /b 1
)

if exist ".git" if "%HAS_PYTHON%"=="1" (
    set "START_MODE=python"
) else if exist "Codai.exe" (
    set "START_MODE=exe"
) else if "%HAS_PYTHON%"=="1" (
    set "START_MODE=python"
) else (
    echo   [ERROR] Neither a working Python runtime nor Codai.exe is available.
    echo   [ERROR] Install Python or provide a fresh Codai.exe build in the project root.
    exit /b 1
)

if /i "%START_MODE%"=="python" (
    echo   [INFO ] Using Python source runtime from dev\controller.py
) else (
    echo   [INFO ] Using packaged runtime: Codai.exe
)

exit /b 0

:check_existing_instance
if exist "logs\codai.lock" (
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "try { $pid = [int](Get-Content -Path '%ROOT%logs\codai.lock' -Raw).Trim(); if ((Get-Process -Id $pid -ErrorAction SilentlyContinue)) { 'RUNNING:' + $pid } else { 'STALE:' + $pid } } catch { 'STALE:unknown' }"`) do set "LOCK_STATE=%%A"
    if /i "!LOCK_STATE:~0,8!"=="RUNNING:" (
        echo   [WARNING] Another Codai instance appears to be running with PID !LOCK_STATE:~8!.
        echo   [WARNING] Close the other instance before starting a new one.
        exit /b 1
    )
    echo   [INFO ] Found a stale lock file. The runtime will reclaim it during startup.
)
exit /b 0

:launch_runtime
if /i "%START_MODE%"=="exe" (
    echo   [BOOT ] Starting Codai.exe...
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$p = Start-Process -FilePath '%ROOT%Codai.exe' -WorkingDirectory '%ROOT%' -PassThru; $p.Id"`) do set "CODAI_PID=%%A"
) else (
    echo   [BOOT ] Running from source via Python...
    for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$p = Start-Process -FilePath 'python' -ArgumentList '%ROOT%dev\controller.py' -WorkingDirectory '%ROOT%' -PassThru; $p.Id"`) do set "CODAI_PID=%%A"
)

if not defined CODAI_PID (
    echo   [ERROR] Failed to start the runtime process.
    exit /b 1
)

echo   [BOOT ] Process started with PID %CODAI_PID%
exit /b 0

:wait_for_health
echo   [WAIT ] Waiting for local service to respond...
for /l %%S in (1,1,%WAIT_SECONDS%) do (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 2; $payload = $r.Content | ConvertFrom-Json; if ($r.StatusCode -eq 200 -and $payload.status -eq 'ok' -and $payload.data.phase -eq 'ready' -and $payload.data.engine -eq 'running') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
    if not errorlevel 1 exit /b 0
    <nul set /p "=."
    timeout /t 1 /nobreak >nul
)
echo.
exit /b 1

:wait_for_user_stop
echo   [WAIT ] Press any key to stop Codai and close this launcher...
pause >nul
exit /b 0

:stop_runtime
if not defined CODAI_PID exit /b 0
echo   [STOP ] Stopping runtime PID %CODAI_PID%...
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%SHUTDOWN_URL%' -Method POST -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
    echo   [WARN ] Graceful shutdown request failed. Waiting briefly for the process to exit...
) else (
    echo   [STOP ] Shutdown request sent successfully.
)
for /l %%S in (1,1,10) do (
    powershell -NoProfile -Command "if (Get-Process -Id %CODAI_PID% -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>nul
    if not errorlevel 1 exit /b 0
    timeout /t 1 /nobreak >nul
)
echo   [WARN ] Runtime PID %CODAI_PID% is still active after the graceful shutdown wait.
exit /b 1

:print_log_tail
if not exist "%~1" exit /b 0
echo   [LOG  ] Recent lines from %~1
powershell -NoProfile -Command "Get-Content -Path '%ROOT%%~1' -Tail 12" 2>nul
exit /b 0
