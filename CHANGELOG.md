# Changelog

All notable changes to Codai Pro are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.0] — 2026-10-19

The desktop release. Codai Pro now runs in its own window instead of a browser
tab, the local runtime is locked down, and installing no longer means hunting
for a model file.

### Added

**Desktop app (Windows)**

- A native window around the local runtime. No terminal, no browser tab.
- Chat interface with a sidebar of conversations, search, rename, and delete.
- Streaming answers with Markdown rendering, syntax-highlighted code blocks,
  and per-block copy buttons.
- Stop button that keeps whatever the model had already produced.
- Regenerate for the last answer, including after a failure.
- Light, dark, and system themes.
- Keyboard shortcuts: `Ctrl+N` new chat, `Ctrl+K` search, `Ctrl+B` sidebar,
  `Ctrl+,` settings.
- Settings for system prompt, creativity, and maximum response length.
- Tray icon with hide-to-tray on close and a clean quit path.
- Conversation history stored locally and restored on launch.
- Splash screen that reports real startup phases, including model download and
  model load.

**First-run model download**

- The installer no longer needs to ship a model. If the configured model is
  missing and `model_url` is set, the runtime downloads it on first run.
- Downloads resume from a partial file after an interrupted connection.
- Transient failures retry with backoff.
- The byte count is verified before the file is used.

**Build and packaging**

- `build-windows.ps1` builds the whole product on Windows: downloads the
  official llama.cpp CPU engine, produces `dist\Codai.exe`, then builds the
  NSIS installer with electron-builder.
- Pass `-Model path\to\model.gguf` to bundle a model with the installer.

**Tests**

- 34 Python tests covering config validation, proxy auth, Host checks, stream
  truncation, and the downloader.
- 8 desktop tests covering SSE parsing, message validation, the conversation
  store, and runtime path resolution.

### Security

- Every API route now requires a per-session bearer token. Previously any page
  that could reach the local port could talk to the API.
- The `Host` header is validated against loopback addresses, which blocks DNS
  rebinding attacks from a malicious website.
- The wildcard CORS policy is removed, so other origins can no longer read
  responses.
- `/shutdown` no longer accepts unauthenticated requests.
- The session token is injected into the served page and written to a session
  file for launcher use, then deleted on shutdown.
- The desktop renderer runs with a strict Content-Security-Policy, no Node
  integration, and a narrow preload bridge.

### Fixed

- The engine could stall permanently after a crash, reporting
  `process is None` instead of recovering. It now restarts with a bounded
  budget and resets that budget after a stable run.
- Two instances could both start because the instance lock was not atomic.
  The lock is now atomic and detects PID reuse.
- Ctrl+C during the slow engine boot could leave the runtime running with no
  way to stop it. Signal handlers are installed before boot.
- `config.json` values of the wrong type raised a traceback before logging was
  configured. Values are now type-checked and rejected with a clear warning.
- Explicit `ctx` and `threads` settings were overwritten by hardware tuning.
  Overrides are now respected.
- The browser UI hardcoded port 8080. It now derives the API origin from the
  page.
- Server text was inserted into the page as HTML in several places. All server
  text is now escaped.
- Truncated streams finished silently as if complete. They now surface an
  error.
- Stop discarded partial output. It is now kept.
- Copying code could corrupt `&lt;`-style text and `$` sequences.
- `run.bat` broke on paths containing spaces and could leave the runtime
  running after a failure.
- `kill.bat` matched too broadly and could kill an unrelated checkout.
- The installer used a placeholder application ID, referenced files that did
  not exist, and required a model file that the app no longer needs.
- `config.json` pointed at Gemma 3 1B while the repository ships Qwen3.5-0.8B,
  so a fresh checkout could not start.

### Changed

- The default model is now `Qwen_Qwen3.5-0.8B-Q4_K_M.gguf`, matching the
  model in `models/`.
- The desktop app suppresses the automatic browser launch, since it has its
  own window.

### Known limitations

- The Windows installer and `Codai.exe` are built on Windows. The Linux and
  macOS development paths run from source.
- The installer is not code-signed, so Windows SmartScreen may warn on first
  launch.
- Code signing and automatic updates are not included in this release.

## [3.0.0] — 2026-09

The engine rewrite that moved Codai Pro to the official `llama-server` binary
with a streaming browser UI, a supervising controller, and hardware-aware
tuning.

## [2.1.2] — earlier

Previous releases.
