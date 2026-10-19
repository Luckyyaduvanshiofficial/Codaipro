/* Splash shows startup progress. It only uses the narrow codaiSplash bridge. */
(function () {
  'use strict';
  const PHASES = {
    initializing: 'Starting your private AI assistant...',
    analyzing_hardware: 'Checking your computer...',
    downloading: 'Downloading the AI model. This happens once...',
    loading_model: 'Loading the AI model. This can take a minute...',
    binding_port: 'Almost ready...',
    ready: 'Ready',
  };
  const label = document.getElementById('msg');
  window.codaiSplash.onPhase((payload) => {
    const text = PHASES[payload?.phase];
    if (text) label.textContent = text;
  });
})();
