# Master Execution Plan: Codai Pro

## 1. Project Goal

Codai Pro is a local-first coding assistant for constrained Windows machines. The runtime is intentionally simple:

- a Windows launcher
- a Python controller
- a local `llama-server` process
- a browser UI served through a local proxy

## 2. Architecture Stack

| Component | Technology | Role |
|-----------|------------|------|
| Launcher | `run.bat` | Starts the runtime, waits for readiness, opens the UI |
| Backend | Python (`config`, `system`, `engine`, `proxy`, `controller`) | Runtime orchestration |
| Engine | `llama-server.exe` | Local inference |
| Frontend | HTML / CSS / Vanilla JS | Chat UI and health-driven UX |
| Cleanup | `kill.bat` | Kills Codai-owned processes and clears stale locks |

## 3. Runtime Flow

1. `run.bat` reads `config.json`
2. launcher chooses Python runtime first when available
3. `controller.py` loads config and analyzes hardware
4. proxy starts on the configured port
5. engine starts on `port + 1`
6. launcher waits for `/health` to report `phase=ready`
7. browser opens the UI

## 4. Backend Module Structure

| Module | Purpose | Key Notes |
|--------|---------|-----------|
| `config.py` | Config + constants | JSON/env overrides, runtime constants |
| `system.py` | Hardware analysis | RAM/CPU inspection and tuning |
| `engine.py` | Engine lifecycle | lock file, restart logic, health monitoring |
| `proxy.py` | HTTP gateway | UI serving, `/health`, chat forwarding, `/shutdown` |
| `controller.py` | Orchestrator | startup phases, logging, browser launch, shutdown |

## 5. Reliability Design

| Feature | Current Behavior |
|---------|------------------|
| Instance lock | `logs/codai.lock` with stale-lock recovery |
| Health monitoring | engine process and port checks on an interval |
| Restart policy | restart on crash with bounded retries |
| Log rotation | `codai.log` rotates through backup files |
| Crash reporting | `logs/crash.log` stores fatal tracebacks |
| Graceful shutdown | launcher calls local `/shutdown`, controller tears down proxy and engine |

## 6. Frontend Integration

| Feature | Current Behavior |
|---------|------------------|
| State sync | `SystemBridge` polls `/health` |
| Chat | UI sends `POST /v1/chat/completions` to the proxy |
| Status UX | UI derives state from `phase`, `engine`, and `engine_display` |
| Failure visibility | frontend errors are forwarded to `/frontend-error` |
| Telemetry | `/telemetry` serves the local logs page |

## 7. Current Working Assumptions

- Main platform is Windows.
- Local browser access is expected.
- Source runtime is the most trustworthy path during development.
- `Codai.exe` is optional convenience packaging, not the primary development loop.

## 8. Ongoing Priorities

| Priority | Focus |
|----------|-------|
| P1 | Keep launcher, controller, and proxy behavior aligned |
| P1 | Preserve clear logs and startup diagnostics |
| P2 | Keep docs accurate when ports, locks, or process flow change |
| P2 | Maintain clean local shutdown and stale-lock recovery |
| P3 | Improve packaging reliability for `Codai.exe` |
