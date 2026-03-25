# Codai Pro — Product Requirements Document

## Vision

A portable, offline AI coding assistant that runs on legacy college hardware (2–4 GB RAM, Pentium/i3 CPUs) from a USB drive with zero internet dependency.

## Target Users

MCA and engineering students on locked-down lab computers with limited RAM and no internet access.

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | Windows 10+ | Windows 10/11 |
| CPU | Pentium / i3 | i3+ |
| RAM | 2 GB | 4 GB |
| Disk | 1.5 GB free | 2 GB free |
| Network | None | None |
| Browser | Chrome / Edge | Chrome |

## Architecture

| Component | Technology | Purpose |
|-----------|-----------|---------|
| AI Engine | llama-server.exe (C++) | Local inference |
| Backend | Python (4 modules) | Process management, hardware detection, logging |
| Frontend | HTML5 / Vanilla JS / CSS | Chat UI, streaming, status sync |
| Model | Gemma 3 1B IT Q4_K_M (GGUF) | 800 MB, optimized for low RAM |
| Build | PyInstaller | Portable single exe |

## Backend Modules

| Module | Responsibility |
|--------|---------------|
| `config.py` | Constants, external config (JSON + env), path resolution, cross-platform |
| `system.py` | RAM/CPU detection, tier allocation, system_info.json (atomic writes) |
| `engine.py` | Process boot/shutdown, health monitor, auto-restart, instance lock |
| `controller.py` | Orchestrator, structured logging (rotation), signal handling, UI launch |

## Frontend Integration

| Feature | Implementation |
|---------|---------------|
| State sync | `SystemBridge` polls `system_info.json` every 2s |
| Status display | Header indicator maps engine status to human-readable text |
| Crash handling | Notification banner + input disabled + auto-recovery |
| System info | Footer bar: model • threads • ctx |
| Streaming | Token-by-token with 35ms batch rendering |
| Stop | AbortController with partial response preservation |

## Reliability Features

| Feature | Mechanism |
|---------|-----------|
| Graceful shutdown | terminate → wait(3s) → kill |
| Auto-restart | Up to 3 attempts with backoff (0s → 2s → 5s) |
| Health monitoring | Process poll + port check every 5s |
| Log rotation | 5 MB × 3 backups |
| Instance lock | PID-based lock file |
| Atomic state | temp file → os.replace |
| Port conflict | Pre-boot detection with actionable error |

## Anti-Hallucination Protocols

| Protocol | Setting | Purpose |
|----------|---------|---------|
| Temperature | 0.1 | Forces deterministic output |
| Context limit | 512–2048 (auto) | Prevents memory exhaustion |
| System prompt | Hidden directive | "Say I don't know instead of guessing" |

## Configuration Priority

1. Environment variables (`CODAI_*`)
2. `config.json` in project root
3. Auto-detected hardware defaults

## Development Roadmap

| Phase | Component | Status |
|-------|-----------|--------|
| Phase 1 | Modular Python backend (4 modules) | ✅ Complete |
| Phase 2 | Chat UI with streaming + status sync | ✅ Complete |
| Phase 3 | Engine binaries + model distribution | ✅ Complete |
| Phase 4 | Production hardening (all 12 items) | ✅ Complete |
| Phase 5 | Frontend-backend integration (14 items) | ✅ Complete |
| Phase 6 | PyInstaller build + USB packaging | Pending |
| Phase 7 | Legacy hardware testing (2GB/4GB) | Pending |
