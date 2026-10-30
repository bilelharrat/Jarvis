// Firebase Cloud Messaging for Ask Eden Travel for Android (src/accounts/fcm.js): the service account's signed JWT
// traded for an access token (kept, made again after a 401), the HTTP v1 data message, FCM's error codes, and
// notifyOwner's travel pushes to an Android web device (only the Travel app's kinds; a token FCM calls UNREGISTERED is
// dropped). A key made here, a fake Google: nothing reaches Firebase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FCM_GONE, fcmData, fcmReady, forgetFcmToken, sendFcm } from '../src/accounts/fcm.js';
import { notifyOwner } from '../src/accounts/tasks.js';
import { b64ToBytes, bytesToB64 } from '../src/accounts/util.js';

const TOKEN = 'fGx1:APA91b' + 'Q'.repeat(140);

async function keyEnv(extra = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = bytesToB64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  const sa = { type: 'service_account', project_id: 'eden-travel', private_key_id: 'kid1', client_email: 'fcm@eden-travel.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` };
  return { env: { FCM_SERVICE_ACCOUNT: JSON.stringify(sa), ...extra }, pub: pair.publicKey };
}

const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/'))));

/** A fake Google: the token endpoint and FCM's messages:send, answering as `answers` says (in order, then 200). */
function google(pub, answers = []) {
  const calls = { token: 0, sends: [] };
  const fetcher = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      calls.token += 1;
      const assertion = new URLSearchParams(init.body).get('assertion');
      const [h, c, s] = assertion.split('.');
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/')), new TextEncoder().encode(`${h}.${c}`));
      assert.ok(ok, 'the JWT is signed with the service account key');
      const head = b64urlJson(h), claims = b64urlJson(c);
      assert.deepEqual([head.alg, head.kid], ['RS256', 'kid1']);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
      assert.equal(claims.iss, 'fcm@eden-travel.iam.gserviceaccount.com');
      assert.equal(claims.exp - claims.iat, 3600);
      return Response.json({ access_token: `at${calls.token}`, expires_in: 3599 });
    }
    calls.sends.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    const a = answers.shift();
    if (a) return Response.json(a.body, { status: a.status });
    return Response.json({ name: 'projects/eden-travel/messages/1' });
  };
  return { fetcher, calls };
}

test('ready only with a service account key and a project', async () => {
  assert.equal(fcmReady({}), false);
  assert.equal(fcmReady({ FCM_SERVICE_ACCOUNT: 'not json' }), false);
  const { env } = await keyEnv();
  assert.equal(fcmReady(env), true, 'the key’s own project_id');
  assert.equal(fcmReady({ FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'a@b', private_key: 'x' }) }), false, 'no project anywhere');
  assert.equal(fcmReady({ FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'a@b', private_key: 'x' }), FCM_PROJECT_ID: 'p' }), true);
  assert.deepEqual(await sendFcm({}, { token: TOKEN, data: {} }, async () => assert.fail('no call')), { status: 503, reason: 'not_set_up' });
});

test('a data message through HTTP v1: every value a string, the access token kept, made again after a 401', async () => {
  forgetFcmToken();
  const { env, pub } = await keyEnv({ FCM_PROJECT_ID: 'eden-travel-prod' });
  const g = google(pub, [{}, { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }].slice(1));
  const r = await sendFcm(env, { token: TOKEN, data: { title: 'TP1351 is late', kind: 'flight', n: 3, none: null, url: '' }, collapse: 'flight:x', ttl: 3600 }, g.fetcher);
  assert.deepEqual(r, { status: 200, name: 'projects/eden-travel/messages/1' }, 'a 401 then a fresh token and 200');
  assert.equal(g.calls.token, 2, 'the 401 made a new access token');
  const last = g.calls.sends.at(-1);
  assert.equal(last.url, 'https://fcm.googleapis.com/v1/projects/eden-travel-prod/messages:send', 'FCM_PROJECT_ID over the key’s');
  assert.equal(last.auth, 'Bearer at2');
  assert.deepEqual(last.body, { message: { token: TOKEN, data: { title: 'TP1351 is late', kind: 'flight', n: '3' }, android: { priority: 'HIGH', collapse_key: 'flight:x', ttl: '3600s' } } });
  await sendFcm(env, { token: TOKEN, data: { a: 'b' }, priority: 'normal' }, g.fetcher);
  assert.equal(g.calls.token, 2, 'the access token is kept');
  assert.equal(g.calls.sends.at(-1).body.message.android.priority, 'NORMAL');
});

