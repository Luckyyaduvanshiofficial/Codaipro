/* Safe Markdown renderer. Every piece of model output is HTML-escaped before tags are added,
 * so the result can only contain markup this file creates. */
(function (global) {
  'use strict';

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const KEYWORDS = new Set([
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try',
    'except', 'finally', 'raise', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'lambda', 'yield',
    'async', 'await', 'function', 'const', 'let', 'var', 'new', 'this', 'export', 'default', 'switch', 'case',
    'break', 'continue', 'void', 'int', 'char', 'float', 'double', 'struct', 'public', 'private', 'static',
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE',
    'select', 'from', 'where', 'join', 'group', 'order', 'by', 'limit', 'insert', 'update', 'delete',
  ]);

  // Highlighting runs on already-escaped text, so token spans are the only markup added.
  function highlight(escaped) {
    const pattern = /(\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)(?=\s*\()|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
    return escaped.replace(pattern, (match, comment, str, num, fn, word) => {
      if (comment) return `<span class="tok-com">${comment}</span>`;
      if (str) return `<span class="tok-str">${str}</span>`;
      if (num) return `<span class="tok-num">${num}</span>`;
      if (fn) return KEYWORDS.has(fn) ? `<span class="tok-kw">${fn}</span>` : `<span class="tok-fn">${fn}</span>`;
      if (word && KEYWORDS.has(word)) return `<span class="tok-kw">${word}</span>`;
      return match;
    });
  }

  function renderCodeBlock(lang, code) {
    const label = lang ? escapeHtml(lang) : 'code';
    const escaped = escapeHtml(code);
    const body = highlight(escaped);
    return (
      '<div class="code-block">' +
        '<div class="code-head">' +
          `<span>${label}</span>` +
          '<button class="code-copy" type="button" data-copy>Copy</button>' +
        '</div>' +
        `<pre><code>${body}</code></pre>` +
        `<textarea class="copy-source" hidden>${escaped}</textarea>` +
      '</div>'
    );
  }

  function inline(text) {
    // text is already escaped. Apply inline formatting only; never introduce raw HTML.
    let out = text.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return out;
  }

  function renderTable(lines) {
    const rows = lines.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const [head, , ...body] = rows;
    const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
    const tbody = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table>`;
  }

  function renderMarkdown(source) {
    // Normalize fences so they always sit on their own line: "text```lang" becomes
    // "text\n```lang". This is tolerant of models that wrap a whole block on one line.
    const lines = String(source ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/([^\n`])```/g, '$1\n```')
      .split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^```\s*([A-Za-z0-9_+#.-]*)\s*$/);
      if (fence) {
        const code = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push(renderCodeBlock(fence[1], code.join('\n')));
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const tableLines = [line];
        i += 1;
        const sep = lines[i];
        i += 1;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          tableLines.push(lines[i]);
          i += 1;
        }
        out.push(renderTable([tableLines[0], sep, ...tableLines.slice(1)]));
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const tag = ordered ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
          const itemText = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
          items.push(`<li>${inline(escapeHtml(itemText))}</li>`);
          i += 1;
        }
        out.push(`<${tag}>${items.join('')}</${tag}>`);
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^>\s?/, ''));
          i += 1;
        }
        out.push(`<blockquote>${inline(escapeHtml(quote.join(' ')))}</blockquote>`);
        continue;
      }

      if (line.trim() === '') {
        i += 1;
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^(```|#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|>)/.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      if (para.length === 0) {
        para.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${para.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
    }

    return out.join('');
  }

  global.CodaiMarkdown = { render: renderMarkdown, escapeHtml };
})(window);
