'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planContext, runPreflight } = require('../src/main/preflight');

const MB = 1024 * 1024;

function writeSized(file, bytes, magic) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = Buffer.alloc(bytes);
  if (magic) buffer.write(magic, 0, 'ascii');
  fs.writeFileSync(file, buffer);
}

function makeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codai-preflight-'));
  const resources = path.join(root, 'resources');
  const userData = path.join(root, 'userdata');
  const engine = path.join(resources, 'engine');
  const engineName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

  writeSized(path.join(resources, 'runtime', 'Codai.exe'), 700 * 1024, 'MZ');
  // llama-server.exe is only a small launcher; the implementation lives in the DLLs.
  writeSized(path.join(engine, engineName), 9216, 'MZ');

  if (process.platform === 'win32') {
    for (const dll of ['llama.dll', 'ggml.dll', 'ggml-base.dll', 'libomp.dll']) {
      writeSized(path.join(engine, dll), 4096);
    }
    for (const dll of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
      writeSized(path.join(engine, dll), 4096);
    }
  }

  fs.writeFileSync(path.join(resources, 'config.json'), JSON.stringify({
    model_name: 'test-model.gguf',
    model_url: '',
  }));
  writeSized(path.join(resources, 'models', 'test-model.gguf'), 9 * MB, 'GGUF');

  return { root, resources, userData };
}

function run(install) {
  return runPreflight({
    resourcePath: install.resources,
    userDataDir: install.userData,
    logDir: path.join(install.userData, 'logs'),
  });
}

function cleanup(install) {
  fs.rmSync(install.root, { recursive: true, force: true });
}

test('preflight passes for a complete installation', () => {
  const install = makeInstall();
  try {
    const report = run(install);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.details.modelName, 'test-model.gguf');
    assert.ok(report.details.contextPlan.ctx >= 512);
  } finally {
    cleanup(install);
  }
});

test('preflight blocks a missing model when there is no download URL', () => {
  const install = makeInstall();
  try {
    fs.rmSync(path.join(install.resources, 'models', 'test-model.gguf'));
    const report = run(install);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.code === 'model'));
  } finally {
    cleanup(install);
  }
});

test('preflight warns instead of blocking when the model can be downloaded', () => {
  const install = makeInstall();
  try {
    fs.rmSync(path.join(install.resources, 'models', 'test-model.gguf'));
    fs.writeFileSync(path.join(install.resources, 'config.json'), JSON.stringify({
      model_name: 'test-model.gguf',
      model_url: 'https://example.com/test-model.gguf',
    }));
    const report = run(install);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.ok(report.warnings.some((w) => w.code === 'model-download'));
  } finally {
    cleanup(install);
  }
});

test('preflight rejects a corrupted model file', () => {
  const install = makeInstall();
  try {
    writeSized(path.join(install.resources, 'models', 'test-model.gguf'), 9 * MB, 'NOPE');
    const report = run(install);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.code === 'model-corrupt'));
  } finally {
    cleanup(install);
  }
});

test('preflight blocks a missing engine binary', () => {
  const install = makeInstall();
  try {
    const engineName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    fs.rmSync(path.join(install.resources, 'engine', engineName));
    const report = run(install);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.code === 'engine'));
  } finally {
    cleanup(install);
  }
});

test('context planning steps down for total or available memory pressure', () => {
  assert.equal(planContext({ totalBytes: 8 * 1024 ** 3, availableBytes: 1 * 1024 ** 3 }).ctx, 512);
  assert.equal(planContext({ totalBytes: 8 * 1024 ** 3, availableBytes: 2 * 1024 ** 3 }).ctx, 1024);
  assert.equal(planContext({ totalBytes: 4 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }).ctx, 1024);
  assert.equal(planContext({ totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 }).ctx, 2048);
});
