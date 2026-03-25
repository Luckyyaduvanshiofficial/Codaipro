# Codai Pro Documentation

This file is the detailed developer-facing documentation for the project.

Use this document when:

- you are onboarding a new developer
- you want one file that explains how the project works end to end
- you need a reference while updating `readme.md`, `docs/prd.md`, `docs/docs_Plan.md`, or contributor docs
- you want the current practical behavior of the app, not just the original plan

This is intentionally more detailed than the README.

## 1. Project Summary

Codai Pro is a local-first AI coding assistant that runs on Windows with:

- a Windows launcher
- a Python runtime controller
- a local `llama-server.exe` engine
- a browser UI

The app is designed around simplicity and local ownership:

- the browser talks to a local proxy
- the proxy talks to the engine
- the controller owns startup, health, restart behavior, and shutdown

The main development runtime is the Python source path, not the packaged exe.

## 2. Current Runtime Model

At the time of writing, the project behaves like this:

1. `run.bat` starts the app.
2. The launcher reads `config.json`.
3. The launcher prefers `python dev/controller.py` if Python is available.
4. The controller loads config and hardware settings.
5. The controller starts the proxy on the configured port.
6. The controller starts `llama-server.exe` on `port + 1`.
7. The launcher waits for `/health` to report that the runtime is actually ready.
8. The launcher opens the browser UI.
9. The launcher stays open and can stop the runtime through a graceful shutdown request.

That means the actual local stack is:

- launcher: `run.bat`
- controller: `dev/controller.py`
- proxy: `dev/proxy.py`
- engine manager: `dev/engine.py`
- UI: `ui/index.html` + `ui/app.js` + `ui/styles.css`
- engine process: `engine/llama-server.exe`

## 3. Important Project Goals

The project optimizes for:

- local-first runtime behavior
- simple deployment on Windows
- small and understandable architecture
- graceful shutdown and process cleanup
- enough reliability that the app can recover from common local failures

It does not optimize for:

- cloud dependency
- a large framework-heavy stack
- multi-service distributed deployment
- a hidden desktop shell that does everything behind the scenes

## 4. Folder Structure

This is the practical structure contributors should know:

```text
Codai/
├── dev/
│   ├── config.py
│   ├── controller.py
│   ├── engine.py
│   ├── proxy.py
│   ├── system.py
│   └── requirements.txt
├── docs/
│   ├── contributor-project-info.md
│   ├── docs_Plan.md
│   └── prd.md
├── engine/
│   └── llama-server.exe
├── logs/
│   ├── codai.log
│   ├── engine.log
│   ├── crash.log
│   └── codai.lock
├── models/
├── ui/
│   ├── index.html
│   ├── logs.html
│   ├── app.js
│   └── styles.css
├── config.json
├── Documentation.md
├── help.txt
├── kill.bat
├── readme.md
├── run.bat
└── Codai.exe
```

## 5. Key Files and Ownership

### `run.bat`

This is the Windows operator entry point.

Responsibilities:

- read `config.json`
- compute ports
- choose runtime path
- start the app
- wait for the runtime to become ready
- open the browser
- request graceful shutdown

Non-responsibilities:

- deep runtime logic
- engine lifecycle policy
- owning the true shutdown sequence

If `run.bat` lies about readiness, users lose trust quickly. Keep it honest.

### `kill.bat`

This is the cleanup tool, not the primary shutdown path.

Responsibilities:

- find Codai-owned processes
- terminate them if needed
- remove stale lock files
- say clearly when there is no process to kill

Non-responsibilities:

- acting as the normal stop flow
- killing unrelated Python or system processes

### `dev/controller.py`

This is the main orchestrator.

Responsibilities:

- load configuration
- run hardware analysis
- create proxy and engine manager
- move through startup phases
- launch the browser
- handle runtime exceptions
- perform controlled shutdown

If you are changing startup order, failure handling, runtime phase, or shutdown behavior, you will almost certainly touch this file.

### `dev/proxy.py`

This is the app boundary between UI and engine.

Responsibilities:

- serve the local UI
- expose `/health`
- expose `/shutdown`
- accept `/frontend-error`
- forward chat requests to the engine
- normalize responses

If the UI and engine disagree, the proxy is usually where the mismatch becomes visible.

### `dev/engine.py`

This owns `llama-server.exe`.

Responsibilities:

- start the engine process
- check engine port availability
- manage `logs/codai.lock`
- monitor health
- restart after crashes when allowed
- shut down the engine cleanly

This file is sensitive. Small process-management changes can create large Windows-specific bugs.

### `dev/system.py`

This handles hardware analysis and runtime tuning decisions.

It is where the app decides how aggressive it should be with thread count and context size.

### `dev/config.py`

This centralizes:

- defaults
- configuration constants
- startup phases
- config loading
- path helpers

