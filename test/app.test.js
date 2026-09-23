import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Each run gets a throwaway data directory so tests never touch real data.
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aperturekit-test-'));
const { createApp } = await import('../src/app.js');

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

// Minimal cookie jar + CSRF helper around fetch.
function client() {
  let cookie = '';
  const get = async (p) => {
    const res = await fetch(base + p, { headers: { cookie }, redirect: 'manual' });
    if (res.headers.get('set-cookie')) cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = async (p, body) => {
    const page = await get(p.replace(/\/(comments|status)$/, ''));
    const html = await page.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, ...body }).toString(),
      redirect: 'manual',
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  return { get, post, cookie: () => cookie };
}

test('first visit redirects to setup, setup creates the admin', async () => {
  const c = client();
  const home = await c.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/setup');
  const res = await c.post('/setup', { name: 'Ada', email: 'ada@example.com', password: 'password123' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/settings');
  const after = await c.get('/setup');
  assert.equal(after.headers.get('location'), '/');
});

test('admin can rename the portal and it shows on the home page', async () => {
  const c = client();
  await c.post('/login', { email: 'ada@example.com', password: 'password123' });
  await c.post('/admin/settings', { site_name: 'Acme Desk', tagline: 'Hi', banner_color: '#123456', banner_text_color: '#FFFFFF', allow_registration: '1' });
  const html = await (await c.get('/')).text();
  assert.match(html, /<title>Acme Desk<\/title>/);
  assert.match(html, /--banner:#123456/);
});

test('editor builds a category and form; member submits and cannot edit', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  await admin.post('/editor/categories', { name: 'IT', description: 'Computers', color: '#00AA00' });
  const created = await admin.post('/editor/forms', {
    title: 'New laptop',
    category_id: '2',
    fields: JSON.stringify([{ id: 'why', type: 'textarea', label: 'Why?', required: true }]),
    published: '1',
  });
  assert.equal(created.status, 302);

  const member = client();
  await member.post('/register', { name: 'Mo', email: 'mo@example.com', password: 'password123' });
  assert.equal((await member.get('/editor')).status, 403);

  const bad = await member.post('/f/new-laptop', { why: '' });
  assert.equal(bad.status, 400);
  const ok = await member.post('/f/new-laptop', { why: 'Mine died.' });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('location'), /^\/requests\/\d+\?submitted=1$/);

  const id = ok.headers.get('location').match(/\d+/)[0];
  assert.equal((await member.post(`/requests/${id}/status`, { status: 'done' })).status, 403);
  assert.equal((await admin.post(`/requests/${id}/status`, { status: 'done' })).status, 302);
  const view = await (await member.get(`/requests/${id}`)).text();
  assert.match(view, /status-done/);
});

// Every setting below is posted the way the Settings page posts it. `saveSettings`
// fills in the required fields so a test only names what it is changing.
async function saveSettings(c, patch) {
  const res = await c.post('/admin/settings', { site_name: 'Acme Desk', allow_registration: '1', show_credit: '1', comments: 'all', ...patch });
  assert.equal(res.status, 302, 'settings should save');
}

test('admin controls sign-up: email domains and starting role', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  await saveSettings(admin, { registration_domains: '@Corp.example, junk', default_role: 'editor' });

  const settingsPage = await (await admin.get('/admin/settings')).text();
  assert.match(settingsPage, /name="registration_domains" value="corp.example"/);

  const outsider = client();
  const refused = await outsider.post('/register', { name: 'Out', email: 'out@elsewhere.example', password: 'password123' });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /ending in @corp\.example/);

  const insider = client();
  const ok = await insider.post('/register', { name: 'Ina', email: 'ina@corp.example', password: 'password123' });
  assert.equal(ok.status, 302);
  assert.equal((await insider.get('/editor')).status, 200, 'default role editor should open the builder');

  await saveSettings(admin, { registration_domains: '', default_role: 'member' });
});

test('admin can make the portal private', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  await saveSettings(admin, { require_login: '1' });

  const anon = client();
  const home = await anon.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');
  assert.equal((await anon.get('/f/new-laptop')).status, 302);
  assert.equal((await anon.get('/login')).status, 200, 'sign-in stays reachable');
  assert.equal((await admin.get('/')).status, 200, 'signed-in users still see the forms');

  await saveSettings(admin, { require_login: '0' });
  assert.equal((await anon.get('/')).status, 200);
});

