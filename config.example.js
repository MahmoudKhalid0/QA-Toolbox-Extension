// Built-in configuration for the AI Profile Generator.
// SETUP: copy this file to "config.js" and put the real Anthropic API key in it.
// config.js is gitignored so the key never reaches the repository.
const exportConfigTarget = typeof globalThis !== 'undefined' ? globalThis : self;
exportConfigTarget.AI_CONFIG = {
    // Paste the Anthropic API key here
    apiKey: 'PUT-YOUR-KEY-HERE',
    model: 'claude-haiku-4-5'
};
