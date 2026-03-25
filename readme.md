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
│   ├── engine.py           # Process lifecycle, ghost-process killer, limits
│   ├── proxy.py            # Unified Reverse Proxy (concurrency, OOM safety)
│   ├── controller.py       # Orchestrator (entry point)
│   └── requirements.txt    # psutil
├── engine/                 # llama-server C++ binary + DLLs
├── models/                 # GGUF model file
├── ui/                     # Frontend (HTML/CSS/JS)
│   ├── index.html
│   ├── app.js              # Chat UI + Proxy Polling
│   └── styles.css
├── logs/                   # Created at runtime
│   ├── codai.log           # Application log (rotating, 5MB × 3)
│   └── engine.log          # llama-server stdout/stderr
├── config.json             # Optional overrides (model, port, threads, ctx)

# Debug mode: To enable verbose logging for development/testing, set "debug": true in config.json or set the environment variable CODAI_DEBUG=true before launching.
├── logs/codai.lock         # Primary Instance lock
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
- **Auto-restart** — engine crashes are detected and restarted. Over 3 crashes in 60s locks the queue.
- **Health monitoring** — daemon thread checks process + port every 5 seconds
- **Rotating logs** — `codai.log` rotates at 5 MB with 3 backups
- **Engine logging** — `engine.log` captures all llama-server output
- **Instance lock** — prevents duplicate proxy instances via `codai_proxy.lock`
- **Reverse Proxy** — All frontend requests pass through `proxy.py` adding `request_id` tracing and HTTP 429 backpressure queues.
- **OOM Defense** — Mid-stream RAM polling automatically aborts text generation if system memory falls below 300MB.
- **Frontend polling** — `SystemBridge` pings the `/health` API for atomic state updates.
- **Crash visibility** — frontend rigidly reflects engine failures, parsing errors, and network disconnects.
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

The frontend coordinates with the **Python Reverse Proxy** via HTTP endpoints:

```json
// GET http://127.0.0.1:8080/health
{
  "status": "ok",
  "engine": "running",
  "proxy": "active",
  "mode": "offline",
  "queue": 0,
  "memory": "stable",
  "uptime": "25.3s",
  "requests_handled": 3,
  "debug": false
}
```

Status flow: `starting → loading_model → binding_port → running` (or `crashed → restarting → running`).

All `/v1/chat/completions` API calls navigate the Proxy's `Semaphore(2)` queue. If overloaded, it responds with `HTTP 429 Too Many Requests` featuring a `Retry-After: 2` header, which the frontend autonomously parses and respects via auto-retry timers.

## License

Open Source — built for students on legacy hardware.
