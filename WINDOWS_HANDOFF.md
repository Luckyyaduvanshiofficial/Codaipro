# Windows Handoff — Codai Pro v3.2.0

> **Read this first.** This file exists because the build was developed on Linux
> and must be finished on Windows. A fresh assistant session on Windows should
> read this file top to bottom before touching anything. It replaces the
> conversation context that was lost when the machine changed.

Last updated: 2026-10-19
Repository: https://github.com/Luckyyaduvanshiofficial/Codaipro
Branch: `main` (in sync with `origin/main`)

> **Update (2026-10-19): the Windows build is complete and verified.**
> `dist\Codai.exe`, the NSIS installer, and the single-file portable exe were
> built on Windows 11 and tested end to end (install, launch, chat, uninstall).
> The installer is one-click and bundles the default model and the MSVC runtime.
> Startup checks and the model-ready gate were added. Tests are now **36 Python**
> and **18 desktop**. The `v3.2.0` tag and GitHub release are published.

---

## 1. Where the project stands

All development work is **done, committed, and pushed**. The Windows build is
complete, the website is live with the v3.2 content, and the `v3.2.0` release
is published.

| Area | Status |
|---|---|
| Python runtime bug fixes + security hardening | Done, pushed |
| Bundled model + first-run download fallback | Done, pushed, tested |
| Electron desktop app (window, tray, chat UI) | Done, pushed |
| Tests: 36 Python, 18 desktop | All passing |
| Website update (v3.2) | Done, **deployed and verified live** |
| Changelog, README, INSTALLATION.md, PRD | Done, pushed |
| Release CI (builds installer on tag) | Done, pushed |
| `dist\Codai.exe` | Built and verified on Windows 11 |
| Windows `engine\llama-server.exe` | Downloaded by the build script and bundled |
| NSIS installer | Built and published in the v3.2.0 release |
| Git tag `v3.2.0` / GitHub release | Published with the installer and portable zip |

**The `v3.2.0` tag is now published.** The installer was built and checked
first; the tag triggered the release workflow, which published the installer
and portable zip. Keep the same order for future releases.

---

## 2. What to do on Windows, in order

From the repository root in **PowerShell**:

```powershell
# 1. Get the latest code
git pull

# 2. Build everything: engine + Codai.exe + installer
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
```

The script performs three steps and stops with a clear error if any fails:

1. Downloads the official llama.cpp **Windows CPU** build
   (`llama-*-bin-win-cpu-x64.zip`) into `engine\` (flattens the nested folder,
   so `engine\llama-server.exe` and its DLLs land directly in `engine\`).
2. Installs Python deps and runs `python -m PyInstaller Codai.spec`, producing
   `dist\Codai.exe`.
3. Runs `npm ci --include=dev` and `electron-builder --win --x64` in `desktop\`,
   producing `build\desktop\CodaiPro_Setup_3.2.0.exe`.

Useful flags:

- `-SkipEngine` — reuse an existing `engine\` folder
- `-SkipDesktop` — stop after `Codai.exe`
- `-Model C:\path\model.gguf` — bundle a model into the installer (normally not needed;
  the app downloads it on first run)

### Verify before publishing

1. Run `build\desktop\CodaiPro_Setup_3.2.0.exe` on a clean machine or VM.
2. Launch Codai Pro from the Start menu.
3. Confirm the splash progresses: download → loading model → chat window.
4. Send a message and confirm the reply streams.
5. Confirm Ctrl+C is not needed anywhere; quit from the tray.
6. Open the uninstaller and confirm it works.

### Then publish

```powershell
git tag v3.2.0
git push origin v3.2.0
```

That tag runs `.github/workflows/release.yml`, which rebuilds the installer on
`windows-latest` and publishes **both** `CodaiPro_Setup_*.exe` and the portable
zip with release notes.

Alternative: commit and push first, then create the release on GitHub, or use
`gh release create v3.2.0 ...` — but the CI path is already configured and is
the intended one.

---

## 3. Prerequisites on the Windows machine

- **Python 3.10+** on `PATH` (`python --version`)
- **Node.js 20+** and npm on `PATH` (`node --version`)
- Git
- Internet access for the engine download and npm install

`build-windows.ps1` checks for these and fails early with a clear message.

---

## 4. Architecture, in one screen

```
Electron main process  ──spawns──>  Codai.exe (Python controller)
  desktop/src/main/                   dev/controller.py
        │                                   │
        │ IPC (preload bridge)              ├─ proxy.py   (auth + routing, port N)
        ▼                                   └─ engine.py  → llama-server (port N+1)
  Renderer (chat UI)  ──HTTP+token──>  proxy
  desktop/src/renderer/
