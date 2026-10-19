'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES_PER_CONVERSATION = 2000;
const MAX_MESSAGE_CHARS = 200_000;
const THEMES = new Set(['system', 'light', 'dark']);
const STATUSES = new Set(['complete', 'stopped', 'error']);

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  systemPrompt: 'You are Codai Pro. Be brief, direct, and accurate. Format code in fenced blocks.',
  temperature: 0.7,
  maxTokens: 512,
});

function str(value, max, fallback = '') {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeMessage(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.role !== 'user' && input.role !== 'assistant') return null;
  return {
    id: str(input.id, 64),
    role: input.role,
    content: str(input.content, MAX_MESSAGE_CHARS),
    status: STATUSES.has(input.status) ? input.status : 'complete',
    error: str(input.error, 500) || undefined,
    createdAt: num(input.createdAt, Date.now()),
  };
}

function sanitizeConversation(input) {
  if (!input || typeof input !== 'object') return null;
  const id = str(input.id, 64);
  if (!id) return null;
  const messages = Array.isArray(input.messages)
    ? input.messages.slice(0, MAX_MESSAGES_PER_CONVERSATION).map(sanitizeMessage).filter(Boolean)
    : [];
  return {
    id,
    title: str(input.title, 200, 'New chat') || 'New chat',
    createdAt: num(input.createdAt, Date.now()),
    updatedAt: num(input.updatedAt, Date.now()),
    messages,
  };
}

function sanitizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    theme: THEMES.has(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
    systemPrompt: str(source.systemPrompt, 4000, DEFAULT_SETTINGS.systemPrompt),
    temperature: Math.min(2, Math.max(0, num(source.temperature, DEFAULT_SETTINGS.temperature))),
    maxTokens: Math.round(Math.min(4096, Math.max(16, num(source.maxTokens, DEFAULT_SETTINGS.maxTokens)))),
  };
}

/**
 * Sanitize the whole data document. Anything malformed is dropped rather than trusted.
 * @param {unknown} input
 */
function sanitizeData(input) {
  const source = input && typeof input === 'object' ? input : {};
  const conversations = Array.isArray(source.conversations)
    ? source.conversations.slice(0, MAX_CONVERSATIONS).map(sanitizeConversation).filter(Boolean)
    : [];
  return { version: 1, conversations, settings: sanitizeSettings(source.settings) };
}

/**
 * Local JSON store for conversations and settings. Writes are atomic (temp file + rename),
 * so a crash mid-save cannot leave a half-written file.
 */
class DataStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return sanitizeData({});
    }
    try {
      return sanitizeData(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      // Keep the unreadable file for diagnosis and start from a clean state.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
      return sanitizeData({});
    }
  }

  save(input) {
    const data = sanitizeData(input);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tempPath, this.filePath);
    return data;
  }
}

module.exports = {
  DataStore,
  DEFAULT_SETTINGS,
  sanitizeData,
  sanitizeSettings,
};
