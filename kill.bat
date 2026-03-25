@echo off
setlocal enabledelayedexpansion
title Codai Pro - Force Terminator
color 0C

echo.
echo     ================================================
echo     [SYSTEM] FORCE CLEANING CODAI PROCESSES...
echo     ================================================
echo.

:: 1. Force kill llama-server
echo     [1/5] Killing AI Engine (llama-server)...
taskkill /F /IM llama-server.exe /T 2>nul

:: 2. Handle specific PIDs from lock files
echo     [2/5] Cleaning lock files and ghost PIDs...
if exist "codai_proxy.lock" (
    set /p CODAI_PID2=<codai_proxy.lock
    REM Validate PID is numeric and running as python.exe or codai*.exe
    echo     [PID2] Checking PID !CODAI_PID2! from codai_proxy.lock...
    echo !CODAI_PID2! | findstr /R "^[0-9][0-9]*$" >nul
    if !errorlevel! == 0 (
        for /f "tokens=1,2 delims= " %%A in ('tasklist /FI "PID eq !CODAI_PID2!" /FO LIST ^| findstr /I "PID Image"') do (
            set "_img=%%B"
            if /I "%%A"=="Image:" if /I "%%B"=="python.exe" (
                taskkill /F /PID !CODAI_PID2! /T 2>nul
                del /F /Q "codai_proxy.lock" 2>nul
            ) else if /I "%%A"=="Image:" if /I "%%B" NEQ "" if /I "%%B:~0,5"=="Codai" (
                taskkill /F /PID !CODAI_PID2! /T 2>nul
                del /F /Q "codai_proxy.lock" 2>nul
            ) else (
                echo     [WARN] PID !CODAI_PID2! is not a Codai process. Skipping.
            )
        )
    ) else (
        echo     [WARN] codai_proxy.lock PID is not numeric. Skipping.
    )
)
)
if exist "logs\codai.lock" (
    set /p CODAI_PID3=<logs\codai.lock
    REM Validate PID is numeric and running as python.exe or codai*.exe
    echo     [PID3] Checking PID !CODAI_PID3! from logs\codai.lock...
    echo !CODAI_PID3! | findstr /R "^[0-9][0-9]*$" >nul
    if !errorlevel! == 0 (
        for /f "tokens=1,2 delims= " %%A in ('tasklist /FI "PID eq !CODAI_PID3!" /FO LIST ^| findstr /I "PID Image"') do (
            set "_img=%%B"
            if /I "%%A"=="Image:" if /I "%%B"=="python.exe" (
                taskkill /F /PID !CODAI_PID3! /T 2>nul
                del /F /Q "logs\codai.lock" 2>nul
            ) else if /I "%%A"=="Image:" if /I "%%B" NEQ "" if /I "%%B:~0,5"=="Codai" (
                taskkill /F /PID !CODAI_PID3! /T 2>nul
                del /F /Q "logs\codai.lock" 2>nul
            ) else (
                echo     [WARN] PID !CODAI_PID3! is not a Codai process. Skipping.
            )
        )
    ) else (
        echo     [WARN] logs\codai.lock PID is not numeric. Skipping.
    )
)
)

:: 3. Kill all python controllers
echo     [3/5] Terminating Codai-related Python processes...
REM Only kill python.exe processes running Codai (by command line)
for /f "skip=3 tokens=2 delims=, " %%P in ('wmic process where "name='python.exe'" get ProcessId /format:csv') do (
    for /f "tokens=2,* delims= " %%A in ('wmic process where "ProcessId=%%P" get CommandLine /value') do (
        echo %%B | findstr /I "codai" >nul && taskkill /F /PID %%P /T 2>nul
    )
)

:: 4. Final state check
echo     [4/5] Clearing all residue...
taskkill /F /IM Codai.exe /T 2>nul

:: 5. System Reset Complete.
echo     [5/5] All Codai processes have been purged.

echo.
echo     ================================================
echo     [SUCCESS] All Codai processes have been terminated.
echo     [SUCCESS] You can now safely run run.bat
echo     ================================================
echo.
echo     Press any key to exit.
pause >nul
exit /b 0
