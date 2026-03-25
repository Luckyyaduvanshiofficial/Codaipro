# Codai Pro - Product Requirements Document

## Vision

Build a practical offline coding assistant that can run on ordinary Windows machines without depending on cloud APIs or a heavy desktop app shell.

## Primary Users

- students on limited hardware
- developers who want a local-first coding assistant
- contributors who need a small, understandable runtime instead of a large framework stack

## Product Shape

| Area | Decision |
|------|----------|
| Runtime model | Local `llama-server` inference |
| OS focus | Windows first |
| UI delivery | Browser-based local UI |
| Control plane | Python runtime orchestration |
| Startup UX | `run.bat` launcher with readiness checks |

## Core Requirements

### Runtime

- must start locally from the project folder
- must serve the UI through a local HTTP endpoint
- must expose health state to the UI
- must shut down cleanly and release its lock file

### Reliability

- detect duplicate instances
- recover stale locks
- restart the engine after crashes when possible
- write actionable logs for startup and runtime failures

### Contributor Experience

- architecture should stay understandable without a large framework
- startup and shutdown flow should be traceable in logs
- major runtime behavior should be documented in repo docs

## Architecture

| Component | Technology | Responsibility |
|-----------|------------|----------------|
| Launcher | Batch script | start, readiness wait, browser open, stop flow |
| Controller | Python | orchestrate system, proxy, engine, and shutdown |
| Proxy | Python HTTP server | serve UI, expose health, forward chat requests |
| Engine | `llama-server.exe` | text generation |
| Frontend | HTML/CSS/JS | chat UX, polling, status updates |

## Important Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | UI |
| `GET /health` | runtime readiness and engine state |
| `POST /v1/chat/completions` | chat request path |
| `POST /frontend-error` | browser-side error reporting |
| `POST /shutdown` | graceful local shutdown |
| `GET /telemetry` | local telemetry/logs page |

## Operating Model

- configured port hosts the UI and proxy
- engine runs on `configured port + 1`
- launcher waits for `/health` to report `ready`
- UI polls `/health` to keep its state in sync

## Non-Goals

- no dependency on hosted inference for normal usage
- no complex backend framework
- no hidden multi-service deployment story

## Current Risks

- packaged `Codai.exe` can drift from the source runtime
- port-related behavior becomes confusing if docs are not kept current
- local process handling on Windows is easy to get wrong without explicit ownership checks

## Success Criteria

- `run.bat` starts the UI reliably
- the UI can complete a chat request through the proxy
- `kill.bat` only targets Codai-owned processes
- contributors can understand the runtime by reading the docs and a few core files
