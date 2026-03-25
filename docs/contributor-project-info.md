# Contributor Project Info

This document is for contributors who are new to the project. Read it like a senior engineer giving you the map before you start changing things.

## Start Here

If you only remember three things, remember these:

1. The real development runtime is the Python controller, not the packaged exe.
2. The proxy is the center of the app. The UI talks to the proxy, and the proxy talks to the engine.
3. Shutdown matters. If you bypass the controller's shutdown path, you will create confusing bugs around stale locks and orphaned processes.

## What This Project Actually Is

Codai Pro is not a giant platform. It is a small local runtime with four moving parts:

- `run.bat` starts the app for Windows users
- `dev/controller.py` orchestrates startup and shutdown
- `dev/proxy.py` serves the UI and forwards requests
- `dev/engine.py` owns the `llama-server.exe` subprocess

The browser UI is thin by design. Most operational truth lives in the Python runtime.

## How Requests Flow

When the app is working normally, the flow looks like this:

1. The launcher starts the controller.
2. The controller starts the proxy.
3. The controller starts the engine.
4. The UI loads from the proxy.
5. The UI sends chat requests to the proxy.
6. The proxy forwards those requests to the engine.
7. The proxy returns a normalized response back to the UI.

That means if chat is broken, you should think in this order:

- is the launcher lying about readiness?
- is the proxy up?
- is the engine up?
- is the UI talking to the right port?
- is the proxy translating requests correctly?

## File Map You Should Know

### `run.bat`

This is the operator-facing entry point on Windows.

What it is responsible for:

- reading `config.json`
- selecting a runtime path
- waiting for `/health`
- opening the browser
- sending a graceful shutdown request

What it should not do:

- own core runtime logic
- bypass the controller for shutdown
- silently assume the packaged exe is always healthy

### `kill.bat`

This is the cleanup tool, not the normal stop path.

Use it when:

- a stale process is still around
- a lock file survived a crash
- you need to reset the local runtime quickly

Do not treat it as the main shutdown flow. The real shutdown path is the controller.

### `dev/controller.py`

This is the conductor. If you change startup, shutdown, or runtime phase behavior, you will probably touch this file.

Read this file when you need to understand:

- startup order
- phase changes
- logging lifecycle
- browser launch behavior
- fatal error handling

### `dev/proxy.py`

This is the contract boundary between frontend and engine.

It is responsible for:

- serving static UI assets
- exposing `/health`
- exposing `/shutdown`
- forwarding `/v1/chat/completions`
- normalizing error responses

If the UI is confused, the proxy is often where the truth gets lost.

### `dev/engine.py`

This file owns the subprocess and should stay strict about it.

It handles:

- process spawn
- lock file handling
- restart logic
- readiness checks
- shutdown of `llama-server`

Be careful here. Small changes in process handling can create hard-to-debug Windows issues.

### `ui/app.js`

This is the main browser runtime.

It polls `/health`, controls UI state, sends chat messages, and reacts to failure conditions. It is intentionally framework-free, so clarity matters more than cleverness.

## Development Rules That Will Save You Time

### 1. Treat the Python runtime as source of truth

If `Codai.exe` and `python dev/controller.py` behave differently, believe the Python path first. Fix the source runtime, then decide whether the packaged exe needs a rebuild.

### 2. Keep ports and docs aligned

This project becomes confusing very fast when the docs say `8080` but `config.json` says `8081`. Any time ports, locks, startup flow, or shutdown flow change, update the docs in the same pass.

### 3. Never hand-wave process ownership

On Windows, killing by image name alone is sloppy. Always try to confirm that the process belongs to this project before terminating it. That is why the cleanup script checks Codai-owned paths and command lines.

### 4. Prefer graceful shutdown over force kill

If you force-kill the controller, you skip cleanup. That usually means:

- stale lock files
- orphaned engine processes
- misleading next-launch failures

Use the controller shutdown path whenever possible.

### 5. Read the logs before changing behavior

The most useful files are:

- `logs/codai.log`
- `logs/engine.log`
- `logs/crash.log`

If you are debugging startup or process lifecycle, these files usually tell you what happened faster than guessing from the UI.

## Typical Debugging Playbook

### Case 1: `run.bat` opens nothing

Check:

- does the launcher report `[READY]`?
- does `GET /health` respond?
- did the runtime choose Python or `Codai.exe`?
- does `logs/codai.log` show startup phases progressing to `ready`?

### Case 2: UI opens but chat fails

Check:

- `GET /health`
- proxy response for `/v1/chat/completions`
- `logs/engine.log`
- engine port availability

### Case 3: next launch says something is already running

Check:

- `logs/codai.lock`
- whether the PID inside it is still alive
- whether the previous shutdown was graceful

### Case 4: cleanup script says success but nothing changed

That usually means the process match is too broad or too weak. Validate ownership first, then terminate.

## How To Make Safe Changes

When you touch runtime behavior, try to think in this sequence:

1. What is the source of truth for this behavior?
2. Which file owns it?
3. Which script or doc also assumes it?
4. How will I verify it after the change?

That habit prevents the classic mistake of fixing one layer while leaving the launcher, docs, or cleanup script behind.

## Good First Files To Read

If you are onboarding, read these in order:

1. `readme.md`
2. `run.bat`
3. `dev/controller.py`
4. `dev/proxy.py`
5. `dev/engine.py`
6. `ui/app.js`

After that, the codebase is small enough that you can navigate most issues confidently.

## Final Advice

Do not optimize this project into being clever. Optimize it into being understandable.

The people who maintain a small local runtime later are helped more by:

- clear startup flow
- predictable process ownership
- honest docs
- boring shutdown behavior

If you preserve those, you are doing good work.
