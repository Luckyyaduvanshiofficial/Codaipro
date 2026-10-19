'use strict';

/**
 * Turn a raw startup exception into a short, friendly explanation for the window.
 * The technical text is kept separately so the UI can hide it behind a disclosure.
 *
 * @param {unknown} error
 * @returns {{ title: string, message: string, hint: string, detail: string }}
 */
function describeStartupError(error) {
  const detail = String(error?.message || error || 'Unknown error');
  const lower = detail.toLowerCase();

  if (lower.includes('missing engine binary') || lower.includes('engine is missing') || lower.includes('llama-server')) {
    return {
      title: "The AI engine isn't ready",
      message: "Codai Pro couldn't find the llama.cpp engine for this computer, so it can't answer questions yet.",
      hint: 'If you are running from source, put the engine for your platform in the engine folder. Otherwise, reinstalling Codai Pro usually fixes this.',
      detail,
    };
  }

  if (lower.includes('missing model') || lower.includes('model file') || lower.includes('model is missing') || lower.includes('.gguf')) {
    return {
      title: "The AI model isn't ready",
      message: "Codai Pro couldn't find the language model it runs on your computer.",
      hint: 'Download the model, or set model_name and model_url in config.json, then try again.',
      detail,
    };
  }

  if (lower.includes('enoent')) {
    return {
      title: "Codai Pro couldn't find its runtime",
      message: 'A file needed to start the local engine is missing.',
      hint: 'If you are running from source, install Python 3.10 or newer and place the engine in the engine folder. Otherwise, reinstall Codai Pro.',
      detail,
    };
  }

  if (lower.includes('stopped unexpectedly')) {
    return {
      title: 'The AI engine stopped',
      message: 'The engine that answers your questions stopped running.',
      hint: 'Try again. If it keeps happening, open the logs and share them.',
      detail,
    };
  }

  return {
    title: "Codai Pro couldn't start",
    message: 'The local AI engine stopped while starting.',
    hint: 'Try again. If it keeps happening, open the logs and share them.',
    detail,
  };
}

module.exports = { describeStartupError };