test('FCM’s error codes come back; UNREGISTERED and SENDER_ID_MISMATCH mean the token is gone; too big and bad tokens never sent', async () => {
  forgetFcmToken();
  const { env, pub } = await keyEnv();
  const fcmError = (code, status) => ({ status, body: { error: { code: status, status: status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] } } });
  const g = google(pub, [fcmError('UNREGISTERED', 404), fcmError('INVALID_ARGUMENT', 400), { status: 503, body: { error: { status: 'UNAVAILABLE' } } }]);
  assert.deepEqual(await sendFcm(env, { token: TOKEN, data: {} }, g.fetcher), { status: 404, reason: 'UNREGISTERED' });
  assert.deepEqual(await sendFcm(env, { token: TOKEN, data: {} }, g.fetcher), { status: 400, reason: 'INVALID_ARGUMENT' });
  assert.deepEqual(await sendFcm(env, { token: TOKEN, data: {} }, g.fetcher), { status: 503, reason: 'UNAVAILABLE' });
  assert.ok(FCM_GONE.has('UNREGISTERED') && FCM_GONE.has('SENDER_ID_MISMATCH') && !FCM_GONE.has('INVALID_ARGUMENT'));
  const sends = g.calls.sends.length;
  assert.equal((await sendFcm(env, { token: TOKEN, data: { big: 'x'.repeat(5000) } }, g.fetcher)).reason, 'too_big');
  assert.equal((await sendFcm(env, { token: 'no spaces allowed', data: {} }, g.fetcher)).status, 400);
  assert.equal(g.calls.sends.length, sends, 'neither reached FCM');
  assert.deepEqual(fcmData({ plan: { a: 1 }, s: 's', z: undefined }), { plan: '{"a":1}', s: 's' });
});

// an account object as notifyOwner sees it: its devices, the 60-a-minute check, and fakes for both senders
function owner(devices, { fcmAnswer = () => ({ status: 200 }) } = {}) {
  const a = {
    env: {}, t: Date.parse('2027-05-12T08:00:00Z'), now() { return this.t; },
    apns: [], fcm: [], gone: [],
    devices: async () => devices,
    pushCheck: async (p) => ({ ok: true, token: p.fcm_token || p.apns_token }),
    pushGone: async (p) => { a.gone.push(p); for (const d of devices) if (d.fcm_token === p.fcm_token) d.fcm_token = null; return {}; },
    sendPush: async (p) => (a.apns.push(p), { status: 200 }),
    sendFcm: async (m) => (a.fcm.push(m), fcmAnswer(m)),
  };
  return a;
}

test('notifyOwner: an Android Travel device gets the travel kinds as { title, body, kind, collapse }; the iPhone’s path unchanged', async () => {
  const android = { id: 'd1', kind: 'web', fcm_token: TOKEN, fcm_app: 'com.askeden.travel', apns_token: null };
  const iphone = { id: 'd2', kind: 'iphone', apns_token: 'ab'.repeat(32), apns_env: 'production' };
  const browser = { id: 'd3', kind: 'web', fcm_token: 'x'.repeat(40), fcm_app: null };
  const a = owner([android, iphone, browser]);
  assert.equal(await notifyOwner(a, { title: 'TP1351 is late', body: 'Now 15:40.\nGate 14', data: { kind: 'flight', trip: 'a1b2c3d4e5f60718', stop: 's3', ident: 'TP1351' } }), 2);
  assert.deepEqual(a.fcm, [{ token: TOKEN, priority: 'high', data: { title: 'TP1351 is late', body: 'Now 15:40. Gate 14', kind: 'flight', collapse: 'flight:a1b2c3d4e5f60718:s3' } }]);
  assert.equal(a.apns.length, 1, 'the iPhone still hears it through APNs');
  assert.equal(await notifyOwner(a, { title: 'Approve?', body: 'A draft', data: { kind: 'approval', approval: 'x' } }), 1, 'Eden Secretary’s pushes stay off the travel app');
  assert.equal(a.fcm.length, 1);
  await notifyOwner(a, { title: 'Booking email received', body: 'In Eden Travel', data: { kind: 'inbox', url: '/t/abc' } });
  assert.deepEqual(a.fcm.at(-1).data, { title: 'Booking email received', body: 'In Eden Travel', kind: 'inbox', url: '/t/abc' });
  await notifyOwner(a, { title: 'x', body: 'y', data: { kind: 'inbox', url: '//evil.example' } });
  assert.equal('url' in a.fcm.at(-1).data, false, 'only a path here');
});

test('notifyOwner: a token FCM calls UNREGISTERED is dropped; expired browsers and no FCM key send nothing', async () => {
  const android = { id: 'd1', kind: 'web', fcm_token: TOKEN, fcm_app: 'com.askeden.travel' };
  const a = owner([android], { fcmAnswer: () => ({ status: 404, reason: 'UNREGISTERED' }) });
  assert.equal(await notifyOwner(a, { title: 'Sam picked where to meet', body: 'Door 4', data: { kind: 'pickup' } }), 0);
  assert.deepEqual(a.gone, [{ fcm_token: TOKEN }]);
  assert.equal(android.fcm_token, null);
  const old = owner([{ id: 'd1', kind: 'web', fcm_token: TOKEN, fcm_app: 'com.askeden.travel', expires: 1 }]);
  assert.equal(await notifyOwner(old, { title: 't', body: 'b', data: { kind: 'pickup' } }), 0);
  assert.equal(old.fcm.length, 0);
  // the real sender without a key: nothing goes, no error
  const bare = owner([{ id: 'd1', kind: 'web', fcm_token: TOKEN, fcm_app: 'com.askeden.travel' }]);
  delete bare.sendFcm;
  delete bare.sendPush;
  assert.equal(await notifyOwner(bare, { title: 't', body: 'b', data: { kind: 'pickup' } }), 0);
});
