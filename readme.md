# Codai Pro

**Offline AI Coding Assistant** — runs 100% locally on your CPU. No internet, no APIs, no cloud. Designed for legacy hardware (2–4 GB RAM).

## Quick Start

```
1. Place the Codai folder on your PC or USB drive
2. Double-click run.bat
3. The chat interface opens in your default browser
4. Press Ctrl+C in the terminal to shut down
```

## Architecture

```
Codai/
├── dev/                    # Python backend (modular)
│   ├── config.py           # Constants, CodaiConfig, external config loader
│   ├── system.py           # Hardware detection, system info exposure
│   ├── engine.py           # Process lifecycle, health monitor, auto-restart
│   ├── controller.py       # Orchestrator (entry point)
│   └── requirements.txt    # psutil
├── engine/                 # llama-server C++ binary + DLLs
├── models/                 # GGUF model file
├── ui/                     # Frontend (HTML/CSS/JS)
│   ├── index.html
│   ├── app.js              # Chat UI + SystemBridge polling
│   └── styles.css
├── logs/                   # Created at runtime
│   ├── codai.log           # Application log (rotating, 5MB × 3)
│   ├── engine.log          # llama-server stdout/stderr
│   ├── system_info.json    # Real-time state (frontend reads this)
│   └── codai.lock          # PID lock (instance protection)
├── config.json             # Optional overrides (model, port, threads, ctx)
├── run.bat                 # Windows launcher
├── Codai.exe               # PyInstaller-compiled backend
└── Codai.spec              # PyInstaller build spec
```

## Configuration

### Option 1: Automatic (default)

The backend auto-detects RAM and CPU cores and configures itself:

| RAM | Context | Max Threads | Tier |
|-----|---------|-------------|------|
| < 2.5 GB | 512 | 1 | Low |
| 2.5–6 GB | 1024 | 2 | Standard |
| > 6 GB | 2048 | 4 | High |

Threads are capped at `min(physical_cores, tier_limit)`.

### Option 2: config.json

Create `config.json` in the project root:

```json
{
  "model_name": "gemma-3-1b-it-Q4_K_M.gguf",
  "port": 8080,
  "ctx": 2048,
  "threads": 4,
  "host": "127.0.0.1"
}
```

### Option 3: Environment Variables

```
CODAI_PORT=8080
CODAI_CTX=2048
CODAI_THREADS=4
CODAI_MODEL=gemma-3-1b-it-Q4_K_M.gguf
CODAI_HOST=127.0.0.1
```

Priority: env vars > config.json > auto-detected defaults.

## Features

- **Graceful shutdown** — `Ctrl+C` sends terminate → wait 3s → kill fallback
- **Auto-restart** — engine crashes are detected and restarted (up to 3 attempts with backoff: 0s → 2s → 5s)
- **Health monitoring** — daemon thread checks process + port every 5 seconds
- **Rotating logs** — `codai.log` rotates at 5 MB with 3 backups
- **Engine logging** — `engine.log` captures all llama-server output
- **Instance lock** — prevents duplicate backend instances via PID lock file
- **Atomic state sync** — `system_info.json` written atomically (temp → rename)
- **Frontend polling** — `SystemBridge` reads state every 2s with change detection
- **Crash visibility** — frontend shows "Engine crashed — recovering..." with input disabled
- **System info display** — footer shows model name, threads, context size
- **Cross-platform ready** — auto-detects `.exe` on Windows, no extension on Linux/Mac

## Development

```bash
# Install dependency
pip install psutil

# Run from source
cd Codai
python dev/controller.py

# Build portable executable
pyinstaller Codai.spec
```

## Frontend-Backend Communication

The frontend polls `logs/system_info.json` for real-time state:

```json
{
  "engine_status": "running",
  "startup_phase": "ready",
  "model_name": "gemma-3-1b-it-Q4_K_M.gguf",
  "threads": 2,
  "context_size": 1024,
  "ram_tier": "Tier 2 (Standard)",
  "last_update": "2026-03-25T06:22:00+00:00"
}
```

Status flow: `starting → loading_model → binding_port → running` (or `crashed → restarting → running`).

## License

Open Source — built for students on legacy hardware.
