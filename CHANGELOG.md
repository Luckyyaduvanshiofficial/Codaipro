# Changelog

All notable changes to Codai Pro are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] — 2026-10-19

The brand and polish release. Codai Pro has a new identity, a friendlier chat
window, and starter prompts built for lab exams.

### Added

- The approved **Offset Frame** brand identity is now in use everywhere: the
  website masthead and footer, favicon and PWA icons, social preview image, the
  desktop splash and welcome screen, the app, installer, executable, and tray
  icon, the browser UI, and the README (with light and dark variants). The full
  source package lives in `branding/`.
- Brand accent colors replace the old green and blue in the desktop app, the
  browser UI, and the logs page.
- An assistant avatar now appears beside replies, and the scrollbars use the
  brand palette instead of the platform default.
- A shortcut hint under the composer shows Enter to send and Shift+Enter for a
  new line.

### Changed

- Startup problems now appear as a friendly card: a plain-language title, a
  short explanation, a hint, **Try again** and **Open logs** buttons, and the
  raw error hidden under "Technical details". The old UI dumped the entire log
  tail into the window.
- The starter prompts are now built for lab exams and coding practice: a C
  program, a Python exercise, a DSA explanation, and a SQL query. The welcome
  copy and empty state point at the same use case.
- The status pill reads "Engine offline" instead of "Engine stopped".

### Fixed

- The app refused to launch from a source checkout because the preflight
  required a packaged `runtime/Codai.exe`. Preflight is now mode-aware: source
  checkouts validate `dev/controller.py`, while packaged builds still require
  the bundled runtime.
- A missing platform engine or model no longer blocks the window in a source
  checkout. The window opens and explains the problem with the exact path.
- Startup failures that happened before the renderer finished loading were lost,
  leaving the app stuck on "Starting…". The reason is now retained and shown on
  load.
- The fallback error text now highlights the failing log lines instead of
  including the whole shutdown transcript.
- The desktop test script now runs `preflight.test.js` as well as
  `desktop.test.js`.

## [3.1.0] — 2026-10-19

The desktop release. Codai Pro now runs in its own window instead of a browser
tab, the local runtime is locked down, and the Windows installer includes the
model so installing is a single step.

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
- One-click Windows installer: a single extraction/progress screen, then the
  app launches automatically.
- Offline portable USB zip: extract to a pendrive and run `run.bat`. Includes
  the model, engine, and runtime; no install and no internet are needed.
- Conversation history stored locally and restored on launch.
- Splash screen that reports real startup phases, including model load.
- The chat window opens only after the model can actually answer requests.

**Startup reliability**

- Preflight checks verify the runtime, engine, VC++ runtime, model, free disk,
  and available memory before the window opens.
- Startup failures show **Try again**, **Open logs folder**, and **Quit** with
  the exact reason instead of a blank window.
- An unexpected runtime exit offers **Restart** without closing the app.
- Context size steps down automatically when available RAM is low, avoiding
  `bad allocation` failures on loaded 8 GB machines.

**Bundled model and first-run download**

- The Windows installer ships the default model, so the first launch is fully
  offline.
- If the configured model is missing and `model_url` is set, the runtime
  downloads it on first run.
- Downloads resume from a partial file after an interrupted connection.
- Transient failures retry with backoff.
- The byte count is verified before the file is used.

**Build and packaging**

- `build-windows.ps1` builds the whole product on Windows: downloads the
  official llama.cpp CPU engine, produces `dist\Codai.exe`, then builds the
  NSIS installer with electron-builder.
- Pass `-Model path\to\model.gguf` to bundle a model with the installer.
- The MSVC runtime (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`)
  is bundled app-local so the engine starts without the VC++ Redistributable.
- The release workflow downloads the default model before packaging, so
  published installers are self-contained.

**Tests**

- 36 Python tests covering config validation, proxy auth, Host checks, stream
  truncation, hardware tiers, and the downloader.
- 14 desktop tests covering SSE parsing, message validation, the conversation
  store, runtime path resolution, installation preflight, and context planning.

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
