'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MODEL = 'gemma-3-1b-it-Q4_K_M.gguf';
const MIN_BINARY_BYTES = 512 * 1024;
const MIN_ENGINE_BYTES = 1024;
const MIN_MODEL_BYTES = 8 * 1024 * 1024;
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_HEADROOM_BYTES = 1536 * 1024 * 1024;
const MIN_TOTAL_RAM_BYTES = 2.5 * 1024 ** 3;
const WARN_TOTAL_RAM_BYTES = 4 * 1024 ** 3;
const WARN_AVAILABLE_RAM_BYTES = 1.5 * 1024 ** 3;
const REQUIRED_ENGINE_DLLS = ['llama.dll', 'ggml.dll', 'ggml-base.dll', 'libomp.dll'];
const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

function fileStats(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: stat.isFile(), size: stat.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

function hasMagic(filePath, magic) {
  let handle;
  try {
    handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(magic.length);
    const read = fs.readSync(handle, buffer, 0, magic.length, 0);
    return read === magic.length && buffer.equals(Buffer.from(magic));
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already closed */ }
    }
  }
}

function readConfig(resourcePath) {
  const file = path.join(resourcePath, 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { file, config: null, error: 'config.json must contain a JSON object' };
    }
    return { file, config: parsed, error: null };
  } catch (error) {
    return { file, config: null, error: error.message };
  }
}

function resolveModelPath({ resourcePath, userDataDir, modelName }) {
  const bundled = path.join(resourcePath, 'models', modelName);
  const downloaded = path.join(userDataDir, 'models', modelName);
  if (fileStats(bundled).exists) return bundled;
  if (fileStats(downloaded).exists) return downloaded;
  return bundled;
}

/**
 * Mirror the Python hardware tiers. Use available memory as well as total so a
 * loaded machine steps down before llama-server runs out of memory.
 */
function planContext({ totalBytes, availableBytes }) {
  const totalGb = totalBytes / (1024 ** 3);
  const availableGb = availableBytes / (1024 ** 3);
  if (totalGb < 2.5 || availableGb < 1.5) {
    return { ctx: 512, threads: 1, tier: 'Tier 3 (Low RAM)' };
  }
  if (totalGb < 6.0 || availableGb < 2.5) {
    return { ctx: 1024, threads: 2, tier: 'Tier 2 (Standard)' };
  }
  return { ctx: 2048, threads: 4, tier: 'Tier 1 (High-End)' };
}