If you add a new top-level runtime option, make sure the docs and config path are updated at the same time.

### `ui/app.js`

This is the frontend control layer.

Responsibilities:

- poll `/health`
- keep UI status in sync with backend state
- send `/v1/chat/completions`
- render chat
- surface errors
- forward frontend errors back to the proxy

The UI is intentionally framework-free. Clarity matters more than abstraction.

## 6. Runtime Ports

The project uses a configured proxy/UI port and then places the engine on the next port.

Formula:

- UI/proxy: `port`
- health: `port/health`
- engine: `port + 1`

Current checked-in config:

```json
{
  "port": 8081,
  "debug": false
}
```

So the current practical local addresses are:

- UI: `http://127.0.0.1:8081/`
- Health: `http://127.0.0.1:8081/health`
- Shutdown: `http://127.0.0.1:8081/shutdown`
- Engine: `http://127.0.0.1:8082/`

If the configured port changes, every document that hardcodes ports should be reviewed.

## 7. How To Run The Project

There are two main ways to run it.

### Option 1. Recommended for normal use on this repo: `run.bat`

From Explorer:

1. Open the project folder.
2. Double-click `run.bat`.
3. Wait for the launcher to report `[READY]`.
4. The browser opens the UI.
5. Use the launcher window to stop the app safely.

From terminal:

```powershell
cmd /c run.bat
```

What the launcher currently does:

- reads `config.json`
- prints a runtime summary
- chooses Python runtime first when available
- starts the runtime
- waits for `/health` to say `phase=ready` and `engine=running`
- opens the browser
- stays open for the stop flow

### Option 2. Recommended for development/debugging: source runtime

```powershell
python dev/controller.py
```

Why this is important:

- this is the most trustworthy path during development
- it avoids problems caused by an outdated packaged exe
- it lets you debug runtime issues closer to the source

### Optional cleanup

If the runtime crashes or you suspect stale local processes:

```powershell
cmd /c kill.bat
```

## 8. How To Use The App

Once the app is running:

1. Open the local UI in the browser.
2. Wait until the runtime reports ready.
3. Type a message in the chat input.
4. The frontend sends the chat request to the proxy.
5. The proxy forwards it to the engine.
6. The engine returns the response through the proxy.
7. The UI renders the result.

From the UI perspective, the important backend route is:

```text
POST /v1/chat/completions
```

The important runtime-state route is:

```text
GET /health
```

## 9. Health Model

The UI and launcher depend on `/health`.

Current health expectations:

- HTTP status should be `200`
- response envelope should be valid JSON
- `status` should be `ok`
- `data.phase` should be `ready`
- `data.engine` should be `running`

Example:

```json
{
  "status": "ok",
  "request_id": "example",
  "data": {
    "proxy_port": 8081,
    "engine_port": 8082,
    "engine": "running",
    "engine_display": "running",
    "proxy": "active",
    "mode": "offline",
    "queue": "available",
    "uptime": "58.1s",
    "requests_handled": 4,
    "debug": false,
    "phase": "ready"
  },
  "error": null
}
```

Important detail:

Do not treat any `200` health response as equal to full readiness. The payload matters.

## 10. Startup Phases

The runtime uses explicit startup phases.

Important phases:

- `initializing`
- `analyzing_hardware`
- `loading_model`
- `binding_port`
- `ready`
- `shutting_down`
- `crashed`

These phases are important because:

- the launcher depends on them
- the UI depends on them
- the logs depend on them

If you add or rename phases, update:

- backend code
- UI status mapping
- docs
- any launcher readiness logic

## 11. Shutdown Model

The preferred shutdown path is graceful shutdown.

Current normal shutdown flow:

1. the launcher or a local client calls `POST /shutdown`
2. the proxy forwards shutdown intent to the controller
3. the controller exits its wait loop
4. the controller runs full shutdown
5. the proxy stops
6. the engine shuts down
7. the lock file is released

Why this matters:

- force-killing the controller skips cleanup
- skipped cleanup often leaves stale locks
- stale locks create confusing next-start failures

`kill.bat` exists for recovery, not as the normal shutdown flow.

## 12. Lock Files and Instance Management

The important lock file today is:

```text
logs\codai.lock
```

Purpose:

- stop duplicate runtime instances
- make startup behavior more predictable

Expected behavior:

- normal startup acquires the lock
- graceful shutdown releases the lock
- stale lock files should be reclaimable

If instance handling changes, update all docs that mention locks.

## 13. Logs

The main runtime logs are:

- `logs/codai.log`
- `logs/engine.log`
- `logs/crash.log`

### `logs/codai.log`

Use this for:

- startup order
- phase changes
- proxy lifecycle
- shutdown events
- high-level runtime behavior

### `logs/engine.log`

Use this for:

- engine startup output
- inference logs
- model-loading issues
- engine-specific crashes

### `logs/crash.log`

