'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;
const TOKEN_FILENAME = path.join('logs', 'session.token');

/**
 * Ask the OS for a free loopback port, so the app never collides with another program.
 * @returns {Promise<number>}
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Find a proxy port whose successor (the engine port) is also free.
 * The runtime serves the engine on proxy port + 1, so both must be available.
 * @returns {Promise<number>}
 */
async function findFreePortPair() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const proxyPort = await findFreePort();
    if (proxyPort < 65534 && (await isPortFree(proxyPort + 1))) {
      return proxyPort;
    }
  }
  throw new Error('Could not find two adjacent free ports for the runtime.');
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function readLogTail(filePath, maxLines = 12) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/);
    // Prefer the lines that explain the failure; shutdown chatter hides the cause.
    const important = lines.filter((line) =>
      /\[(ERROR|CRITICAL)\s*\]|^\s*(Detail|Hint|Logs)\s*:/i.test(line));
    return (important.length > 0 ? important : lines).slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Resolve the runtime command for this environment.
 * Packaged builds use the bundled runtime.exe; development uses the Python source.
 * @param {{ isPackaged: boolean, resourcesPath: string, projectRoot: string }} env
 * @returns {{ command: string, args: string[], cwd: string }}
 */
function resolveRuntimeCommand({ isPackaged, resourcesPath, projectRoot }) {
  if (isPackaged) {
    const runtimeDir = path.join(resourcesPath, 'runtime');
    return {
      command: path.join(runtimeDir, 'Codai.exe'),
      args: [],
      cwd: runtimeDir,
    };
  }
  if (!projectRoot) {
    throw new Error('projectRoot is required when running from source.');
  }
  const controller = path.join(projectRoot, 'dev', 'controller.py');
  return {
    command: process.env.CODAI_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    args: [controller],
    cwd: projectRoot,
  };
}

/**
 * Query the runtime health endpoint.
 * @returns {Promise<{ ok: boolean, data?: object, status?: number }>}
 */
function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 2000, headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const envelope = JSON.parse(body);
            resolve({ ok: res.statusCode === 200, data: envelope.data, status: res.statusCode });
          } catch {
            resolve({ ok: false, status: res.statusCode });
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

/**
 * Post an authenticated shutdown request. Resolves true if the runtime accepted it.
 */
function requestShutdown(port, token) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/shutdown',
        method: 'POST',
        timeout: 5000,
        headers: { Host: `127.0.0.1:${port}`, 'X-Codai-Token': token, 'Content-Length': 0 },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 202));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Manages the Python/Codai runtime as a child process.
 */
class RuntimeManager {
  /**
   * @param {{ projectRoot: string, isPackaged: boolean, resourcesPath: string, resourcePath: string, userDataDir: string }} options
   */
  constructor(options) {
    this.options = options;
    this.child = null;
    this.port = null;
    this.token = null;
    this.stopping = false;
    this.exited = null;
    this.logStream = null;
  }

  /** Start the runtime and resolve once it reports ready. */
  async start({ onPhase = () => {} } = {}) {
    if (this.child) {
      await this.stop();
    }
    this.stopping = false;
    this.port = await findFreePortPair();
    this.token = crypto.randomBytes(32).toString('base64url');

    const { command, args, cwd } = resolveRuntimeCommand(this.options);
    if (this.options.isPackaged && !fs.existsSync(command)) {
      throw new Error(
        `The bundled Codai runtime is missing: ${command}. Reinstall Codai Pro, or restore the file from your antivirus quarantine.`,
      );
    }
    const logDir = path.join(this.options.userDataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    this.logStream = fs.createWriteStream(path.join(logDir, 'runtime-launcher.log'), { flags: 'a' });

    const env = {
      ...process.env,
      CODAI_PORT: String(this.port),
      CODAI_HOST: '127.0.0.1',
      CODAI_API_TOKEN: this.token,
      CODAI_BASE_PATH: this.options.userDataDir,
      CODAI_RESOURCE_PATH: this.options.resourcePath,
      CODAI_NO_BROWSER: '1',
      PYTHONUNBUFFERED: '1',
    };

    this.exited = new Promise((resolve) => {
      this.child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child.stdout.pipe(this.logStream, { end: false });
      this.child.stderr.pipe(this.logStream, { end: false });
      this.child.on('exit', (code, signal) => {
        this.logStream.write(`[launcher] runtime exited code=${code} signal=${signal}\n`);
        this.exitInfo = { code, signal };
        this.child = null;
        resolve({ code, signal });
      });
      this.child.on('error', (err) => {
        this.logStream.write(`[launcher] failed to start runtime: ${err.message}\n`);
        this.exitInfo = { code: -1, signal: null, error: err };
        this.child = null;
        resolve({ code: -1, signal: null, error: err });
      });
    });

    await this.waitForReady(onPhase);
    return this.port;
  }

  async waitForReady(onPhase) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastPhase = '';

    while (Date.now() < deadline) {
      if (this.child === null) {
        const tail = readLogTail(path.join(this.options.userDataDir, 'logs', 'runtime-launcher.log'));
        const reason = this.exitInfo?.error?.message
          || (this.exitInfo ? `exit code ${this.exitInfo.code}` : 'unknown reason');
        throw new Error(
          `The Codai runtime stopped during startup (${reason}).${tail ? `\n\n${tail}` : ''}`,
        );
      }

      const health = await fetchHealth(this.port);
      const phase = health.data?.phase || 'starting';
      if (phase !== lastPhase) {
        lastPhase = phase;
        onPhase(phase, health.data);
      }
      if (health.ok && health.data?.phase === 'ready' && health.data?.engine === 'running') {
        return;
      }
      if (health.ok && health.data?.phase === 'crashed') {
        throw new Error('The engine failed to start. Check that the model and engine files are present.');
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
      'Codai did not become ready in time. The model may still be loading; see the logs for details.',
    );
  }

  /** Path of the session token file the runtime writes; kept for diagnostics. */
  tokenPath() {
    return path.join(this.options.userDataDir, TOKEN_FILENAME);
  }

  /** Stop the runtime gracefully, then force it if it does not exit. */
  async stop({ gracefulMs = 8000 } = {}) {
    if (this.stopping || !this.child) return;
    this.stopping = true;

    const accepted = await requestShutdown(this.port, this.token);
    if (!accepted && this.child) {
      this.child.kill();
    }

    const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), gracefulMs));
    const result = await Promise.race([this.exited, timer]);
    if (result === 'timeout' && this.child) {
      this.child.kill('SIGKILL');
      await this.exited;
    }

    this.logStream?.end();
    this.logStream = null;
  }
}

module.exports = {
  RuntimeManager,
  resolveRuntimeCommand,
  fetchHealth,
  findFreePort,
  findFreePortPair,
};
