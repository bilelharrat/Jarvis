// The JARVIS voice's constants (worker.js). Kept out of worker.js: the Workers runtime takes
// every named export of the main module for an entrypoint and refuses plain values.
export const JARVIS_VOICE_ID = '612b878b113047d9a770c069c8b4fdfe';
export const LIMITS = { text: 600, install: 20000, network: 40000, everyone: 400000 };