function freeDiskBytes(directory) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stats = fs.statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function checkWritableDirectory(directory) {
  const probe = path.join(directory, `.codai-write-${process.pid}.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return null;
  } catch (error) {
    return error.message;
  }
}

function formatGb(bytes) {
  return `${Math.round((bytes / (1024 ** 3)) * 10) / 10} GB`;
}

/**
 * Validate everything the desktop app needs before it starts. Returns problems
 * that must block launch and warnings that are safe to continue with.
 */
function runPreflight({ resourcePath, userDataDir, logDir, isPackaged = true }) {
  const problems = [];
  const warnings = [];
  const details = {
    resourcePath,
    userDataDir,
    platform: process.platform,
    mode: isPackaged ? 'packaged' : 'source',
  };

  const addProblem = (code, message, hint) => problems.push({ code, message, hint });
  const addWarning = (code, message, hint) => warnings.push({ code, message, hint });

  const logPath = path.join(logDir, 'preflight.log');
  const writeError = checkWritableDirectory(logDir);
  details.writable = writeError === null;
  if (writeError) {
    addProblem(
      'userdata',
      `Codai Pro cannot write to its data folder: ${logDir}`,
      `Check folder permissions or sign in as a user who can write there. (${writeError})`,
    );
  }

  // A packaged build ships a single runtime executable. A source checkout runs the
  // Python controller directly, so requiring runtime/Codai.exe there would block
  // every development launch for no reason.
  const runtimeExe = isPackaged
    ? path.join(resourcePath, 'runtime', 'Codai.exe')
    : path.join(resourcePath, 'dev', 'controller.py');
  const runtime = fileStats(runtimeExe);
  details.runtimePath = runtimeExe;
  const minRuntimeBytes = isPackaged ? MIN_BINARY_BYTES : 1;
  if (!runtime.exists || runtime.size < minRuntimeBytes) {
    addProblem(
      'runtime',
      isPackaged
        ? `The bundled Codai runtime is missing or incomplete: ${runtimeExe}`
        : `The Python runtime entry point is missing: ${runtimeExe}`,
      isPackaged
        ? 'Reinstall Codai Pro. If antivirus quarantined the file, restore it or add an exclusion for the Codai Pro folder, then click Try again.'
        : 'Run the desktop app from the repository root, or set CODAI_PROJECT_ROOT to the folder that contains dev/controller.py.',
    );
  } else if (isPackaged && process.platform === 'win32' && !hasMagic(runtimeExe, 'MZ')) {
    addProblem(
      'runtime-corrupt',
      `The bundled Codai runtime is not a valid Windows program: ${runtimeExe}`,
      'Reinstall Codai Pro.',
    );
  }

  const engineDir = path.join(resourcePath, 'engine');
  const engineName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const engineExe = path.join(engineDir, engineName);
  const engine = fileStats(engineExe);
  details.enginePath = engineExe;
  if (!engine.exists || engine.size < MIN_ENGINE_BYTES) {
    if (isPackaged) {
      addProblem(
        'engine',
        `The AI engine is missing or incomplete: ${engineExe}`,
        'Reinstall Codai Pro. Antivirus sometimes quarantines llama-server.exe; restore it or add an exclusion, then click Try again.',
      );
    } else {
      // A source checkout on a different platform may only have the other OS build.
      // Open the window anyway and surface the problem instead of refusing to launch.
      addWarning(
        'engine-missing',
        `The AI engine for this platform is missing: ${engineExe}`,
        `Place the llama.cpp ${engineName} binary in ${engineDir}. The window will open, but chat will not work until it is present.`,
      );
    }
  } else if (isPackaged && process.platform === 'win32' && !hasMagic(engineExe, 'MZ')) {
    addProblem(
      'engine-corrupt',
      `The AI engine is not a valid Windows program: ${engineExe}`,
      'Reinstall Codai Pro.',
    );
  }

  if (process.platform === 'win32') {
    for (const dll of REQUIRED_ENGINE_DLLS) {
      if (!fileStats(path.join(engineDir, dll)).exists) {
        addProblem(
          'engine-library',
          `The AI engine is missing a required library: ${dll}`,
          'Reinstall Codai Pro.',
        );
      }
    }
    const system32 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
    for (const dll of VC_RUNTIME_DLLS) {
      const bundled = fileStats(path.join(engineDir, dll)).exists;
      const installed = fileStats(path.join(system32, dll)).exists;
      if (!bundled && !installed) {
        addProblem(
          'vc-runtime',
          `Microsoft Visual C++ runtime ${dll} is not available.`,
          'Reinstall Codai Pro, or install the Microsoft Visual C++ 2015-2022 Redistributable (x64).',
        );
      }
    }
  }

  const configResult = readConfig(resourcePath);
  const config = configResult.config || {};
  details.configPath = configResult.file;
  if (!configResult.config) {
    addProblem(
      'config',
      `Codai Pro could not read its configuration: ${configResult.file}`,
      `Reinstall Codai Pro. (${configResult.error})`,
    );
  }

  const modelName = typeof config.model_name === 'string' && config.model_name
    ? config.model_name
    : DEFAULT_MODEL;
  const modelPath = resolveModelPath({ resourcePath, userDataDir, modelName });
  const model = fileStats(modelPath);
  details.modelName = modelName;
  details.modelPath = modelPath;

  const modelUrl = typeof config.model_url === 'string' ? config.model_url.trim() : '';
  let needsDownload = false;

  if (!model.exists || model.size < MIN_MODEL_BYTES) {
    if (modelUrl) {
      needsDownload = true;
      addWarning(
        'model-download',
        `The AI model (${modelName}) is not installed and will be downloaded on first launch.`,
        'This needs an internet connection and about 0.6 GB of free disk space.',
      );
    } else if (isPackaged) {
      addProblem(
        'model',
        `The AI model is missing or incomplete: ${modelName}`,
        `Reinstall Codai Pro, or place ${modelName} in ${path.join(resourcePath, 'models')}. If antivirus quarantined it, restore it or add an exclusion.`,
      );
    } else {
      addWarning(
        'model-missing',
        `The AI model is missing: ${modelName}`,
        `Place a .gguf model in ${path.join(resourcePath, 'models')}, or set model_url in config.json. The window will open, but chat will not work until a model is present.`,
      );
    }
  } else if (!hasMagic(modelPath, 'GGUF')) {
    addProblem(
      'model-corrupt',
      `The AI model file is not a valid GGUF model: ${modelPath}`,
      'Reinstall Codai Pro, or replace the file with a complete .gguf download.',
    );
  }

  const expectedModelBytes = Number(config.model_size) > 0 ? Number(config.model_size) : 0;
  const requiredDisk = needsDownload
    ? Math.max(DOWNLOAD_HEADROOM_BYTES, expectedModelBytes + MIN_FREE_BYTES)
    : MIN_FREE_BYTES;
  const availableDisk = freeDiskBytes(details.writable ? userDataDir : resourcePath);
  details.freeDiskBytes = availableDisk;
  if (availableDisk !== null && availableDisk < requiredDisk) {
    addProblem(
      'disk',
      `Not enough free disk space. Codai Pro needs ${formatGb(requiredDisk)} free, but only ${formatGb(availableDisk)} is available.`,
      'Free up space on this drive and click Try again.',
    );
  }

  const totalRam = os.totalmem();
  const availableRam = os.freemem();
  const plan = planContext({ totalBytes: totalRam, availableBytes: availableRam });
  details.totalRamBytes = totalRam;
  details.availableRamBytes = availableRam;
  details.contextPlan = plan;

  if (totalRam < MIN_TOTAL_RAM_BYTES) {
    addProblem(
      'ram',
      `This computer has ${formatGb(totalRam)} of RAM. Codai Pro needs at least 4 GB.`,
      'Close other programs, or run Codai Pro on a machine with more memory.',
    );
  } else if (totalRam < WARN_TOTAL_RAM_BYTES || availableRam < WARN_AVAILABLE_RAM_BYTES) {
    addWarning(
      'ram-low',
      `Available memory is limited (${formatGb(availableRam)} free of ${formatGb(totalRam)}). Codai Pro will reduce its context size to stay stable.`,
      'Close other programs for the best speed and answer quality.',
    );
  }

  const summary = {
    ok: problems.length === 0,
    problems,
    warnings,
    details,
  };

  try {
    const lines = [
      `[${new Date().toISOString()}] preflight ok=${summary.ok}`,
      `  runtime=${runtimeExe} (${runtime.size} bytes)`,
      `  engine=${engineExe} (${engine.size} bytes)`,
      `  config=${configResult.file}`,
      `  model=${modelPath} (${model.size} bytes)`,
      `  ram=${formatGb(totalRam)} total / ${formatGb(availableRam)} available, plan=${plan.tier} ctx=${plan.ctx} threads=${plan.threads}`,
      `  disk=${availableDisk === null ? 'unknown' : formatGb(availableDisk)} free`,
      ...problems.map((p) => `  PROBLEM ${p.code}: ${p.message}`),
      ...warnings.map((w) => `  WARNING ${w.code}: ${w.message}`),
    ];
    fs.appendFileSync(logPath, `${lines.join('\n')}\n`);
  } catch {
    // Diagnostics are best-effort; never block startup because logging failed.
  }

  return summary;
}

module.exports = {
  DEFAULT_MODEL,
  planContext,
  readConfig,
  resolveModelPath,
  runPreflight,
};
