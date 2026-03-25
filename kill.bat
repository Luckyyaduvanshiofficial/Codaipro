@echo off
setlocal EnableExtensions
title Codai Pro - Force Terminator
color 0C

set "ROOT=%~dp0"
pushd "%ROOT%"

echo.
echo     ================================================
echo     [SYSTEM] CHECKING FOR CODAI PROCESSES...
echo     ================================================
echo.

powershell -NoProfile -Command ^
  "$root = [System.IO.Path]::GetFullPath('%ROOT%');" ^
  "$found = @();" ^
  "$targets = Get-CimInstance Win32_Process | Where-Object {" ^
  "  ($_.Name -ieq 'Codai.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) -or" ^
  "  ($_.Name -ieq 'llama-server.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) -or" ^
  "  ($_.Name -ieq 'python.exe' -and $_.CommandLine -and (($_.CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.CommandLine -match 'dev\\controller\.py')))" ^
  "};" ^
  "foreach ($proc in $targets) {" ^
  "  $found += $proc;" ^
  "  Write-Host ('    [KILL   ] ' + $proc.Name + ' PID ' + $proc.ProcessId + '...');" ^
  "  try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; Write-Host ('    [DONE   ] PID ' + $proc.ProcessId + ' terminated.') }" ^
  "  catch { Write-Host ('    [WARN   ] Failed to terminate PID ' + $proc.ProcessId + ': ' + $_.Exception.Message) }" ^
  "};" ^
  "if ($found.Count -eq 0) { Write-Host '    [INFO   ] No Codai process to kill.' }" ^
  "Remove-Item -LiteralPath 'codai_proxy.lock' -Force -ErrorAction SilentlyContinue;" ^
  "Remove-Item -LiteralPath 'logs\codai.lock' -Force -ErrorAction SilentlyContinue"

echo.
echo     ================================================
echo     [SYSTEM] Kill check complete.
echo     ================================================
echo.
echo     Press any key to exit.
pause >nul
popd
exit /b 0
