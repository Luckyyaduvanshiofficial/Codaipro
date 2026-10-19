<#
.SYNOPSIS
    Builds the Codai Pro Windows app: engine binaries, Codai.exe runtime, and the installer.

.DESCRIPTION
    Run this on Windows from the repository root in a PowerShell prompt:

        powershell -ExecutionPolicy Bypass -File .\build-windows.ps1

    Steps:
      1. Download the official llama.cpp Windows CPU build into engine\.
      2. Install Python build dependencies and produce dist\Codai.exe with PyInstaller.
      3. Install desktop dependencies and produce the NSIS installer with electron-builder.

    Pass -SkipEngine to reuse an existing engine\ folder, or -SkipDesktop to stop
    after Codai.exe is built.

.PARAMETER SkipEngine
    Do not download llama.cpp; use the binaries already in engine\.

.PARAMETER SkipDesktop
    Stop after Codai.exe is built; do not build the Electron installer.

.PARAMETER Model
    Optional path to a .gguf file to bundle with the installer. When omitted the app
    downloads the model on first run (see model_url in config.json).
#>
param(
    [switch]$SkipEngine,
    [switch]$SkipDesktop,
    [string]$Model
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Fail($message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- prerequisites
Step 'Checking prerequisites'
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Fail 'Python 3.10+ is required (python not found on PATH).' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 20+ is required (node not found on PATH).' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is required (not found on PATH).' }
Write-Host "python: $((python --version 2>&1))"
Write-Host "node  : $((node --version 2>&1))"

# ---------------------------------------------------------------- engine
if (-not $SkipEngine) {
    Step 'Downloading llama.cpp Windows engine'
    $releases = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20' -Headers @{ 'User-Agent' = 'CodaiPro-Build' }
    $release = $releases | Where-Object { $_.assets.Count -gt 3 } | Select-Object -First 1
    if (-not $release) { Fail 'Could not find a llama.cpp release.' }
    $asset = $release.assets | Where-Object { $_.name -match 'bin-win-cpu-x64\.zip$' } | Select-Object -First 1
    if (-not $asset) { Fail 'No Windows CPU engine asset found in the latest llama.cpp releases.' }

    Write-Host "Release: $($release.tag_name)  Asset: $($asset.name)"
    $zip = Join-Path $env:TEMP 'codai-engine.zip'
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip
    $tmp = Join-Path $env:TEMP 'codai-engine-extract'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip -DestinationPath $tmp
    $engineDir = Join-Path $root 'engine'
    New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
    # Remove stale binaries (for example a Linux build) so only the Windows engine is packaged.
    Get-ChildItem $engineDir -Force | Remove-Item -Recurse -Force
    Get-ChildItem $tmp -Recurse -File | ForEach-Object { Copy-Item $_.FullName $engineDir -Force }

    # llama-server links against the MSVC runtime. Bundle it app-local so a clean
    # Windows machine without the VC++ Redistributable can still start the engine.
    foreach ($dll in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
        $systemDll = Join-Path $env:WINDIR "System32\$dll"
        if (Test-Path $systemDll) {
            Copy-Item $systemDll $engineDir -Force
        }
        else {
            Write-Warning "Visual C++ runtime $dll was not found in System32; machines without the VC++ Redistributable may fail to start the engine."
        }
    }

    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path (Join-Path $root 'engine\llama-server.exe'))) {
        Fail 'llama-server.exe is missing after extraction.'
    }
    Write-Host 'Engine ready: engine\llama-server.exe'
}

# ---------------------------------------------------------------- Codai.exe
Step 'Installing Python build dependencies'
python -m pip install --upgrade pip | Out-Null
python -m pip install -r requirements.txt pyinstaller

Step 'Building Codai.exe'
python -m PyInstaller --noconfirm Codai.spec
if (-not (Test-Path (Join-Path $root 'dist\Codai.exe'))) { Fail 'PyInstaller did not produce dist\Codai.exe.' }
Write-Host 'Runtime ready: dist\Codai.exe'

if ($SkipDesktop) {
    Step 'Done (desktop build skipped)'
    exit 0
}

# ---------------------------------------------------------------- installer
Step 'Installing desktop dependencies'
$modelFiles = @(Get-ChildItem (Join-Path $root 'models') -Filter '*.gguf' -File -ErrorAction SilentlyContinue)
if ($modelFiles.Count -eq 0) {
    Write-Warning 'No .gguf model in models\; the app will download one on first run.'
}
Push-Location (Join-Path $root 'desktop')
try {
    if (Test-Path 'package-lock.json') { npm ci --include=dev } else { npm install --include=dev }
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }

    if ($Model) {
        if (-not (Test-Path $Model)) { Fail "Model not found: $Model" }
        New-Item -ItemType Directory -Force -Path (Join-Path $root 'models') | Out-Null
        Copy-Item $Model (Join-Path $root 'models') -Force
        Write-Host "Bundling model: $(Split-Path $Model -Leaf)"
    }

    Step 'Building the Windows installer'
    npm run build:win
    if ($LASTEXITCODE -ne 0) { Fail 'electron-builder failed.' }
}
finally {
    Pop-Location
}

Step 'Build complete'
$out = Join-Path $root 'build\desktop'
Get-ChildItem $out -Filter '*.exe' | ForEach-Object { Write-Host "Installer: $($_.FullName)" }