test('webhook posts signed JSON to n8n-style endpoint on submit, status, and note', async () => {
  // A tiny receiver standing in for n8n's Webhook node.
  const received = [];
  let waiter;
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('ok');
      waiter?.();
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => hook.once('listening', r));
  const nextEvent = () => new Promise((r) => { waiter = r; });
  const hookUrl = `http://127.0.0.1:${hook.address().port}/webhook/portal`;

  try {
    const admin = client();
    await admin.post('/login', { email: 'ada@example.com', password: 'password123' });

    const bad = await admin.post('/admin/settings', { site_name: 'Acme Desk', webhook_url: 'n8n.example.com/hook' });
    assert.equal(bad.status, 302);
    assert.doesNotMatch(await (await admin.get('/admin/settings')).text(), /value="n8n\.example\.com\/hook"/, 'a bare host is not saved');

    const testEvent = nextEvent();
    await saveSettings(admin, {
      webhook_url: hookUrl, webhook_secret: 'shh', ticket_prefix: 'REQ-',
      webhook_on_submit: '1', webhook_on_status: '1', webhook_on_comment: '1', action: 'webhook_test',
    });
    await testEvent;
    assert.match(await (await admin.get('/admin/settings')).text(), /test event was delivered/);
    assert.equal(JSON.parse(received[0].body).event, 'webhook.test');

    const member = client();
    await member.post('/login', { email: 'mo@example.com', password: 'password123' });
    const submitted = nextEvent();
    const res = await member.post('/f/new-laptop', { why: 'Screen cracked.' });
    const id = Number(res.headers.get('location').match(/\d+/)[0]);
    await submitted;

    const { headers, body } = received[1];
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['x-aperturekit-event'], 'request.submitted');
    assert.equal(headers['x-webhook-secret'], 'shh');
    assert.equal(headers['x-webhook-signature'], 'sha256=' + crypto.createHmac('sha256', 'shh').update(body).digest('hex'));
    const payload = JSON.parse(body);
    assert.equal(payload.event, 'request.submitted');
    assert.equal(payload.request.id, id);
    assert.equal(payload.request.ticket, `REQ-${String(id).padStart(4, '0')}`);
    assert.equal(payload.request.url, `${base}/requests/${id}`);
    assert.equal(payload.request.status, 'new');
    assert.equal(payload.request.form.title, 'New laptop');
    assert.equal(payload.request.requester.email, 'mo@example.com');
    assert.deepEqual(payload.request.answers, [{ id: 'why', label: 'Why?', type: 'textarea', value: 'Screen cracked.' }]);
    assert.equal(payload.request.answers_by_id.why, 'Screen cracked.');

    const status = nextEvent();
    await admin.post(`/requests/${id}/status`, { status: 'in_progress' });
    await status;
    const changed = JSON.parse(received[2].body);
    assert.equal(changed.event, 'request.status_changed');
    assert.equal(changed.previous_status, 'new');
    assert.equal(changed.request.status, 'in_progress');
    assert.equal(changed.changed_by.email, 'ada@example.com');

    const note = nextEvent();
    await member.post(`/requests/${id}/comments`, { body: 'Any update?' });
    await note;
    const commented = JSON.parse(received[3].body);
    assert.equal(commented.event, 'comment.added');
    assert.equal(commented.comment.body, 'Any update?');
    assert.equal(commented.comment.author.email, 'mo@example.com');

    // A form with a file: the payload links to it with a signed token that works without an account.
    await admin.post('/editor/forms', {
      title: 'Expense claim',
      category_id: '2',
      fields: JSON.stringify([{ id: 'receipt', type: 'file', label: 'Receipt', required: true }]),
      published: '1',
    });
    const page = await (await member.get('/f/expense-claim')).text();
    const fd = new FormData();
    fd.set('_csrf', page.match(/name="_csrf" value="([^"]+)"/)[1]);
    fd.set('receipt', new Blob(['taxi 12.50'], { type: 'text/plain' }), 'taxi.txt');
    const withFile = nextEvent();
    const up = await fetch(base + '/f/expense-claim', { method: 'POST', headers: { cookie: member.cookie() }, body: fd, redirect: 'manual' });
    assert.equal(up.status, 302);
    await withFile;
    const [att] = JSON.parse(received[4].body).request.attachments;
    assert.equal(att.name, 'taxi.txt');
    assert.match(att.url, new RegExp(`^${base}/requests/\\d+/files/\\d+\\?token=\\d+\\.[0-9a-f]{64}$`));

    const anon = client();
    const dl = await anon.get(att.url.slice(base.length));
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'taxi 12.50');
    assert.match(dl.headers.get('content-disposition'), /taxi\.txt/);
    assert.equal((await anon.get(att.url.slice(base.length).replace(/token=\d+/, 'token=1'))).status, 403, 'expired');
    assert.equal((await anon.get(att.url.slice(base.length).replace(/[0-9a-f]{4}$/, '0000'))).status, 403, 'tampered');
    assert.equal((await anon.get(att.url.slice(base.length).split('?')[0])).status, 302, 'no token still needs sign-in');

    // Signed links also pass the private-portal gate.
    await saveSettings(admin, { webhook_url: hookUrl, require_login: '1' });
    assert.equal((await anon.get(att.url.slice(base.length))).status, 200);
    await saveSettings(admin, { webhook_url: hookUrl, require_login: '0', webhook_on_submit: '1', webhook_on_status: '1', webhook_on_comment: '1' });
    received.length = 4;

    // Switching an event off stops just that event; a blank address stops all of them.
    await saveSettings(admin, { webhook_url: hookUrl, webhook_on_submit: '1', webhook_on_status: '0' });
    await admin.post(`/requests/${id}/status`, { status: 'done' });
    await saveSettings(admin, { webhook_url: '' });
    await member.post('/f/new-laptop', { why: 'Again.' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 4);
  } finally {
    hook.close();
  }
});

