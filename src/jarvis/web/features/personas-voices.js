// A persona's own voice (personas.js's editor, speaking.clean_persona_voice): the voices
// Settings › Speaking offers, as choices. Mac voices for the window's language; a cloud
// service's voices (the one picked there and those listed) once it has a key. The persona's
// current voice stays a choice even when it isn't listed just now.
(function (root) {
  'use strict';

  const CLOUD_NAMES = { elevenlabs: 'ElevenLabs voices', fish: 'Fish Audio voices' };  // (as its group of choices is headed)

  function valueOf(voice) {
    if (!voice || !voice.provider) return '';
    return voice.provider === 'say' ? JSON.stringify({ provider: 'say', name: voice.name }) : JSON.stringify({ provider: voice.provider, id: voice.id, name: voice.name || voice.id });
  }

  function fromValue(value) {
    if (!value) return {};
    try { const v = JSON.parse(value); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
  }

  // [{ group: '' | 'mac' | 'elevenlabs' | 'fish', label, value }] from the "voice" event.
  function options(state, current) {
    const out = [{ group: '', label: 'The usual voice', value: '' }];
    const s = state || {};
    const seen = new Set(['']);
    const add = (group, label, voice) => {
      const value = valueOf(voice);
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push({ group, label, value });
    };
    for (const v of s.mac_voices || []) add('mac', v.name, { provider: 'say', name: v.name });
    for (const p of Object.keys(CLOUD_NAMES)) {
      const c = (s.clouds || {})[p];
      if (!c || !(c.key || c.env_key)) continue;
      const listed = [...(c.voice && c.voice.id ? [c.voice] : []), ...(c.voices || [])];
      for (const v of listed) if (v && v.id) add(p, v.name || v.id, { provider: p, id: v.id, name: v.name || v.id });
    }
    if (current && current.provider) {
      add(current.provider === 'say' ? 'mac' : current.provider, current.name || current.id || '', current);
    }
    return out;
  }

  const api = { options, valueOf, fromValue, CLOUD_NAMES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.jarvisPersonaVoices = api;
})(typeof window === 'object' ? window : globalThis);
