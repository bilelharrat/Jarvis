// Settings' pure logic (app.js drawSettings): a provider's glyph tile and a key's status pill.
// No imports: the tests load this file on its own.

// Lettermarks on each provider's colour (simple monograms, no logos).
const GLYPHS = {
  anthropic: { mark: 'A', from: '#e3946b', to: '#c46a43' },
  claude: { mark: 'A', from: '#e3946b', to: '#c46a43' },
  openai: { mark: 'O', from: '#3fb59a', to: '#1f8a72' },
  gpt: { mark: 'O', from: '#3fb59a', to: '#1f8a72' },
  gemini: { mark: 'G', from: '#7aa2f7', to: '#4a6fd6' },
  google: { mark: 'G', from: '#7aa2f7', to: '#4a6fd6' },
  kimi: { mark: 'K', from: '#a58bd6', to: '#7a5fb8' },
  moonshot: { mark: 'K', from: '#a58bd6', to: '#7a5fb8' },
};
/** { mark, from, to } for a provider id (an unknown one: its first letter on grey). */
export function providerGlyph(id, name) {
  const g = GLYPHS[String(id || '').toLowerCase()];
  if (g) return g;
  const ch = [...String(name || id || '?').trim()][0] || '?';
  return { mark: ch.toUpperCase(), from: '#a1a1a6', to: '#7c7c80' };
}

/**
 * A key's status: { pill, tone, detail }. tone: 'own' (your key works), 'included' (askeden.com's
 * included AI), 'sub' (Claude through the Claude Code subscription), 'env', 'off' (nothing).
 */
export function keyStatus(p, k, hosted) {
  const key = k || {};
  if (key.set) {
    if (key.source === 'env') return { pill: 'Environment', tone: 'env', detail: 'Set in the environment; it wins over a saved key.' };
    if (key.source === 'account') return { pill: 'Using your key', tone: 'own', detail: `····${key.last4 || ''}${key.added ? ` · added ${new Date(key.added).toLocaleDateString()}` : ''}`.trim() };
    return { pill: 'Using your key', tone: 'own', detail: 'Saved on this Mac' };
  }
  if (hosted) return p && p.available ? { pill: 'Included AI', tone: 'included', detail: 'Chats use your plan’s included AI until you add a key.' } : { pill: 'Not set', tone: 'off', detail: 'Add a key to use these models.' };
  if (p && p.id === 'anthropic' && p.available) return { pill: 'Subscription', tone: 'sub', detail: 'No key needed: Claude works through your Claude Code subscription.' };
  return { pill: 'Not set', tone: 'off', detail: (p && !p.available && p.reason) || 'Add a key to use these models.' };
}
