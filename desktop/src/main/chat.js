'use strict';

const http = require('node:http');

const MAX_MESSAGES = 60;
const MAX_CONTENT_CHARS = 20_000;
const ROLES = new Set(['system', 'user', 'assistant']);

class ChatError extends Error {
  /**
   * @param {string} message
   * @param {{ partial?: string, aborted?: boolean }} [details]
   */
  constructor(message, { partial = '', aborted = false } = {}) {
    super(message);
    this.name = 'ChatError';
    this.partial = partial;
    this.aborted = aborted;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Validate messages coming from the renderer. This is a trust boundary, so
 * every field is checked before it is forwarded to the runtime.
 * @param {unknown} messages
 */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new Error('Invalid message list.');
  }
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || !ROLES.has(message.role) || typeof message.content !== 'string') {
      throw new Error('Invalid message.');
    }
    if (message.content.length > MAX_CONTENT_CHARS) {
      throw new Error('A message is too long.');
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * Validate a full chat request from the renderer.
 * @param {unknown} payload
 */
function validateChatRequest(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid chat request.');
  const { id, messages, options = {} } = payload;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) throw new Error('Invalid chat id.');
  return {
    id,
    messages: validateMessages(messages),
    temperature: clampNumber(options.temperature, 0, 2, 0.7),
    maxTokens: Math.round(clampNumber(options.maxTokens, 16, 4096, 512)),
  };
}

/**
 * Incremental parser for the runtime's SSE stream. Each event is a JSON envelope
 * ({ status, data, error }) on a `data:` line, separated by a blank line.
 * @param {(envelope: object) => void} onEnvelope
 */
function createSseParser(onEnvelope) {
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        if (dataLines.length > 0) {
          try {
            onEnvelope(JSON.parse(dataLines.join('\n')));
          } catch {
            // Ignore malformed frames; the runtime sends a dedicated error envelope for real failures.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    },
    flush() {
      if (buffer.trim()) {
        this.push('\n\n');
      }
    },
  };
}

function extractDelta(data) {
  const choice = data?.choices?.[0];
  const content = choice?.delta?.content;
  return typeof content === 'string' ? content : '';
}

function errorMessageFrom(raw, statusCode) {
  try {
    const envelope = JSON.parse(raw);
    if (typeof envelope?.error?.message === 'string') return envelope.error.message;
  } catch {
    // Non-JSON error bodies fall through to the generic message.
  }
  return `The engine returned HTTP ${statusCode}.`;
}

/**
 * Stream a chat completion from the local runtime.
 * Resolves with the full text, or rejects with a ChatError that carries any partial text.
 */
function streamChat({ port, token, messages, temperature, maxTokens, signal, onDelta = () => {} }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    });

    let text = '';
    let completed = false;
    let failure = null;
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'text/event-stream',
          'X-Codai-Token': token,
        },
      },
      (res) => {
        res.setEncoding('utf8');

        if (res.statusCode !== 200) {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => finish(() => reject(new ChatError(errorMessageFrom(raw, res.statusCode)))));
          return;
        }

        const parser = createSseParser((envelope) => {
          if (envelope.status === 'streaming') {
            const delta = extractDelta(envelope.data);
            if (delta) {
              text += delta;
              onDelta(delta);
            }
          } else if (envelope.status === 'complete') {
            completed = true;
          } else if (envelope.status === 'error') {
            failure = envelope.error?.message || 'The response was interrupted.';
          }
        });

        res.on('data', (chunk) => parser.push(chunk));
        res.on('end', () => {
          parser.flush();
          finish(() => {
            if (failure) reject(new ChatError(failure, { partial: text }));
            else if (!completed) reject(new ChatError('The response was cut off before it finished.', { partial: text }));
            else resolve({ text });
          });
        });
        res.on('error', () => finish(() => reject(new ChatError('The connection to the engine was lost.', { partial: text }))));
      },
    );

    function onAbort() {
      req.destroy();
      finish(() => reject(new ChatError('Stopped', { partial: text, aborted: true })));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);

    req.on('error', () => {
      finish(() => reject(new ChatError('Could not reach the engine. It may still be starting.', { partial: text })));
    });
    req.setTimeout(300_000, () => req.destroy());
    req.end(body);
  });
}

module.exports = {
  ChatError,
  createSseParser,
  streamChat,
  validateChatRequest,
  validateMessages,
};
