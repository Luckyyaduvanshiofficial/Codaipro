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
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
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
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
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

function registerIpc() {
  ipcMain.handle('app:getInfo', () => ({
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('runtime:info', () => ({ ready: runtimePort !== null }));

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
    await startRuntime();
    return { ready: true };
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

async function boot() {
  store = new DataStore(path.join(app.getPath('userData'), 'codai-data.json'));
  nativeTheme.themeSource = store.load().settings.theme;

  createSplash();
  createTray();
  createMainWindow();

  try {
    await startRuntime();
  } catch (error) {
    sendToRenderer('runtime:error', { message: error.message });
    dialog.showErrorBox(
      'Codai Pro could not start',
      `${error.message}\n\nLogs are in: ${path.join(app.getPath('userData'), 'logs')}`,
    );
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
