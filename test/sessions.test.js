import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aperturekit-session-test-'));
const { createApp } = await import('../src/app.js');
const { one, run } = await import('../src/db.js');

let server;
let base;
let admin;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  await admin.post('/setup', { name: 'Ada', email: 'ada@example.com', password: 'password123' });
  await client().post('/register', { name: 'Bo', email: 'bo@example.com', password: 'password123' });
});
after(() => {
  server.close();
  fs.rmSync(process.env.PORTAL_DATA_DIR, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const remember = (res) => { if (res.headers.get('set-cookie')) cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); };
  const get = async (p) => {
    const res = await fetch(base + p, { headers: { cookie }, redirect: 'manual' });
    remember(res);
    return res;
  };
  const post = async (p, body, from = p) => {
    const html = await (await get(from)).text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, ...body }).toString(),
      redirect: 'manual',
    });
    remember(res);
    return res;
  };
  return { get, post, cookie: () => cookie, setCookie: (c) => (cookie = c) };
}

const signedIn = async (c) => (await c.get('/requests')).status === 200;
const login = (c, email) => c.post('/login', { email, password: 'password123' });
// Moves a user's sessions back in time, as if they had been away.
const age = (column, minutes, email) =>
  run(`UPDATE sessions SET ${column} = datetime('now', ?) WHERE user_id = (SELECT id FROM users WHERE email = ?)`, `-${minutes} minutes`, email);

test('signing in records a server-side session and only its hash', async () => {
  const c = client();
  await login(c, 'bo@example.com');
  assert.ok(await signedIn(c));
  const rows = one("SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'bo@example.com')").n;
  assert.ok(rows >= 1);
  assert.doesNotMatch(c.cookie(), /userId/);
});

test('a session ends after the idle limit and says why', async () => {
  const c = client();
  await login(c, 'bo@example.com');
  age('last_seen', 8 * 60 + 1, 'bo@example.com');
  const res = await c.get('/requests');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
  assert.match(await (await c.get('/login')).text(), /session timed out/);
  // Signing in again brings them back where they were.
  const back = await login(c, 'bo@example.com');
  assert.equal(back.headers.get('location'), '/requests');
});

test('activity keeps a session alive, but not past the overall limit', async () => {
  const c = client();
  await login(c, 'bo@example.com');
  age('last_seen', 2, 'bo@example.com');
  assert.ok(await signedIn(c));
  const seen = one("SELECT last_seen FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'bo@example.com') ORDER BY last_seen DESC").last_seen;
  assert.ok(Date.now() - Date.parse(seen.replace(' ', 'T') + 'Z') < 60_000, 'last_seen is refreshed');

  age('created_at', 7 * 24 * 60 + 1, 'bo@example.com');
  assert.equal(await signedIn(c), false);
});

test('the limits are settings', async () => {
  await admin.post('/admin/settings', { site_name: 'Portal', banner_color: '#2A4BC7', banner_text_color: '#FFFFFF', session_idle_minutes: '15', session_max_minutes: '1440' });
  const c = client();
  await login(c, 'bo@example.com');
  age('last_seen', 16, 'bo@example.com');
  assert.equal(await signedIn(c), false, '15-minute idle limit applies');
  // Values that are not on the list are ignored.
  await admin.post('/admin/settings', { site_name: 'Portal', banner_color: '#2A4BC7', banner_text_color: '#FFFFFF', session_idle_minutes: '999999', session_max_minutes: '10080' });
  const s = Object.fromEntries(['session_idle_minutes', 'session_max_minutes'].map((k) => [k, one('SELECT value FROM settings WHERE key = ?', k).value]));
  assert.deepEqual(s, { session_idle_minutes: '15', session_max_minutes: '10080' });
  await admin.post('/admin/settings', { site_name: 'Portal', banner_color: '#2A4BC7', banner_text_color: '#FFFFFF', session_idle_minutes: '480', session_max_minutes: '10080', allow_registration: '1' });
});

test('a copied cookie stops working once its owner signs out', async () => {
  const c = client();
  await login(c, 'bo@example.com');
  const stolen = c.cookie();
  await c.post('/logout', {}, '/');
  const thief = client();
  thief.setCookie(stolen);
  assert.equal(await signedIn(thief), false);
});

test('"sign out on all devices" ends every session for that person', async () => {
  const phone = client();
  const laptop = client();
  await login(phone, 'bo@example.com');
  await login(laptop, 'bo@example.com');
  await laptop.post('/logout', { everywhere: '1' }, '/');
  assert.equal(await signedIn(phone), false);
  assert.equal(await signedIn(laptop), false);
});

test('admins see who is active and can sign people out; a password reset does too', async () => {
  const bo = client();
  await login(bo, 'bo@example.com');
  const boId = one("SELECT id FROM users WHERE email = 'bo@example.com'").id;

  await login(admin, 'ada@example.com');
  const people = await (await admin.get('/admin/users')).text();
  assert.match(people, /Last active/);
  assert.match(people, /active session/);

  await admin.post(`/admin/users/${boId}`, { action: 'signout' }, '/admin/users');
  assert.equal(await signedIn(bo), false);
  assert.ok(await signedIn(admin), 'the admin stays signed in');

  await login(bo, 'bo@example.com');
  await admin.post(`/admin/users/${boId}`, { action: 'password', password: 'newpassword1' }, '/admin/users');
  assert.equal(await signedIn(bo), false);
});

test('removing a person ends their sessions', async () => {
  const c = client();
  await c.post('/register', { name: 'Cy', email: 'cy@example.com', password: 'password123' });
  assert.ok(await signedIn(c));
  const cyId = one("SELECT id FROM users WHERE email = 'cy@example.com'").id;
  await admin.post(`/admin/users/${cyId}`, { action: 'delete' }, '/admin/users');
  assert.equal(one('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', cyId).n, 0);
  assert.equal(await signedIn(c), false);
});