test('admin controls notes, ticket prefix, upload limit, and footer credit', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  const member = client();
  await member.post('/login', { email: 'mo@example.com', password: 'password123' });
  const id = (await member.post('/f/new-laptop', { why: 'Testing settings.' })).headers.get('location').match(/\d+/)[0];

  await saveSettings(admin, { comments: 'staff', ticket_prefix: 'REQ-', max_upload_mb: '3', show_credit: '0', login_text: 'Use your work email.' });
  const memberView = await (await member.get(`/requests/${id}`)).text();
  assert.doesNotMatch(memberView, /name="body"/, 'member should not get the note form');
  assert.match(memberView, /Only editors can add notes/);
  assert.match(memberView, new RegExp(`REQ-${String(id).padStart(4, '0')}`));
  assert.doesNotMatch(memberView, /runs on <a href="https:\/\/github.com\/Ruben-C\/ApertureKit"/);
  assert.equal((await member.post(`/requests/${id}/comments`, { body: 'hello' })).status, 403);
  assert.equal((await admin.post(`/requests/${id}/comments`, { body: 'hello' })).status, 302);
  assert.match(await (await client().get('/login')).text(), /Use your work email\./);
  assert.match(await (await admin.get('/admin/settings')).text(), /name="max_upload_mb" value="3"/);

  await saveSettings(admin, { comments: 'off' });
  assert.equal((await admin.post(`/requests/${id}/comments`, { body: 'nope' })).status, 403);

  // Out-of-range values keep the previous setting rather than breaking anything.
  await saveSettings(admin, { max_upload_mb: '99999', ticket_prefix: '' });
  const page = await (await admin.get('/admin/settings')).text();
  assert.match(page, /name="max_upload_mb" value="3"/);
  assert.match(page, /name="ticket_prefix" value=""/);

  const reset = await admin.post('/admin/settings', { action: 'reset' });
  assert.equal(reset.status, 302);
  const fresh = await (await admin.get('/admin/settings')).text();
  assert.match(fresh, /name="ticket_prefix" value="#"/);
  assert.match(fresh, /name="show_credit" value="1" checked/);
});

test('requests to a form without a CSRF token are refused', async () => {
  const c = client();
  await c.post('/login', { email: 'mo@example.com', password: 'password123' });
  const res = await fetch(base + '/f/new-laptop', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'why=x',
    redirect: 'manual',
  });
  assert.ok([302, 403].includes(res.status));
});
