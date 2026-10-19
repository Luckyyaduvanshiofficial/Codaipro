# CodaiPro Windows App: Product Requirements Document

**Status:** Draft v0.1
**Owner:** LuckyLabs
**Last updated:** 2026-10-19

---

## 1. Summary

CodaiPro is an offline AI coding assistant. It runs a local language model through llama.cpp, so user prompts and code stay on the user's machine.

This PRD covers a native Windows desktop app with a ChatGPT-style interface. The app installs with one setup file, starts its local runtime automatically, and gives users a polished chat experience with conversation history, streaming responses, and clear status feedback.

## 2. Problem

- The current product is a browser page served by a Python controller. It starts through a batch file and a terminal-style launcher, which feels like a developer tool, not a consumer app.
- Setup is fragile. Users must place the correct model file, match the engine binaries to their OS, and understand ports and logs.
- The current UI has no conversation persistence, no clear onboarding, and limited status feedback when the engine is loading, crashed, or unavailable.

## 3. Goals

1. **Easy install:** a single Windows installer, and no manual steps for a typical user.
2. **Polished UX:** a ChatGPT-style layout that feels modern and reliable.
3. **Fast first answer:** the chat is usable as soon as the model finishes loading, with clear progress before that.
4. **Privacy by default:** no data leaves the machine unless the user opts in.
5. **Stable runtime:** the app starts, stops, and recovers from engine crashes without leaving orphaned processes or occupied ports.

## 4. Non-Goals (v1)

- macOS and Linux builds. The architecture should not block them later.
- Cloud model providers or account sign-in.
- Multi-user or networked access. The runtime listens only on localhost.
- Fine-tuning or training models.
- Plugin or extension marketplace.
- Mobile apps.

## 5. Target Users

| Persona | Needs |
|---|---|
| **Solo developer** | Quick coding help offline, code blocks with copy, saved chats per project |
| **Privacy-conscious user** | Confidence that prompts are not uploaded, visible status of where data goes |
| **Non-expert user** | One-click install, no terminals, clear messages when something fails |

## 6. User Stories

**Installation and first run**
- As a new user, I install the app from one `.exe` setup file and get Start menu and desktop shortcuts.
- As a new user, on first launch I see a setup screen that downloads or verifies the model, with progress and a retry option.
- As a user, I can see that the model is ready before I start chatting.

**Chatting**
- As a user, I type a message and see the reply stream in token by token.
- As a user, I can stop a reply mid-stream and keep the partial text.
- As a user, I can regenerate the last reply.
- As a user, I can copy any message or code block with one click.
- As a user, I can edit a previous message and resend from that point.
- As a user, code blocks show syntax highlighting and a language label.

**Conversations**
- As a user, I can start a new chat with Ctrl+N.
- As a user, I can see a sidebar of past chats, grouped by date.
- As a user, I can search past chats with Ctrl+K.
- As a user, I can rename or delete a chat.
- As a user, my chats are still there after I restart the app.

**Settings**
- As a user, I can choose a light, dark, or system theme.
- As a user, I can set a system prompt and adjust basic generation settings (temperature, max tokens).
- As a user, I can pick which installed model to use.

**Reliability**
- As a user, if I open the app a second time, the existing window comes to the front instead of starting a second runtime.
- As a user, if the engine crashes, I see a clear status message and an option to restart it.
- As a user, when I close the app, the engine stops and nothing is left running in the background.

## 7. Functional Requirements

### 7.1 Desktop Shell (Electron)

| ID | Requirement | Priority |
|---|---|---|
| FR-S1 | Launch as a native Windows app with a custom title bar matching the app theme | P0 |
| FR-S2 | Single-instance lock; a second launch focuses the existing window | P0 |
| FR-S3 | Start the Python runtime as a bundled sidecar process on app launch | P0 |
| FR-S4 | Show a splash screen with progress until the runtime reports ready | P0 |
| FR-S5 | Stop the runtime and free its ports on app quit, including forced quit paths | P0 |
| FR-S6 | System tray icon with Open and Quit actions | P1 |
| FR-S7 | Auto-update through a signed release channel | P1 |
| FR-S8 | Open external links in the default browser, not inside the app | P0 |
| FR-S9 | Choose a free localhost port at startup instead of using fixed ports | P0 |

### 7.2 Runtime (Python controller)

