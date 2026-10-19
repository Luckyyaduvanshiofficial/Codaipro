# Installing Codai Pro

Codai Pro is a desktop app that runs a language model on your own computer.
Nothing is uploaded and nothing needs an account. You can install it, or run it
from a folder with no installation at all.

**Requirements:** Windows 10 or 11 (64-bit), 4 GB RAM minimum. About 1 GB of
disk for the app, plus 0.5–5 GB for a model depending on which you choose.

---

## Option 1: Desktop installer (recommended)

```text
1. Download CodaiPro_Setup_3.1.0.exe from:
   https://github.com/Luckyyaduvanshiofficial/Codaipro/releases/latest
2. Run it. Windows SmartScreen may warn because the build is not code-signed.
   Choose "More info" → "Run anyway".
3. Pick an install folder and finish the wizard.
4. Launch Codai Pro from the Start menu or the desktop shortcut.
```

The first launch downloads a model (about 0.55 GB) into your user data folder
and shows progress in the splash screen. After that, startup is fast and
everything runs offline.

Your chats are stored at:

```text
%APPDATA%\Codai Pro\codai-data.json
```

Logs are in `%APPDATA%\Codai Pro\logs\`. The **Logs** button at the bottom of
the sidebar opens that folder.

### Uninstalling

Use **Settings → Apps → Installed apps → Codai Pro → Uninstall**. Your chats
are kept so a reinstall picks up where you left off. Delete
`%APPDATA%\Codai Pro` to remove them.

---

## Option 2: Portable (no install)

```text
1. Download CodaiPro-3.1.0-Portable-Windows.zip from the releases page.
2. Right-click → Extract All to a WRITABLE folder (for example D:\CodaiPro
   or a USB drive). Do NOT use C:\Program Files — the app writes logs and
   models next to itself.
3. Double-click run.bat.
4. Wait for [READY]. Your browser opens the chat at http://127.0.0.1:8081/.
```

The zip includes `Codai.exe` and the official `engine\llama-server.exe`. If no
model is present, the first run downloads the default one, so the first startup
takes as long as the download.

Leave the launcher window open while you work. Press any key in it to stop
Codai cleanly. `kill.bat` force-stops everything if a launch ever goes wrong.

---

## Option 3: From source

```bash
git clone https://github.com/Luckyyaduvanshiofficial/Codaipro.git
cd Codaipro
pip install -r requirements.txt     # installs psutil

# Put the engine binary in engine/ (see below)
# Either drop a .gguf into models/, or leave model_url set in config.json
# and the first run downloads it.

# Windows: double-click run.bat
# Linux / macOS:
python dev/controller.py
```

### Desktop development

```bash
cd desktop
npm install --include=dev
npm start
```

`npm start` looks for the runtime in the repository root, so `dev/controller.py`
must be present. Set `CODAI_PROJECT_ROOT` if the desktop folder lives elsewhere.

Run the test suites with `python -m pytest tests/` and `npm test` in `desktop/`.

---

## Engine setup (source installs only)

The release packages include the engine. For a source install you need the
official [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`
binary for your platform.

**Windows**

```bash
winget install llama.cpp
# then copy llama-server.exe into engine\

# Or download llama-bXXXX-bin-win-cpu-x64.zip from the llama.cpp releases
# and extract everything into engine\
```

**Linux**

```bash
# Download llama-bXXXX-bin-ubuntu-x64.tar.gz from llama.cpp releases,
# extract it, and copy llama-server plus the .so files into engine/
chmod +x engine/llama-server
```

**macOS**

```bash
brew install llama.cpp
ln -s "$(brew --prefix)/bin/llama-server" engine/llama-server
```

**GPU (optional):** use a CUDA build such as
`llama-bXXXX-bin-win-cuda-12.4-x64.zip` plus the matching cudart archive from
the same release, and extract both into `engine\`. No GPU flags are passed by
default; add `-ngl 99` to the boot arguments in `dev/engine.py` to offload
layers.

---

## Models

Codai Pro runs quantized GGUF models. It ships with a default and downloads it
on first run, but you can use any GGUF you like.

**Default:** `Qwen_Qwen3.5-0.8B-Q4_K_M.gguf` (0.58 GB) — small, fast, and
newest of the tiny models.

To change the model, edit `config.json`:

```json
{
  "model_name": "your-model.gguf",
  "model_url": "https://example.com/your-model.gguf"
}
```

- `model_name` is the filename the app looks for. It must be a `.gguf` file
  name, not a path.
- `model_url` is where to download it if it is missing. Leave it empty to
  disable automatic downloads.
- `model_size` (optional) is the expected size in bytes. When set, an
  incomplete download is rejected instead of loading a broken file.

Models are searched for in `models/` next to the app first, then in your
writable data folder (`%APPDATA%\Codai Pro\models`).

### Suggested models

| Model | Size | Good for |
|---|---|---|
| Qwen3.5-0.8B (default) | 0.58 GB | Weakest machines, fastest replies |
| Gemma 3 1B Instruct | 0.81 GB | Balanced small model |
| Llama 3.2 1B Instruct | 0.81 GB | General chat |
| Qwen2.5-Coder-3B | 2 GB | Noticeably better at code |
| Phi-3.5-mini | 2.3 GB | Good speed/quality balance |
| Qwen2.5-Coder-7B | 4.7 GB | Best answers, needs a stronger PC |

Direct download links are on the [website](https://luckyyaduvanshiofficial.github.io/Codaipro/#download).

---

## First run

1. The app starts the runtime and shows a splash with real progress.
2. If the model is missing, it is downloaded once.
3. The engine loads the model (this can take up to a minute on a slow disk).
4. The chat window opens when everything is ready.

If startup fails, the app shows the reason and the log folder location instead
of failing silently.

---

## Troubleshooting

### Windows warned about the installer

The build is not code-signed yet. Choose **More info → Run anyway**. If you
downloaded from the official releases page, this is expected.

### "Missing engine binary"

The release packages include the engine. On a source install, follow **Engine
setup** above and confirm `engine\llama-server.exe` exists (or `engine/llama-server`
on Linux and macOS).

### "Could not download the model"

Check your internet connection and the `model_url` in `config.json`. Partial
downloads resume automatically on the next launch, so simply starting again is
usually enough. To download by hand, put the `.gguf` in the `models` folder and
start the app.

### "Loading model" or the reply fails right after launch

The engine is still loading. Wait for the status in the top right to read
**Ready**. On slower machines the first load of a larger model can take a
minute.

### Port already in use

The desktop app picks free ports automatically, so this is rare. The portable
build uses `8081`. Run `kill.bat`, or change `"port"` in `config.json`.

### "Another Codai instance is already running"

Close the other window. If a previous run crashed, run `kill.bat` on Windows
to remove the stale `logs\codai.lock`.

### The engine keeps crashing

Open **Logs** and read `engine.log` for the engine's own error, and `codai.log`
for the controller's. The most common causes are too little RAM for the chosen
model and a corrupted model download. Delete the model and let it download
again, or pick a smaller one.

### Replies are slow

That is normal for CPU inference. Use a smaller model such as Qwen3.5-0.8B, and
close other heavy apps. The controller already tunes threads and context size
to your hardware.

### Reset everything

Quit the app, then delete `%APPDATA%\Codai Pro` to remove chats, logs,
settings, and downloaded models. The app rebuilds them on next launch.
