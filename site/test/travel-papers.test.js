// Travellers' papers and entry deadlines (src/travel/papers.js, rules in src/travel/entry-rules.js). A fake clock and
// in-memory storage only; nothing here reaches a government site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './fakes.js';
import { queued } from '../src/accounts/schedule.js';
import { PAPERS, addMonths, armPapersReminders, cleanPapers, countriesNamed, entryChecks, openItems, papersOp, papersRemindersDue, stageTimes, workingDaysBefore } from '../src/travel/papers.js';
import { AUTH_RULES, ETIAS, PASSPORT_RULES, RULES_VERIFIED, SCHENGEN } from '../src/travel/entry-rules.js';

const account = (t) => ({ storage: new Storage(), env: {}, t, now() { return this.t; } });
const jobAt = async (a) => (await queued(a)).find((j) => j.kind === 'tpap')?.at ?? null;
const days = (n) => Array.from({ length: n }, (_, i) => ({ title: `Day ${i + 1}`, stops: [] }));
const trav = (o) => ({ id: 'p-0000000001', name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', passport_issued: null, auths: [], ...o });
const T0 = Date.parse('2026-10-28T12:00:00Z');

test('rules: every row has an official source and a verified date; ETIAS is not started', () => {
  for (const r of [...PASSPORT_RULES, ...AUTH_RULES, ETIAS]) {
    assert.match(r.source.url, /^https:\/\/(www\.)?(europa\.eu|gov\.uk|dhs\.gov|esta\.cbp\.dhs\.gov|canada\.ca|immi\.homeaffairs\.gov\.au|immigration\.govt\.nz|travel-europe\.europa\.eu)\//);
    assert.match(r.source.verified, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(ETIAS.started, false);
  assert.equal(SCHENGEN.length, 29);
  assert.equal(AUTH_RULES.find((r) => r.id === 'us-esta').needed_by.length, 42); // DHS: 42 VWP countries
  assert.equal(RULES_VERIFIED, '2026-10-28');
});

test('dates: months clamp to the month’s end; working days skip weekends', () => {
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2027-05-15', -120), '2017-05-15');
  assert.equal(workingDaysBefore('2027-03-15', 3), '2027-03-10'); // Monday → the Wednesday before
  assert.equal(workingDaysBefore('2027-03-18', 3), '2027-03-15'); // Thursday → Monday
});

test('papers: no numbers kept, codes and dates checked', () => {
  assert.throws(() => cleanPapers({ name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', passport_number: '123456789' }), /numbers/);
  assert.throws(() => cleanPapers({ name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', auths: [{ kind: 'esta', expires: '2027-01-01', number: 'X1' }] }), /numbers/);
  assert.throws(() => cleanPapers({ name: 'Bilel', nationality: 'XX', passport_expires: '2030-01-01' }), /nationality/);
  assert.throws(() => cleanPapers({ name: 'Bilel', nationality: 'GB', passport_expires: '2030-02-30' }), /expiry/);
  assert.throws(() => cleanPapers({ name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', auths: [{ kind: 'etias', expires: '2027-01-01' }] }), /kind/);
  const p = cleanPapers({ name: '  Bilel  ', nationality: 'gb', passport_expires: '2030-01-01', passport_issued: '2020-01-01', auths: [{ kind: 'esta', expires: '2027-06-01' }] });
  assert.deepEqual(p, { name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', passport_issued: '2020-01-01', auths: [{ kind: 'esta', expires: '2027-06-01' }] });
});

test('papers ops: save (confirm), same name replaces, delete', async () => {
  const a = account(T0);
  await assert.rejects(papersOp(a, 'trip-papers-save', { name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01' }), /confirm/);
  let r = await papersOp(a, 'trip-papers-save', { name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', confirm: true });
  assert.equal(r.travellers.length, 1);
  assert.equal(r.travellers[0].nationality_name, 'United Kingdom');
  assert.ok(r.kinds.some((k) => k.kind === 'esta'));
  r = await papersOp(a, 'trip-papers-save', { name: 'bilel', nationality: 'PT', passport_expires: '2031-01-01', confirm: true });
  assert.equal(r.travellers.length, 1);
  assert.equal(r.travellers[0].nationality, 'PT');
  const id = r.travellers[0].id;
  assert.ok(!JSON.stringify(await a.storage.get('tpapers')).match(/number/));
  r = await papersOp(a, 'trip-papers-delete', { id });
  assert.equal(r.travellers.length, 0);
  await assert.rejects(papersOp(a, 'trip-papers-delete', { id }), /no such traveller/);
});

test('Schengen: the passport must last 3 months after you leave the area', () => {
  const trip = { title: 'Lisbon', start: '2026-11-25', days: days(6) };
  const items = entryChecks(trip, [trav({ passport_expires: '2027-01-10' })], [{ code: 'PT', from: '2026-11-25', to: '2026-11-30' }], '2026-10-28');
  const p = items.find((i) => i.key.endsWith('schengen-passport'));
  assert.equal(p.status, 'problem');
  assert.equal(p.text, 'Bilel’s passport must be valid until 28 Feb 2027 for Portugal (Schengen area); it expires 10 Jan 2027.');
  assert.equal(p.source.url, 'https://europa.eu/youreurope/citizens/travel/entry-exit/non-eu-nationals/index_en.htm');
  assert.equal(p.by, '2026-11-25');
  // no issue date saved: a check, never a guess
  assert.equal(items.find((i) => i.key.endsWith(':issued')).status, 'check');
  // the whole area counts once, to its last exit
  const two = entryChecks(trip, [trav({ passport_expires: '2027-03-01' })], [{ code: 'PT', from: '2026-11-25', to: '2026-11-27' }, { code: 'ES', from: '2026-11-27', to: '2026-12-02' }], '2026-10-28');
  const s = two.filter((i) => i.key.endsWith('schengen-passport'));
  assert.equal(s.length, 1);
  assert.equal(s[0].status, 'problem'); // needed until 2 Mar 2027
  assert.match(s[0].text, /Portugal, Spain \(Schengen area\)/);
  // an old passport
  const old = entryChecks(trip, [trav({ passport_issued: '2016-01-01' })], [{ code: 'PT', from: '2026-11-25', to: '2026-11-30' }], '2026-10-28');
  assert.equal(old.find((i) => i.key.endsWith(':issued')).status, 'problem');
  // an EU citizen: Eden states no Schengen passport rule
  const eu = entryChecks(trip, [trav({ nationality: 'FR' })], [{ code: 'PT', from: '2026-11-25', to: '2026-11-30' }], '2026-10-28');
  assert.ok(!eu.some((i) => i.key.endsWith('schengen-passport')));
  assert.ok(!eu.some((i) => i.key.endsWith('etias')));
});

test('ETIAS: said to have not started, never a to-do', () => {
  const items = entryChecks({ start: '2027-05-01', days: days(3) }, [trav({ nationality: 'US' })], [{ code: 'FR', from: '2027-05-01', to: '2027-05-03' }], '2026-10-28');
  const e = items.find((i) => i.key.endsWith('etias'));
  assert.equal(e.status, 'info');
  assert.match(e.text, /hasn’t started/);
  assert.equal(openItems(items).filter((i) => /ETIAS/.test(i.text)).length, 0);
  // and no Schengen rule for US visas: the official page
  assert.equal(items.find((i) => i.key.endsWith('FR:check')).status, 'check');
  assert.ok(items.find((i) => i.key.endsWith('FR:check')).links.some((l) => /travel\.state\.gov/.test(l.url)));
});

test('ESTA: needed for VWP nationals, valid only on arrival', () => {
  const trip = { start: '2027-03-15', days: days(10) };
  const us = [{ code: 'US', from: '2027-03-15', to: '2027-03-24' }];
  let i = entryChecks(trip, [trav()], us, '2026-10-28').find((x) => x.key.endsWith('us-esta'));
  assert.equal(i.status, 'todo');
  assert.equal(i.text, 'ESTA needed for United States (Bilel, United Kingdom passport). Homeland Security recommends applying when travel plans are made.');
  assert.equal(i.by, '2026-10-28');
  assert.equal(i.apply_url, 'https://esta.cbp.dhs.gov/');
  i = entryChecks(trip, [trav({ auths: [{ kind: 'esta', expires: '2027-03-18' }] })], us, '2026-10-28').find((x) => x.key.endsWith('us-esta'));
  assert.equal(i.status, 'ok'); // ends mid-stay: fine, the FAQ says on arrival
  i = entryChecks(trip, [trav({ auths: [{ kind: 'esta', expires: '2027-03-01' }] })], us, '2026-10-28').find((x) => x.key.endsWith('us-esta'));
  assert.equal(i.status, 'problem');
  // a Canadian: not on the VWP list, so the official page (no claim either way)
  const ca = entryChecks(trip, [trav({ nationality: 'CA' })], us, '2026-10-28');
  assert.ok(!ca.some((x) => x.key.endsWith('us-esta')));
  assert.equal(ca.find((x) => x.key.endsWith('US:check')).status, 'check');
  // home: nothing
  assert.equal(entryChecks(trip, [trav({ nationality: 'US' })], us, '2026-10-28').length, 0);
});

test('UK ETA: 3 working days before arrival; British and Irish need none', () => {
  const trip = { start: '2027-03-15', days: days(3) };
  const gb = [{ code: 'GB', from: '2027-03-15', to: '2027-03-17' }];
  const i = entryChecks(trip, [trav({ nationality: 'US' })], gb, '2026-10-28').find((x) => x.key.endsWith('uk-eta'));
  assert.equal(i.status, 'todo');
  assert.equal(i.by, '2027-03-10');
  assert.equal(i.by_text, 'apply by 10 Mar 2027 (3 working days before you arrive)');
  assert.ok(!entryChecks(trip, [trav({ nationality: 'IE' })], gb, '2026-10-28').some((x) => x.status === 'todo'));
  // an ETA that ends mid-stay: GOV.UK doesn't say, so "check"
  const mid = entryChecks(trip, [trav({ nationality: 'US', auths: [{ kind: 'eta_uk', expires: '2027-03-16' }] })], gb, '2026-10-28').find((x) => x.key.endsWith('uk-eta'));
  assert.equal(mid.status, 'check');
  // UK passport rule: valid for the whole stay
  const short = entryChecks(trip, [trav({ nationality: 'US', passport_expires: '2027-03-16' })], gb, '2026-10-28').find((x) => x.key.endsWith('uk-passport'));
  assert.equal(short.status, 'problem');
});

test('Canada eTA: US citizens exempt, air only; Australia and New Zealand', () => {
  const trip = { start: '2027-06-01', days: days(5) };
  const ca = (by_air = null) => [{ code: 'CA', from: '2027-06-01', to: '2027-06-05', by_air }];
  assert.ok(!entryChecks(trip, [trav({ nationality: 'US' })], ca(), '2026-10-28').some((x) => x.key.endsWith('ca-eta')));
  assert.equal(entryChecks(trip, [trav()], ca(), '2026-10-28').find((x) => x.key.endsWith('ca-eta')).status, 'todo');
  assert.equal(entryChecks(trip, [trav()], ca(false), '2026-10-28').find((x) => x.key.endsWith('ca-eta')).status, 'check');
  assert.equal(entryChecks(trip, [trav()], [{ code: 'AU', from: '2027-06-01', to: '2027-06-05' }], '2026-10-28').find((x) => x.key.endsWith('au-eta')).status, 'todo');
  const nz = entryChecks(trip, [trav({ nationality: 'US' })], [{ code: 'NZ', from: '2027-06-01', to: '2027-06-05' }], '2026-10-28').find((x) => x.key.endsWith('nz-eta'));
  assert.equal(nz.by, '2027-06-01');
  assert.ok(!entryChecks(trip, [trav({ nationality: 'AU' })], [{ code: 'NZ', from: '2027-06-01', to: '2027-06-05' }], '2026-10-28').some((x) => x.status === 'todo'));
});

test('a passport that runs out mid-trip is flagged anywhere, without a rule', () => {
  const i = entryChecks({ start: '2027-01-01', days: days(10) }, [trav({ nationality: 'US', passport_expires: '2027-01-05' })], [{ code: 'JP', from: '2027-01-01', to: '2027-01-10' }], '2026-10-28');
  assert.equal(i.find((x) => x.key.endsWith('JP:expires')).status, 'problem');
  assert.equal(i.find((x) => x.key.endsWith('JP:check')).status, 'check');
});

test('countries from the destination, by name', () => {
  assert.deepEqual(countriesNamed('Lisbon, Portugal'), ['PT']);
  assert.deepEqual(countriesNamed('Belfast, Northern Ireland'), ['GB']);
  assert.deepEqual(countriesNamed('Spain and France'), ['ES', 'FR']);
  assert.deepEqual(countriesNamed('Lisbon'), []);
});

test('trip-entry-check: derived countries, then the ones the person set', async () => {
  const a = account(T0);
  a.storage.map.set('trip:t1', { id: 't1', title: 'Lisbon', destination: 'Lisbon, Portugal', start: '2026-11-25', days: days(6) });
  await papersOp(a, 'trip-papers-save', { name: 'Bilel', nationality: 'GB', passport_expires: '2027-01-10', confirm: true });
  let r = await papersOp(a, 'trip-entry-check', { id: 't1' });
  assert.equal(r.countries_derived, true);
  assert.deepEqual(r.countries.map((c) => c.code), ['PT']);
  assert.equal(r.rules_verified, '2026-10-28');
  assert.ok(r.open.some((k) => k.endsWith('schengen-passport')));
  r = await papersOp(a, 'trip-entry-check', { id: 't1', countries: [{ code: 'PT' }, { code: 'GB', from: '2026-11-29', to: '2026-11-30' }] });
  assert.equal(r.countries_derived, false);
  assert.ok(r.items.some((i) => i.key.endsWith('uk-eta')) === false); // a British citizen at home
  await assert.rejects(papersOp(a, 'trip-entry-check', { id: 't1', countries: [{ code: 'ZZ' }] }), /two-letter/);
  await assert.rejects(papersOp(a, 'trip-entry-check', { id: 't1', travellers: ['p-ffffffffff'] }), /saved travellers/);
  await assert.rejects(papersOp(a, 'trip-entry-check', { id: 'nope' }), /no such trip/);
});

test('reminders: the morning after it is found, then before it is due, each once; fixed items stop', async () => {
  const a = account(Date.parse('2027-01-20T15:00:00Z'));
  a.storage.map.set('trip:t1', { id: 't1', title: 'New York', destination: 'New York, United States', start: '2027-03-15', days: days(5) });
  await papersOp(a, 'trip-papers-save', { name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', confirm: true });
  const at = await armPapersReminders(a);
  assert.equal(at, Date.parse('2027-01-21T09:00:00Z')); // the next morning (UTC: no trip zone)
  assert.equal(await jobAt(a), at);
  const sent = [];
  const notify = async (_acc, p) => { sent.push(p); };
  a.t = at;
  await papersRemindersDue(a, { notify });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /ESTA needed for United States/);
  assert.equal(sent[0].data.url, 'https://esta.cbp.dhs.gov/');
  await papersRemindersDue(a, { notify });
  assert.equal(sent.length, 1); // once
  // "apply now" advice: the later pushes count back from the arrival day (15 Mar − 42 days = 1 Feb)
  assert.equal(await jobAt(a), Date.parse('2027-02-01T09:00:00Z'));
  // saved: nothing more
  await papersOp(a, 'trip-papers-save', { name: 'Bilel', nationality: 'GB', passport_expires: '2030-01-01', auths: [{ kind: 'esta', expires: '2029-01-01' }], confirm: true });
  assert.equal(await armPapersReminders(a), null);
  assert.equal(await jobAt(a), null);
  assert.equal([...(await a.storage.list({ prefix: 'tpaprem:' }))].length, 0);
});

test('stages: a missed morning long ago is not sent late', async () => {
  const item = { by: '2027-03-10', kind: 'auth' };
  const st = stageTimes(item, Date.parse('2026-12-01T10:00:00Z'));
  assert.deepEqual(st.map((s) => s.stage), ['found', 'd42', 'd14', 'd7', 'd3', 'by']);
  const a = account(Date.parse('2027-03-08T12:00:00Z'));
  a.storage.map.set('trip:t1', { id: 't1', title: 'London', destination: 'London, United Kingdom', start: '2027-03-15', days: days(3) });
  await papersOp(a, 'trip-papers-save', { name: 'Ann', nationality: 'US', passport_expires: '2030-01-01', confirm: true });
  await armPapersReminders(a); // found on the 8th: the apply-by morning (10 Mar) is the first push, so no 'found' one
  const sent = [];
  a.t = Date.parse('2027-03-10T09:00:00Z') + PAPERS.lateMs + 1000; // the job was off past that morning
  await papersRemindersDue(a, { notify: async (_x, p) => sent.push(p) });
  assert.equal(sent.length, 0);
});