| ID | Requirement | Priority |
|---|---|---|
| FR-R1 | Start the llama.cpp server with the selected model and report readiness | P0 |
| FR-R2 | Provide a health endpoint that reports engine state: starting, ready, crashed, stopped | P0 |
| FR-R3 | Stream chat completions with a stop mechanism that cancels generation upstream | P0 |
| FR-R4 | Auto-restart the engine after a crash, with a retry limit that resets after a stable run | P0 |
| FR-R5 | Report upstream failures to the client as explicit error events, never as a successful completion | P0 |
| FR-R6 | Bind to 127.0.0.1 only. Do not allow a network bind from the UI | P0 |
| FR-R7 | Require a per-session token for all API routes, including `/shutdown` | P0 |
| FR-R8 | Restrict CORS to the app's own origin. Do not send wildcard origins | P0 |
| FR-R9 | Apply configuration in this order: defaults, config file, environment, then hardware-based tuning that respects user overrides | P0 |
| FR-R10 | Validate configuration types and report clear errors with a fallback to defaults | P1 |
| FR-R11 | Rotate logs and cap their size | P1 |
| FR-R12 | Acquire an instance lock that works atomically and detects stale locks safely | P0 |

### 7.3 Chat Interface (React)

| ID | Requirement | Priority |
|---|---|---|
| FR-C1 | Sidebar with conversation list grouped by Today, Yesterday, Previous 7 days, and Older | P0 |
| FR-C2 | Centered chat column with a fixed bottom input bar | P0 |
| FR-C3 | Streamed responses with a cursor and a visible Stop button | P0 |
| FR-C4 | Keep partial text when generation is stopped, with a "Stopped" indicator | P0 |
| FR-C5 | Regenerate, copy, and edit actions on messages | P0 |
| FR-C6 | Markdown rendering with GFM tables, lists, and task lists. Sanitize all output | P0 |
| FR-C7 | Code blocks with syntax highlighting, language label, and copy button | P0 |
| FR-C8 | Enter sends, Shift+Enter inserts a newline, and the input grows up to a maximum height | P0 |
| FR-C9 | Disable input with a clear reason while the engine is starting, crashed, or busy | P0 |
| FR-C10 | Search past conversations (Ctrl+K) | P1 |
| FR-C11 | Rename and delete conversations, with confirmation for delete | P0 |
| FR-C12 | File attachments and drag-and-drop for text and code files | P1 |
| FR-C13 | Light, dark, and system themes | P0 |
| FR-C14 | Keyboard shortcuts: Ctrl+N new chat, Ctrl+K search, Ctrl+, settings | P1 |
| FR-C15 | Respect reduced-motion settings; keep all controls keyboard-accessible with visible focus | P0 |

### 7.4 Models and Setup

| ID | Requirement | Priority |
|---|---|---|
| FR-M1 | Detect models in the models folder and list them in settings | P0 |
| FR-M2 | First-run setup downloads the default model with progress, pause, resume, and checksum verification | P0 |
| FR-M3 | Show a clear error when no model is installed, with a button to open the setup screen | P0 |
| FR-M4 | Let users import a `.gguf` file from disk | P1 |
| FR-M5 | Show model name, size, and quantization in the picker | P1 |

### 7.5 Data and Privacy

| ID | Requirement | Priority |
|---|---|---|
| FR-D1 | Store conversations locally in the user's app data folder | P0 |
| FR-D2 | Provide "Delete all data" in settings | P0 |
| FR-D3 | No telemetry by default. Any crash reporting is opt-in | P0 |
| FR-D4 | Export a conversation as Markdown | P2 |
| FR-D5 | Keep the full chat history out of logs by default | P0 |

## 8. Experience Requirements

**Startup**
- Splash screen appears within 1 second of launch.
- The splash shows the current step: "Starting engine", "Loading model (n%)", or "Ready".
- If startup takes longer than 90 seconds, show a message with options to view logs or retry.

**Chat**
- First token appears within a few seconds on the recommended hardware, with an indicator while waiting.
- Stop responds within 500 ms.
- The window stays responsive during generation. No UI freezes from long messages.

**Visual design**
- Modern, minimal, and consistent with ChatGPT-style layouts: clear hierarchy, generous spacing, and readable typography.
- Light and dark themes with sufficient contrast (WCAG AA for body text).
- Smooth transitions for sidebar, message appearance, and theme changes, disabled under reduced-motion.

## 9. Technical Architecture

```
+-------------------------------+
|  Electron main process        |
|  - window, tray, updater      |
|  - starts/stops sidecar       |
+---------------+---------------+
                |
     +----------v-----------+        +-----------------------+
     |  React renderer (UI) | -----> |  Python runtime (API) |
     |  localhost + token   |  HTTP  |  127.0.0.1 only       |
     +----------------------+ stream +----------+------------+
                                                |
                                   +------------v-----------+
                                   |  llama.cpp server      |
                                   |  (bundled Windows exe) |
                                   +------------------------+
```

