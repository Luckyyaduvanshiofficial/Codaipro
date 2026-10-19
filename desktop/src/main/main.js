'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  Tray,
  dialog,
} = require('electron');

const { RuntimeManager } = require('./runtime');
const { streamChat, validateChatRequest, ChatError } = require('./chat');
const { DataStore, sanitizeSettings } = require('./store');
const { runPreflight } = require('./preflight');

const IS_DEV = !app.isPackaged;

// In development the runtime lives in the Codai project (the folder that contains dev/controller.py).
// CODAI_PROJECT_ROOT overrides the search when the desktop app is run from a separate folder.
function findProjectRoot() {
  const fs = require('node:fs');
  const candidates = [
    process.env.CODAI_PROJECT_ROOT,
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', '..'),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'dev', 'controller.py')))
    || candidates[candidates.length - 1];
}

const PROJECT_ROOT = IS_DEV ? findProjectRoot() : process.resourcesPath;
const RESOURCE_ROOT = IS_DEV ? PROJECT_ROOT : process.resourcesPath;

let mainWindow = null;
let splashWindow = null;
let tray = null;
let runtime = null;
let store = null;
let quitting = false;
let runtimePort = null;
let runtimeToken = null;
let activeChat = null;
// Kept so a renderer that loads after a fast failure still sees the reason.
let lastRuntimeError = null;
let mainWindowReady = false;

// Only one Codai window and runtime may exist. A second launch focuses the first.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function rendererPath(file) {
  return path.join(__dirname, '..', 'renderer', file);
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 260,
    frame: false,
    resizable: false,
    show: false,
    transparent: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'splash-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(rendererPath('splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Codai Pro',
    icon: path.join(__dirname, '..', '..', 'assets', 'app-icon-256.png'),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindowReady = true;
    if (runtimePort !== null) showMainWindow();
  });

  mainWindow.loadFile(rendererPath('index.html'));

  // Keep navigation inside the app. External links open in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.on('close', (event) => {
    // Closing the window hides it to the tray so generation can continue; quit is explicit.
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  try {
    tray = new Tray(iconPath);
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('Codai Pro');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Codai Pro', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else { mainWindow?.show(); mainWindow?.focus(); }
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  if (channel === 'runtime:phase' && splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('phase', payload);
  }
}

function showMainWindow() {
  if (!mainWindowReady || !mainWindow || mainWindow.isDestroyed()) return;
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
  mainWindow.show();
}

function logDirectory() {
  return path.join(app.getPath('userData'), 'logs');
}

async function openLogsFolder() {
  return shell.openPath(logDirectory());
}

function formatProblems(problems) {
  return problems.map((problem) => {
    const hint = problem.hint ? `\n   ${problem.hint}` : '';
    return `- ${problem.message}${hint}`;
  }).join('\n\n');
}

async function promptFailure({ title, message, problems, buttons = ['Try again', 'Open logs folder', 'Quit'] }) {
  const options = {
    type: 'error',
    title,
    message,
    detail: `${formatProblems(problems)}\n\nLogs: ${logDirectory()}`.slice(0, 4000),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  };
  const result = (mainWindow && !mainWindow.isDestroyed())
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response;
}

function registerIpc() {
  ipcMain.handle('app:getInfo', () => ({
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('runtime:info', () => ({
    ready: runtimePort !== null,
    error: lastRuntimeError,
  }));

  ipcMain.handle('data:load', () => store.load());

  ipcMain.handle('data:save', (_event, data) => store.save(data));

  ipcMain.handle('settings:update', (_event, patch) => {
    const data = store.load();
    data.settings = sanitizeSettings({ ...data.settings, ...(patch || {}) });
    const saved = store.save(data);
    nativeTheme.themeSource = saved.settings.theme;
    return saved.settings;
  });

  ipcMain.handle('chat:send', async (_event, rawRequest) => {
    if (activeChat) {
      throw new Error('A response is already being generated.');
    }
    const request = validateChatRequest(rawRequest);
    const controller = new AbortController();
    activeChat = { id: request.id, controller };

    try {
      const result = await streamChat({
        port: runtimePort,
        token: runtimeToken,
        messages: request.messages,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: controller.signal,
        onDelta: (delta) => sendToRenderer('chat:delta', { id: request.id, delta }),
      });
      return { status: 'complete', text: result.text };
    } catch (error) {
      if (error instanceof ChatError && error.aborted) {
        return { status: 'stopped', text: error.partial };
      }
      if (error instanceof ChatError) {
        return { status: 'error', text: error.partial, error: error.message };
      }
      return { status: 'error', text: '', error: 'Unexpected error while generating a response.' };
    } finally {
      activeChat = null;
    }
  });

  ipcMain.handle('chat:stop', (_event, id) => {
    if (activeChat && activeChat.id === id) {
      activeChat.controller.abort();
      return true;
    }
    return false;
  });

  ipcMain.handle('runtime:restart', async () => {
    try {
      await startRuntime();
      watchRuntime();
      showMainWindow();
      return { ready: true };
    } catch (error) {
      return { ready: false, error: error.message };
    }
  });

  ipcMain.handle('shell:openLogs', () => {
    const logDir = path.join(app.getPath('userData'), 'logs');
    return shell.openPath(logDir);
  });

  ipcMain.handle('dialog:confirm', async (_event, message) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      message: String(message).slice(0, 300),
    });
    return result.response === 1;
  });
}

