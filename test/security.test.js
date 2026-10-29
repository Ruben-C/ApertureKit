import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regression tests for reported vulnerabilities, each against its own
// throwaway data directory.
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aperturekit-security-test-'));
const { createApp } = await import('../src/app.js');
const { one, run } = await import('../src/db.js');
const { ATTACHMENTS_DIR } = await import('../src/uploads.js');

let server;
let base;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
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
  const token = async (p) => (await (await get(p)).text()).match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
  const post = async (p, body, csrfFrom = p) => {
    const csrf = await token(csrfFrom);
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, ...body }).toString(),
      redirect: 'manual',
    });
    remember(res);
    return res;
  };
  const upload = async (p, fd) => {
    const res = await fetch(base + p, { method: 'POST', headers: { cookie }, body: fd, redirect: 'manual' });
    remember(res);
    return res;
  };
  return { get, post, upload, token };
}

const storedFiles = () => fs.readdirSync(ATTACHMENTS_DIR);
const settle = () => new Promise((r) => setTimeout(r, 100));

test('setup cannot be reused to add an administrator, whatever the case of the path', async () => {
  await client().post('/setup', { name: 'Ada', email: 'ada@example.com', password: 'password123' });
  for (const p of ['/SETUP', '/Setup', '/setup/', '/setup']) {
    const res = await client().post(p, { name: 'Eve', email: 'eve@example.com', password: 'password123' }, '/login');
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get('location'), '/', p);
  }
  assert.equal(one('SELECT COUNT(*) AS n FROM users').n, 1);
  assert.equal(one('SELECT 1 FROM users WHERE email = ?', 'eve@example.com'), undefined);
});

test('signing in only ever returns to a path on this site', async () => {
  run("INSERT INTO settings (key, value) VALUES ('require_login', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  try {
    for (const evil of ['//evil.example/', '/\\evil.example']) {
      const c = client();
      await c.get(evil);
      const res = await c.post('/login', { email: 'ada@example.com', password: 'password123' });
      assert.equal(res.status, 302, evil);
      assert.equal(res.headers.get('location'), '/', evil);
    }
    const c = client();
    await c.get('/requests');
    const res = await c.post('/login', { email: 'ada@example.com', password: 'password123' });
    assert.equal(res.headers.get('location'), '/requests', 'a real path is still honoured');
  } finally {
    run("DELETE FROM settings WHERE key = 'require_login'");
  }
});

test('uploads that are not kept are removed, and deleting a form removes its files', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  await admin.post('/editor/forms', {
    title: 'Receipts',
    category_id: '1',
    fields: JSON.stringify([
      { id: 'what', type: 'text', label: 'What for?', required: true },
      { id: 'receipt', type: 'file', label: 'Receipt', required: false },
    ]),
    published: '1',
  });
  const form = one("SELECT id FROM forms WHERE slug = 'receipts'");
  const send = async (fields, csrf) => {
    const fd = new FormData();
    fd.set('_csrf', csrf ?? await admin.token('/f/receipts'));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res = await admin.upload('/f/receipts', fd);
    await settle();
    return res;
  };
  const file = () => new Blob(['12.50'], { type: 'text/plain' });

  // A failed submission, a bad CSRF token, and a made-up field name keep nothing.
  assert.equal((await send({ receipt: file(), what: '' })).status, 400);
  assert.equal((await send({ receipt: file(), what: 'Taxi' }, 'wrong')).status, 403);
  assert.deepEqual(storedFiles(), []);
  assert.equal((await send({ receipt: file(), extra: file(), what: 'Taxi' })).status, 302);
  assert.equal(storedFiles().length, 1, 'only the real attachment stays');

  // Numbers must be finite and short.
  run(`UPDATE forms SET fields = ? WHERE id = ?`, JSON.stringify([{ id: 'n', type: 'number', label: 'How many?', required: true }]), form.id);
  assert.equal((await send({ n: 'Infinity' })).status, 400);
  run(`UPDATE forms SET fields = ? WHERE id = ?`, JSON.stringify([{ id: 'what', type: 'text', label: 'What for?', required: true }, { id: 'receipt', type: 'file', label: 'Receipt' }]), form.id);

  await admin.post(`/editor/forms/${form.id}`, { action: 'delete' }, `/editor/forms/${form.id}`);
  await settle();
  assert.equal(one('SELECT 1 FROM forms WHERE id = ?', form.id), undefined);
  assert.deepEqual(storedFiles(), []);
});
