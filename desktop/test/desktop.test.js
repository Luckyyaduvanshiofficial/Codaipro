'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSseParser, validateChatRequest, validateMessages } = require('../src/main/chat');
const { DataStore, sanitizeData, sanitizeSettings } = require('../src/main/store');
const { resolveRuntimeCommand } = require('../src/main/runtime');

test('SSE parser emits envelopes split across chunks', () => {
  const seen = [];
  const parser = createSseParser((env) => seen.push(env));
  parser.push('data: {"status":"stream');
  parser.push('ing","data":{"x":1}}\n\ndata: {"status":"complete"}\n\n');
  assert.deepEqual(seen.map((e) => e.status), ['streaming', 'complete']);
});

test('SSE parser ignores malformed frames without throwing', () => {
  const seen = [];
  const parser = createSseParser((env) => seen.push(env));
  parser.push('data: {not json}\n\ndata: {"status":"complete"}\n\n');
  assert.deepEqual(seen.map((e) => e.status), ['complete']);
});

test('validateMessages rejects bad roles and oversized content', () => {
  assert.throws(() => validateMessages([{ role: 'tool', content: 'x' }]), /Invalid message/);
  assert.throws(() => validateMessages([{ role: 'user', content: 'a'.repeat(20_001) }]), /too long/);
  assert.throws(() => validateMessages([]), /Invalid message list/);
});

test('validateChatRequest clamps options and rejects bad ids', () => {
  const req = validateChatRequest({
    id: 'abc',
    messages: [{ role: 'user', content: 'hi' }],
    options: { temperature: 99, maxTokens: 999999 },
  });
  assert.equal(req.temperature, 2);
  assert.equal(req.maxTokens, 4096);
  assert.throws(() => validateChatRequest({ id: '', messages: [{ role: 'user', content: 'x' }] }), /Invalid chat id/);
});

test('settings sanitization restricts theme and ranges', () => {
  const s = sanitizeSettings({ theme: 'neon', temperature: 5, maxTokens: 1 });
  assert.equal(s.theme, 'system');
  assert.equal(s.temperature, 2);
  assert.equal(s.maxTokens, 16);
});

test('sanitizeData drops malformed conversations and messages', () => {
  const data = sanitizeData({
    conversations: [
      { id: 'c1', title: 'ok', messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'no' }, null] },
      { title: 'no id' },
      'garbage',
    ],
  });
  assert.equal(data.conversations.length, 1);
  assert.equal(data.conversations[0].messages.length, 1);
});

test('DataStore round-trips and recovers from a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codai-store-'));
  const file = path.join(dir, 'data.json');
  const store = new DataStore(file);

  store.save({ conversations: [{ id: 'c1', title: 'Hello', messages: [] }] });
  assert.equal(store.load().conversations[0].title, 'Hello');

  fs.writeFileSync(file, '{ broken');
  const recovered = store.load();
  assert.deepEqual(recovered.conversations, []);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('data.json.corrupt-')));
});

test('runtime resolves Codai.exe for packaged builds and the controller for source', () => {
  const packaged = resolveRuntimeCommand({
    isPackaged: true,
    resourcesPath: 'C:\\App\\resources',
    projectRoot: 'ignored',
  });
  assert.match(packaged.command, /Codai\.exe$/);

  const source = resolveRuntimeCommand({
    isPackaged: false,
    resourcesPath: 'ignored',
    projectRoot: '/proj',
  });
  assert.match(source.args[0], /dev[\\/]controller\.py$/);
});