async function startRuntime() {
  runtimePort = null;
  runtimeToken = null;
  if (runtime) {
    await runtime.stop();
    runtime = null;
  }

  runtime = new RuntimeManager({
    projectRoot: PROJECT_ROOT,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    resourcePath: RESOURCE_ROOT,
    userDataDir: app.getPath('userData'),
  });

  const port = await runtime.start({
    onPhase: (phase) => sendToRenderer('runtime:phase', { phase }),
  });
  runtimePort = port;
  runtimeToken = runtime.token;
  sendToRenderer('runtime:ready', { ready: true });
  return port;
}

function watchRuntime() {
  const current = runtime;
  if (!current) return;

  current.exited.then(async (info) => {
    // Normal shutdown and deliberate restarts are handled elsewhere.
    if (quitting || runtime !== current || runtimePort === null) return;

    runtimePort = null;
    runtimeToken = null;
    lastRuntimeError = 'The AI engine stopped unexpectedly.';
    sendToRenderer('runtime:error', { message: lastRuntimeError });

    let failure = info?.error?.message
      || `The runtime exited with code ${info?.code ?? 'unknown'}.`;

    while (!quitting) {
      const choice = await promptFailure({
        title: 'Codai Pro stopped',
        message: 'The AI engine stopped unexpectedly.',
        problems: [{
          message: failure,
          hint: 'Choose Restart to bring the engine back. Diagnostics are in the logs folder.',
        }],
        buttons: ['Restart', 'Open logs folder', 'Quit'],
      });

      if (choice === 1) {
        await openLogsFolder();
        continue;
      }
      if (choice === 2) {
        app.quit();
        return;
      }

      try {
        await startRuntime();
        watchRuntime();
        showMainWindow();
        return;
      } catch (error) {
        failure = error.message;
      }
    }
  });
}

function preflightReport() {
  return runPreflight({
    resourcePath: RESOURCE_ROOT,
    userDataDir: app.getPath('userData'),
    logDir: logDirectory(),
    isPackaged: app.isPackaged,
  });
}

async function boot() {
  store = new DataStore(path.join(app.getPath('userData'), 'codai-data.json'));
  nativeTheme.themeSource = store.load().settings.theme;

  createSplash();
  createTray();
  createMainWindow();

  while (!quitting) {
    const report = preflightReport();
    if (!report.ok) {
      const choice = await promptFailure({
        title: 'Codai Pro cannot start',
        message: 'Codai Pro found a problem before launch.',
        problems: report.problems,
      });
      if (choice === 1) {
        await openLogsFolder();
        continue;
      }
      if (choice === 2) {
        app.quit();
        return;
      }
      continue;
    }

    try {
      await startRuntime();
      lastRuntimeError = null;
      watchRuntime();
      showMainWindow();
      return;
    } catch (error) {
      lastRuntimeError = error.message;
      sendToRenderer('runtime:error', { message: error.message });

      // In a source checkout, open the window and show the reason there instead of
      // trapping the developer behind a modal retry loop.
      if (IS_DEV) {
        showMainWindow();
        return;
      }

      const choice = await promptFailure({
        title: 'Codai Pro could not start',
        message: 'The AI engine did not start correctly.',
        problems: [{
          message: error.message,
          hint: 'Choose Try again. If it keeps happening, open the logs folder and share the files.',
        }],
      });
      if (choice === 1) {
        await openLogsFolder();
        continue;
      }
      if (choice === 2) {
        app.quit();
        return;
      }
    }
  }
}

async function shutdown() {
  if (activeChat) activeChat.controller.abort();
  if (runtime) {
    await runtime.stop();
    runtime = null;
  }
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    app.setAppUserModelId('com.codai.pro');
    registerIpc();
    boot();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    shutdown().finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray; the app quits only through the tray menu.
    if (!tray && process.platform !== 'darwin') app.quit();
  });
}

module.exports = { RUNTIME_ROOT: RESOURCE_ROOT };