- **Electron** owns the window, lifecycle, tray, and updates. It passes the runtime address and session token to the renderer through a preload bridge, not a global.
- **Renderer** handles all UI from `desktop/src/renderer` (plain ES modules + CSS, served from `file://` with a strict CSP). Implemented without a framework or build step so the packaged app has no bundler dependency. Conversation storage is a local JSON file in Electron `userData`, managed through the main process.
- **Python runtime** keeps the existing controller role: engine management, proxying, health, and config. Its existing API routes are kept where possible, with auth and CORS hardening added.
- **llama.cpp** runs as a child process, bound to localhost on a dynamically chosen port.

**Build and packaging**

Run `build-windows.ps1` on Windows from the repository root. It performs all three steps:

1. Downloads the official llama.cpp Windows CPU build into `engine/` (`llama-server.exe` and its DLLs).
2. Runs PyInstaller against `Codai.spec` to produce `dist/Codai.exe`.
3. Runs electron-builder in `desktop/` to produce the NSIS installer in `build/desktop/`.

The installer bundles `Codai.exe`, the engine, and `config.json`. A model is **not** bundled by default: on first run the runtime downloads the model named in `config.json` (`model_url`) into `userData/models`, resuming partial downloads and verifying the byte count. Pass `-Model path\to\model.gguf` to `build-windows.ps1` to bundle one instead.

Code signing for the installer and executables is still pending.

## 10. Data Model

- **Conversation:** `id`, `title`, `model`, `system_prompt`, `created_at`, `updated_at`, `archived`
- **Message:** `id`, `conversation_id`, `role` (user | assistant | system), `content`, `status` (complete | streaming | stopped | error), `created_at`, `tokens`
- **Settings:** `theme`, `default_model`, `temperature`, `max_tokens`, `context_size`, `threads`

## 11. Metrics

| Metric | Target for v1 |
|---|---|
| Clean install success on a fresh Windows 10/11 machine | 95%+ |
| Crash-free sessions | 99%+ |
| Time from launch to ready chat (after model is downloaded) | Under 20 seconds on recommended hardware |
| Orphaned processes after quit | 0 |
| Accessibility audit (keyboard and contrast) | No critical issues |

## 12. Release Plan

**Phase 0: Foundations**
- Fix P0 security and reliability items: token auth, CORS restriction, `/shutdown` protection, error propagation, instance lock, and atomic config.
- Produce a Windows llama.cpp build.

**Phase 1: Desktop shell and runtime**
- Electron shell, sidecar lifecycle, splash, single instance, dynamic ports, clean shutdown.

**Phase 2: Chat UI**
- Layout, streaming, markdown, code blocks, message actions, theme, keyboard shortcuts.

**Phase 3: Conversations and settings**
- Persistence, sidebar, search, rename and delete, settings, model picker.

**Phase 4: Setup and polish**
- First-run model download, tray, auto-update, accessibility pass, performance tuning.

**Phase 5: Release**
- Signed installer, clean-machine testing, release notes, documentation update.

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Windows llama.cpp binaries are not yet available in `engine/` | Blocks Phase 1 | Build or download a Windows release early and verify it runs |
| Large installer if the model is bundled | Slow download, poor first impression | Download the model on first run; ship without it |
| Unsigned installer triggers SmartScreen | Users distrust the app | Sign the installer; document the warning until signed |
| Electron package size | Larger download than a Python-only app | Accept for v1; trim unused locales and assets |
| Stale or crashed sidecar leaves ports occupied | App won't start | Dynamic ports, lock file with PID check, cleanup on start |
| Markdown or HTML injection from model output | Security issue | Sanitize rendered output; keep Electron context isolation on; disable Node in renderer |
| Scope growth beyond the chat UI | Delays release | Hold P2 items until after v1 |

## 14. Open Questions

1. **Theme:** dark-only, or light and dark? (Recommendation: both, with system as default.)
2. **Model delivery:** is the first-run download acceptable, or must the installer be fully offline?
3. **Default model:** Gemma 3 1B (the code default) or Qwen 3.5 0.8B (the file currently in `models/`)?
4. **Hardware target:** minimum RAM, CPU features, and whether GPU support is required in v1.
5. **Conversation storage:** local-only, or is sync planned for later?
6. **Branding:** app name, icon, and color palette.
7. **Distribution:** direct download from the website only, or also a Microsoft Store listing?
8. **Auto-update host:** where will signed release builds be published?

## 15. Out of Scope for This Document

- Detailed visual mockups. These will follow once the open questions are answered.
- Implementation details for individual bug fixes, which are tracked separately from the bug review.