```

Key rules that must not be broken:

- The renderer has **no Node access**. It only gets the named functions exposed
  in `desktop/src/preload/preload.js` via `contextBridge`.
- Every API call needs the `X-Codai-Token` header. The token is generated per
  session by `dev/controller.py` and passed to Electron through the session file
  / `CODAI_API_TOKEN`.
- The `Host` header must be loopback (`127.0.0.1` / `localhost`). This blocks DNS
  rebinding. Do not relax it.
- Ports are never hardcoded. The desktop picks a free adjacent pair; the proxy is
  `CODAI_PORT` and the engine is `CODAI_PORT + 1`.
- Writable data (logs, token, downloaded models, chats) goes under
  `CODAI_BASE_PATH` (Electron `userData`). Read-only resources (engine, bundled
  models, `config.json`) come from `CODAI_RESOURCE_PATH`.

### Environment variables (set by Electron, not by the user)

| Variable | Purpose |
|---|---|
| `CODAI_PORT` | Proxy port; engine is this + 1 |
| `CODAI_API_TOKEN` | Per-session bearer token |
| `CODAI_BASE_PATH` | Writable data directory |
| `CODAI_RESOURCE_PATH` | Read-only resources directory |
| `CODAI_NO_BROWSER` | Set to `1` by the desktop app so no browser tab opens |
| `CODAI_MODEL_URL` / `CODAI_MODEL_SIZE` | Optional model download overrides |

---

## 5. Known-good behaviours (already verified on Linux)

Do not "fix" these — they were tested end to end:

- Runtime boots, engine loads, proxy reports `engine: running`.
- Wrong token → 401. Foreign `Host` → 403. No CORS headers.
- Streaming chat returns model output; truncated streams surface an error.
- First-run download: missing model → downloads → verifies size → engine boots.
- Renderer: conversation persists across reload, Stop keeps partial text,
  failed turns stay visible with Regenerate, themes switch, Markdown escapes
  `<script>`, code fences render with copy buttons.
- `CODAI_NO_BROWSER=1` suppresses the browser launch.

---

## 6. Gotchas that cost time before

- **`npm_config_omit=dev`** was set in one environment, so Electron and
  electron-builder silently did not install. Always use `--include=dev`.
- **npm install on a mounted/network drive** can fail. Keep `node_modules`
  local. `build-windows.ps1` runs npm from `desktop\`, which is fine on a local
  Windows disk.
- **PyInstaller only builds for the OS it runs on.** That is the entire reason
  this handoff exists. Do not try to build `Codai.exe` on Linux.
- **The engine folder in git is empty by design** (`.gitignore` ignores
  `engine/`). The build script downloads it. Do not commit engine binaries.
- **`config.json` is tracked despite a generic ignore rule** (there is a
  negation entry). Keep it that way — the build needs it.
- **Version numbers live in three places:** `desktop/package.json`,
  `desktop/package-lock.json` (root `version` and `packages.""`), and the
  release tag. Keep them equal.
- **`Codai.spec` uses `dev/controller.py`** (forward slashes) and lists
  `dev.downloader` in `hiddenimports`. If you add a new `dev/*.py` module that is
  imported dynamically, add it there too.

---

## 7. Repository map

```
dev/                     Python runtime
  config.py              validation, paths, env overrides, model settings
  controller.py          lifecycle orchestration, token, signals
  downloader.py          resumable model download
  engine.py              llama-server supervision, restart, model ensure
  proxy.py               auth, Host checks, streaming, static UI
  system.py              hardware tiers
desktop/                 Electron app
  src/main/main.js       windows, tray, IPC, single instance
  src/main/runtime.js    spawns Codai.exe / dev/controller.py
  src/main/preflight.js  file, model, disk, and memory checks
  src/main/chat.js       SSE client + request validation
  src/main/store.js      JSON persistence (atomic, sanitized)
  src/preload/           contextBridge allow-lists
  src/renderer/          chat UI (no build step)
  electron-builder.yml   packaging config
tests/                   Python tests  (pytest)
desktop/test/            Desktop tests (node --test)
ui/                      browser UI for the portable build
website/                 GitHub Pages site (auto-deploys on push)
.github/workflows/       release.yml, website-pages.yml
build-windows.ps1        one-command Windows build
CHANGELOG.md             v3.2.0 release notes
INSTALLATION.md          user install + troubleshooting
docs/PRD.md              product requirements
WINDOWS_HANDOFF.md       this file
```

---

## 8. Test commands

```powershell
# Python
pip install -r requirements.txt pytest
python -m pytest tests/ -q          # expect: 36 passed

# Desktop
cd desktop
npm ci --include=dev
npm test                            # expect: 14 passed
```

The Python tests contain no platform-specific branches (`os.name`,
`platform`, `skipif` are not used), so they should pass unchanged on Windows.
The one test that spawns a separate process to hold the instance lock relies on
`multiprocessing`; if it misbehaves on Windows, that is the test to inspect — it
is `test_second_instance_is_blocked_by_live_owner` in `tests/test_runtime.py`.

---

## 9. Remaining nice-to-haves (not blockers)

- Code signing for the installer and `Codai.exe`. Until then SmartScreen warns;
  the docs tell users to choose **More info → Run anyway**.
- Auto-update (`electron-updater`) — not wired up.
- The release workflow ran successfully for `v3.1.0` and published both assets.
  If a future run fails, the likely culprits are the `npm ci` step, the model
  download, or artifact paths; the installer lands in `build/desktop/`.

---

## 10. Git notes

- Commit messages end with:
  `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>`
- Work was pushed in small, logical commits. Keep that style for follow-ups.
- If you need to amend history, these commits are pushed — prefer new commits
  over rewriting `main`.