Use this for:

- fatal exceptions
- tracebacks
- startup crash details that did not stay visible on screen

If you are debugging a runtime issue, read logs before changing behavior.

## 14. Configuration

The app supports config through `config.json` and environment variables.

Example config:

```json
{
  "port": 8081,
  "model_name": "gemma-3-1b-it-Q4_K_M.gguf",
  "ctx": 2048,
  "threads": 4,
  "host": "127.0.0.1",
  "debug": false,
  "log_level": "INFO"
}
```

Supported environment variables used by the runtime:

- `CODAI_PORT`
- `CODAI_CTX`
- `CODAI_THREADS`
- `CODAI_MODEL`
- `CODAI_HOST`
- `CODAI_DEBUG`
- `CODAI_LOG_LEVEL`

Priority order:

1. environment variables
2. `config.json`
3. runtime defaults and hardware-derived tuning

## 15. Dependencies and Tools

Core runtime dependencies:

- Python
- `psutil`
- local `llama-server.exe`
- a compatible GGUF model

Install the Python dependency:

```powershell
pip install psutil
```

Useful local commands:

```powershell
python dev/controller.py
cmd /c run.bat
cmd /c kill.bat
```

## 16. Development Workflow

If you are actively developing the app, use this flow:

1. run `python dev/controller.py`
2. watch `logs/codai.log`
3. reproduce the issue through the browser
4. verify through `/health`
5. only after the source runtime works, think about `Codai.exe`

This keeps your debugging closer to the source of truth.

## 17. Practical Debugging Guide

### Case A. `run.bat` does not open the UI

Check:

- did the launcher reach `[READY]`?
- did it choose Python or exe?
- does `/health` respond?
- does `logs/codai.log` show `phase -> ready`?
- is the configured port already in use?

### Case B. Python runtime works but `Codai.exe` does not

Treat that as a packaging issue until proven otherwise.

Recommended approach:

1. trust the Python path first
2. fix the source runtime if needed
3. only then investigate or rebuild the packaged exe

### Case C. UI opens but chat fails

Check:

- `/health`
- proxy behavior
- `/v1/chat/completions`
- `logs/engine.log`
- whether the engine port is listening

### Case D. App says another instance is running

Check:

- `logs/codai.lock`
- whether the PID is alive
- whether the last shutdown was graceful

### Case E. Cleanup script says success but nothing changed

That usually means process matching is wrong or too broad. Verify ownership carefully before changing cleanup logic.

## 18. Contributor Guidance

If you are changing runtime behavior, think in this order:

1. What file truly owns this behavior?
2. Does the launcher assume something about it?
3. Does the UI assume something about it?
4. Does cleanup assume something about it?
5. Do the docs still describe it honestly after the change?

This is how you avoid fixing one layer and leaving the rest inconsistent.

## 19. How To Use This File To Update Main Docs

This file is meant to be the detailed reference.

When updating other docs, use this mapping:

### Update `readme.md` when:

- quick-start steps changed
- ports changed
- run/stop behavior changed
- developer commands changed

### Update `docs/prd.md` when:

- product shape changed
- supported runtime model changed
- major goals or non-goals changed

### Update `docs/docs_Plan.md` when:

- architecture flow changed
- operational priorities changed
- module responsibilities changed

### Update `docs/contributor-project-info.md` when:

- onboarding advice changed
- file ownership changed
- debugging advice changed

Good rule:

If behavior changed in code, update this file first, then compress the same truth into the smaller docs.

## 20. Documentation Maintenance Rules

To keep docs useful:

- do not hardcode ports unless you also mention they come from config
- do not describe `Codai.exe` as the main development path
- do not describe `kill.bat` as the normal shutdown flow
- do not say the app is ready just because the process started
- do not leave stale lock-file names in docs after runtime changes

## 21. Known Current Truths

These are important current truths contributors should not accidentally “document backward”:

- the source runtime is the main trustworthy path
- `run.bat` prefers Python when available
- the current checked-in config uses port `8081`
- the engine therefore uses `8082`
- graceful shutdown goes through `/shutdown`
- the main lock file is `logs/codai.lock`
- `kill.bat` should only target Codai-owned local processes

## 22. Recommended Reading Order For New Developers

Read these files in this order:

1. `Documentation.md`
2. `readme.md`
3. `docs/contributor-project-info.md`
4. `run.bat`
5. `dev/controller.py`
6. `dev/proxy.py`
7. `dev/engine.py`
8. `ui/app.js`

After that, the codebase should feel small and understandable.

## 23. Final Guidance

If you work on this project like a senior engineer, keep these habits:

- make startup behavior explicit
- keep shutdown boring and reliable
- never be casual about process ownership
- keep docs aligned with actual runtime behavior
- trust logs over assumptions

The project stays healthy when the runtime, scripts, and docs all tell the same story.
