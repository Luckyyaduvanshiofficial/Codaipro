# Master Execution Plan: Codai Pro

### 1. Project Overview & Target

Portable offline AI coding assistant for students on legacy college hardware.

| Attribute | Specification |
|-----------|--------------|
| **Project Name** | Codai Pro |
| **Execution** | Portable USB Drive (Plug & Play) |
| **Network** | 100% Offline (No Internet, No APIs) |
| **Target Hardware** | Pentium/i3, 2–4 GB RAM |
| **Distribution** | Open Source (GitHub) |

### 2. Architecture Stack

| Component | Technology | RAM Footprint |
|-----------|-----------|--------------|
| **AI Engine** | llama-server.exe (Native C++) | Extremely Low |
| **Backend** | Python 5-module system (config, system, engine, proxy, controller) | Low |
| **Frontend** | HTML5 / Vanilla JS + HTTP `/health` polling for periodic health checks | Near Zero |
| **Styling** | Vanilla CSS (dark theme, developer UX) | Near Zero |
| **State Sync** | REST for commands + SSE chunking for real-time state/streaming (chat, logs) | Near Zero |

### 3. Model Distribution

| Version | Model (GGUF Q4) | Size | Min RAM |
|---------|-----------------|------|---------|
| **Codai Pro** | Gemma-3-1B-IT-Q4_K_M | ~800 MB | 2 GB |

### 4. Backend Module Structure

| Module | Purpose | Key Features |
|--------|---------|-------------|
| `config.py` | Configuration | External config.json + env vars, cross-platform binary detection, constants |
| `system.py` | Hardware | RAM/CPU detection, CPU-aware threads |
| `engine.py` | Process | Graceful shutdown, ghostly process locks, auto-restart limits |
| `proxy.py` | Gateway | HTTP Semaphore Queues, Request TraceIDs, RAM limits, Timeout limits |
| `controller.py` | Orchestrator | Structured logging (rotation), Singleton PID locks, startup phases |

### 5. Reliability & Safety

| Feature | Implementation |
|---------|---------------|
| Graceful shutdown | terminate → wait(3s) → kill |
| Auto-restart | 3 attempts with backoff (0s → 2s → 5s) |
| Health monitor | Process + port check every 5s (daemon thread, thread-safe) |
| Log rotation | 5 MB × 3 backups (RotatingFileHandler) |
| Instance lock | PID-based codai_proxy.lock with stale detection |
| Reverse Proxy | HTTP 429 Backpressure queues, unified 500 error templates |
| Port conflict | Pre-boot detection with actionable error |

### 6. Frontend Integration

| Feature | Implementation |
|---------|---------------|
| State sync | SystemBridge polls proxy `/health` every 2s |
|             | **SystemBridge:** a frontend service/component that polls the proxy `/health` endpoint every 2s to synchronize system state with the UI. See also: Frontend Architecture section. |
| Status mapping | Engine status → human-readable messages in header |
| Crash UX | Strict JSON parsing + interrupted connection traps |
| Restart UX | Amber spinner notification |
| System info | Footer: "model • threads • ctx" |
| Streaming | Token-by-token with 35ms batch rendering + cursor |

### 7. Development Roadmap

| Phase | Component | Status |
|-------|-----------|--------|
| Phase 1 | Python backend (4 modular files) | ✅ Complete |
| Phase 2 | Chat UI (streaming, stop, markdown, code actions) | ✅ Complete |
| Phase 3 | Engine binaries + model download | ✅ Complete |
| Phase 4 | Production hardening (12 improvements) | ✅ Complete |
| Phase 5 | Frontend-backend integration (14 improvements) | ✅ Complete |
| Phase 6 | Documentation & scripts | ✅ Complete |
| Phase 7 | PyInstaller build + USB packaging | Pending |
| Phase 8 | Legacy hardware testing (2GB/4GB) | Pending |
