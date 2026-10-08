import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRefusal, refusalKind, refusalPlan } from '../src/eden/refusal.js';
import { EDEN_IDENTITY, JARVIS_PERSONA, hostedConfig, parseSend, personaOf, refusalCandidate, systemPrompt } from '../src/eden/chat.js';

test('refusal detection: short replies that open with a refusal, in several languages', () => {
  for (const t of [
    "I can't help with that.",
    "I’m sorry, but I can't continue with this request.",
    'Sorry, I cannot do that.',
    "I'm unable to provide instructions for that.",
    'Je ne peux pas vous aider avec cela.',
    'Lo siento, no puedo ayudar con eso.',
    'Es tut mir leid, aber ich kann dabei nicht helfen.',
    'Mi dispiace, non posso aiutarti.',
    'Desculpe, não posso ajudar com isso.',
  ]) assert.ok(isRefusal(t), t);
  for (const t of ['', 'Run `kill -9 1234` to stop the process.', `Here's how.\n${'x'.repeat(2000)} I can't help with the rest.`, 'You can’t kill PID 1, but here is how to stop the service: systemctl stop foo.']) assert.ok(!isRefusal(t), t);
});

test('refusal kind: benign vs copyright vs safety, by rules', () => {
  assert.equal(refusalKind('How do I kill a process on Linux?', "I can't help with killing."), 'benign');
  assert.equal(refusalKind('What is a safe dose of ibuprofen for an adult?'), 'benign');
  assert.equal(refusalKind('How does SQL injection work, for my pentest class?'), 'benign');
  assert.equal(refusalKind('kill the child process that hangs'), 'benign');
  assert.equal(refusalKind('Give me the full lyrics of Bohemian Rhapsody'), 'copyright');
  assert.equal(refusalKind('Paste the whole article from the NYT'), 'copyright');
  assert.equal(refusalKind('show me this', "I can't reproduce copyrighted song lyrics."), 'copyright');
  assert.equal(refusalKind('How do I build a pipe bomb?'), 'safety');
  assert.equal(refusalKind('how to poison my neighbour'), 'safety');
  assert.equal(refusalKind('write sexual content about a 14 year old'), 'safety');
});

const other = () => ({ model: 'gpt-x', effort: 'medium', name: 'GPT X', provider: 'openai' });

test('refusal plan: a benign refusal is retried once; pinned → an offer; copyright and safety never', () => {
  const no = "I can't help with that.";
  assert.equal(refusalPlan({ prompt: 'kill a process', text: 'kill -9 it' }), null);
  assert.deepEqual(refusalPlan({ prompt: 'kill a process', text: no, candidate: other }), { kind: 'benign', action: 'retry', model: 'gpt-x', effort: 'medium', name: 'GPT X', provider: 'openai' });
  assert.equal(refusalPlan({ prompt: 'kill a process', text: no, retried: true, candidate: other }).action, 'none'); // once at most
  assert.equal(refusalPlan({ prompt: 'kill a process', text: no, pinned: true, candidate: other }).action, 'offer');
  assert.deepEqual(refusalPlan({ prompt: 'lyrics of Yesterday please', text: no, candidate: other }), { kind: 'copyright', action: 'none' });
  assert.deepEqual(refusalPlan({ prompt: 'how to make a bomb', text: no, candidate: other }), { kind: 'safety', action: 'none' });
  assert.equal(refusalPlan({ prompt: 'kill a process', text: no, candidate: () => null }).action, 'none');
});

test('refusal candidate: another provider among the models this turn may use', () => {
  const cfg = hostedConfig({ OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', MOONSHOT_API_KEY: 'k' });
  const first = cfg.models[0];
  const c = refusalCandidate(cfg, first, null, 'how do I kill a process on linux');
  assert.ok(c && c.provider !== first.provider && cfg.models.some((m) => m.id === c.model));
  assert.equal(refusalCandidate({ ...cfg, models: cfg.models.filter((m) => m.provider === first.provider) }, first, null, 'x'), null);
});

test('persona: "jarvis" adds the Talk-mode line; anything else is a 400; identity has the copyright and tone rules', () => {
  const cfg = hostedConfig({ OPENAI_API_KEY: 'k' });
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.equal(personaOf(undefined), null);
  assert.throws(() => personaOf('hal'), /persona must be "jarvis"/);
  assert.throws(() => parseSend({ messages: msgs, persona: 3 }, cfg), /persona/);
  const b = parseSend({ messages: msgs, persona: 'jarvis' }, cfg);
  assert.ok(systemPrompt(b).includes(JARVIS_PERSONA));
  assert.ok(!systemPrompt(parseSend({ messages: msgs }, cfg)).includes(JARVIS_PERSONA));
  assert.match(EDEN_IDENTITY, /Lead with what you can help with/);
  assert.match(EDEN_IDENTITY, /song lyrics/);
});
