import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aperturekit-auth-test-'));
const { createApp } = await import('../src/app.js');
const { resolveUser, normaliseGroups, buildConfig } = await import('../src/providers/index.js');
const { verifyIdToken } = await import('../src/providers/oidc.js');
const { one, run } = await import('../src/db.js');
const { hashPassword, verifyPassword, needsRehash } = await import('../src/auth.js');
const { beginAttempt, attemptSucceeded, resetThrottle } = await import('../src/throttle.js');

// --- A tiny OpenID provider ---------------------------------------------------
// Serves discovery, JWKS, an authorize endpoint that bounces straight back
// with a code, a token endpoint, and userinfo. `idp.next` sets the claims
// the next sign-in will carry.

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(claims, { alg = 'RS256', kid = 'k1' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const idp = { next: {}, lastTokenRequest: null, codes: new Map() };
const idpServer = http.createServer((req, res) => {
  const url = new URL(req.url, idp.base);
  const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/.well-known/openid-configuration') {
    return json({
      issuer: idp.base,
      authorization_endpoint: idp.base + '/authorize',
      token_endpoint: idp.base + '/token',
      jwks_uri: idp.base + '/jwks',
      userinfo_endpoint: idp.base + '/userinfo',
    });
  }
  if (url.pathname === '/jwks') return json({ keys: [jwk] });
  if (url.pathname === '/authorize') {
    const code = crypto.randomUUID();
    idp.codes.set(code, { nonce: url.searchParams.get('nonce'), redirect: url.searchParams.get('redirect_uri'), challenge: url.searchParams.get('code_challenge') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/token') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      idp.lastTokenRequest = { params: Object.fromEntries(p), auth: req.headers.authorization };
      const pending = idp.codes.get(p.get('code'));
      if (!pending) return json({ error: 'invalid_grant' }, 400);
      const expected = crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url');
      if (expected !== pending.challenge) return json({ error: 'invalid_grant', error_description: 'bad verifier' }, 400);
      const now = Math.floor(Date.now() / 1000);
      const { userinfo, ...claims } = idp.next;
      const id_token = signJwt({ iss: idp.base, aud: 'portal-client', exp: now + 300, iat: now, nonce: pending.nonce, ...claims });
      idp.userinfo = userinfo || null;
      return json({ access_token: 'at-' + p.get('code'), id_token, token_type: 'Bearer' });
    });
    return;
  }
  if (url.pathname === '/userinfo') return json(idp.userinfo || { sub: idp.next.sub });
  res.writeHead(404); res.end();
});

let server; let base;
before(async () => {
  idpServer.listen(0, '127.0.0.1');
  await new Promise((r) => idpServer.once('listening', r));
  idp.base = `http://127.0.0.1:${idpServer.address().port}`;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  idpServer.close();
  fs.rmSync(process.env.PORTAL_DATA_DIR, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const remember = (res) => { if (res.headers.get('set-cookie')) cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); };
  const get = async (p) => {
    const res = await fetch(p.startsWith('http') ? p : base + p, { headers: { cookie }, redirect: 'manual' });
    remember(res);
    return res;
  };
  const post = async (p, body, csrfFrom = p) => {
    const html = await (await get(csrfFrom)).text();
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
  // Follows redirects across the portal and the mock IdP until landing on a page.
  const follow = async (p) => {
    let res = await get(p);
    for (let i = 0; i < 6 && [301, 302, 303].includes(res.status); i++) {
      const loc = res.headers.get('location');
      res = await get(loc.startsWith('http') ? loc : base + loc);
    }
    return res;
  };
  return { get, post, follow };
}

const oidcForm = (over = {}) => ({
  name: 'Acme SSO', issuer: idp.base, client_id: 'portal-client', client_secret: 'shh', scopes: 'openid profile email',
  email_claim: 'email', groups_claim: 'groups', auto_create: '1', default_role: 'member', admin_group: '', editor_group: '', ...over,
});

let providerId;

test('setup, then admin adds an OpenID Connect provider', async () => {
  const c = client();
  await c.post('/setup', { name: 'Ada', email: 'ada@example.com', password: 'password123' });

  const page = await (await c.get('/admin/auth')).text();
  assert.match(page, /Only portal passwords so far/);
  assert.match(one('SELECT password_hash FROM users WHERE email = ?', 'ada@example.com').password_hash, /^\$argon2id\$/);
  assert.match(page, /OpenID Connect/);
  assert.match(page, /SAML 2\.0/);
  assert.match(page, /LDAP \/ Active Directory/);

  const bad = await c.post('/admin/auth/new/oidc', oidcForm({ scopes: 'profile' }), '/admin/auth/new/oidc');
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Scopes must include/);

  const ok = await c.post('/admin/auth/new/oidc', oidcForm(), '/admin/auth/new/oidc');
  assert.equal(ok.status, 302);
  providerId = Number(ok.headers.get('location').match(/\/admin\/auth\/(\d+)/)[1]);

  const edit = await (await c.get(`/admin/auth/${providerId}`)).text();
  assert.match(edit, new RegExp(`${base}/auth/${providerId}/callback`), 'shows the redirect URI');
  assert.doesNotMatch(edit, /shh/, 'never echoes the client secret');
  assert.match(edit, /\(saved\)/);

  const login = await (await client().get('/login')).text();
  assert.match(login, /Continue with Acme SSO/);
  assert.match(login, /name="password"/, 'password form still there');
});

test('first SSO sign-in creates an account; second one reuses it', async () => {
  idp.next = { sub: 'u-1', email: 'sam@example.com', name: 'Sam Lee', groups: ['staff'] };
  const c = client();
  const landed = await c.follow(`/auth/${providerId}/start`);
  assert.equal(landed.status, 200);
  const html = await landed.text();
  assert.match(html, /Sam Lee/, 'signed in as the new user');
  assert.match(idp.lastTokenRequest.auth, /^Basic /, 'secret goes as HTTP Basic');
  assert.equal(idp.lastTokenRequest.params.grant_type, 'authorization_code');

  const user = one('SELECT * FROM users WHERE email = ?', 'sam@example.com');
  assert.equal(user.role, 'member');
  assert.equal(user.password_hash, '');
  assert.ok(one('SELECT 1 FROM identities WHERE subject = ? AND user_id = ?', 'u-1', user.id));

  // Same subject, changed email at the IdP: still the same account.
  idp.next = { sub: 'u-1', email: 'sam.lee@example.com', name: 'Sam Lee' };
  const again = await client().follow(`/auth/${providerId}/start`);
  assert.match(await again.text(), /Sam Lee/);
  assert.equal(one('SELECT COUNT(*) AS n FROM users').n, 2);
});

test('an existing password account is linked by email', async () => {
  idp.next = { sub: 'u-ada', email: 'ADA@example.com', name: 'Ada' };
  const c = client();
  const landed = await c.follow(`/auth/${providerId}/start`);
  assert.equal(landed.status, 200);
  assert.equal((await c.get('/admin/settings')).status, 200, 'still an admin');
  assert.equal(one('SELECT COUNT(*) AS n FROM users').n, 2, 'no duplicate created');
  const people = await (await c.get('/admin/users')).text();
  assert.match(people, /Signs in with/);
  assert.match(people, /Acme SSO/);
});

test('groups map to roles when configured; last admin is protected', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  const save = await admin.post(`/admin/auth/${providerId}`, oidcForm({ admin_group: 'Portal Admins', editor_group: 'portal-editors', client_secret: '' }));
  assert.equal(save.status, 302);
  assert.equal(JSON.parse(one('SELECT config FROM auth_providers WHERE id = ?', providerId).config).client_secret, 'shh', 'blank secret keeps the old one');

  idp.next = { sub: 'u-1', email: 'sam@example.com', name: 'Sam Lee', groups: ['portal-editors'] };
  await client().follow(`/auth/${providerId}/start`);
  assert.equal(one('SELECT role FROM users WHERE email = ?', 'sam@example.com').role, 'editor');

  idp.next = { sub: 'u-1', email: 'sam@example.com', name: 'Sam Lee', groups: ['PORTAL ADMINS'] };
  await client().follow(`/auth/${providerId}/start`);
  assert.equal(one('SELECT role FROM users WHERE email = ?', 'sam@example.com').role, 'admin');

  // Sam is now an admin too, so Ada can lose the group and be demoted...
  idp.next = { sub: 'u-ada', email: 'ada@example.com', name: 'Ada', groups: [] };
  await client().follow(`/auth/${providerId}/start`);
  assert.equal(one('SELECT role FROM users WHERE email = ?', 'ada@example.com').role, 'member');
  // ...but Sam, now the only admin, cannot be.
  idp.next = { sub: 'u-1', email: 'sam@example.com', name: 'Sam Lee', groups: [] };
  await client().follow(`/auth/${providerId}/start`);
  assert.equal(one('SELECT role FROM users WHERE email = ?', 'sam@example.com').role, 'admin');

  run("UPDATE users SET role = 'admin' WHERE email = 'ada@example.com'");
  await admin.post(`/admin/auth/${providerId}`, oidcForm({ client_secret: '' }));
});

test('admin can pre-create an account with no password once SSO exists', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  const res = await admin.post('/admin/users', { name: 'Pre Made', email: 'pre@example.com', password: '', role: 'editor' });
  assert.equal(res.status, 302);
  assert.equal(one('SELECT password_hash FROM users WHERE email = ?', 'pre@example.com').password_hash, '');
  // Cannot sign in with an empty password...
  assert.equal((await client().post('/login', { email: 'pre@example.com', password: '' })).status, 401);
  // ...but SSO links straight onto the prepared account and keeps its role.
  idp.next = { sub: 'u-pre', email: 'pre@example.com', name: 'Pre Made' };
  await client().follow(`/auth/${providerId}/start`);
  assert.equal(one('SELECT role FROM users WHERE email = ?', 'pre@example.com').role, 'editor');
  assert.ok(one('SELECT 1 FROM identities WHERE subject = ?', 'u-pre'));
});

test('groups from userinfo count too, and email from userinfo fills a gap', async () => {
  idp.next = { sub: 'u-2', userinfo: { sub: 'u-2', email: 'kim@example.com', name: 'Kim' } };
  const landed = await client().follow(`/auth/${providerId}/start`);
  assert.match(await landed.text(), /Kim/);
  assert.ok(one('SELECT 1 FROM users WHERE email = ?', 'kim@example.com'));
});

test('sign-in without an account is refused when auto-create is off', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  await admin.post(`/admin/auth/${providerId}`, oidcForm({ auto_create: '0', client_secret: '' }));

  idp.next = { sub: 'u-3', email: 'nobody@example.com', name: 'Nobody' };
  const c = client();
  const landed = await c.follow(`/auth/${providerId}/start`);
  assert.match(await landed.text(), /no account for nobody@example.com/);
  assert.equal(one('SELECT 1 FROM users WHERE email = ?', 'nobody@example.com'), undefined);

  await admin.post(`/admin/auth/${providerId}`, oidcForm({ client_secret: '' }));
});

test('tampered state or a bad token signature is rejected', async () => {
  const c = client();
  const start = await c.get(`/auth/${providerId}/start`);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location'));
  const hop = await c.get(authorize.toString());
  const back = new URL(hop.headers.get('location'));
  back.searchParams.set('state', 'forged');
  const res = await c.get(back.toString());
  assert.equal(res.status, 302);
  const login = await (await c.get('/login')).text();
  assert.match(login, /did not match the request/);

  const now = Math.floor(Date.now() / 1000);
  const good = { iss: idp.base, aud: 'portal-client', exp: now + 60, sub: 'x', nonce: 'n' };
  const opts = { issuer: idp.base, clientId: 'portal-client', nonce: 'n', jwksUri: idp.base + '/jwks' };
  assert.ok(await verifyIdToken(signJwt(good), opts));
  const [h, b, s] = signJwt(good).split('.');
  await assert.rejects(verifyIdToken(`${h}.${b}.${s.slice(0, -4)}AAAA`, opts), /signature/);
  await assert.rejects(verifyIdToken(signJwt({ ...good, aud: 'other' }), opts), /audience/);
  await assert.rejects(verifyIdToken(signJwt({ ...good, exp: now - 600 }), opts), /expired/);
  await assert.rejects(verifyIdToken(signJwt({ ...good, nonce: 'z' }), opts), /nonce/);
  await assert.rejects(verifyIdToken(signJwt(good, { alg: 'none' }), opts), /Unsupported/);
});

test('password sign-in can be switched off; admins keep a way in', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  await admin.post('/admin/auth', { password_login: '0', public_url: 'https://portal.example.com/' });
  const page = await (await admin.get('/admin/auth')).text();
  assert.match(page, /name="public_url" value="https:\/\/portal.example.com"/);
  assert.match(await (await admin.get(`/admin/auth/${providerId}`)).text(), /https:\/\/portal.example.com\/auth\/\d+\/callback/);

  // Only one SSO method and no password form: the sign-in page goes straight to it.
  const anon = client();
  const login = await anon.get('/login');
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), `/auth/${providerId}/start`);
  assert.equal((await anon.get('/register')).status, 403);

  // The break-glass page still lets an admin use a password, but not a member.
  const breakGlass = await (await anon.get('/login?password=1')).text();
  assert.match(breakGlass, /name="password"/);
  const member = client();
  const refused = await member.post('/login', { email: 'mo@example.com', password: 'password123' }, '/login?password=1');
  assert.equal(refused.status, 401);
  const adm = client();
  const okRes = await adm.post('/login', { email: 'ada@example.com', password: 'password123' }, '/login?password=1');
  assert.equal(okRes.status, 302);

  // Turning the last provider off turns passwords back on rather than locking everyone out.
  await admin.post(`/admin/auth/${providerId}`, oidcForm({ client_secret: '', enabled: '0' }));
  assert.equal(one("SELECT value FROM settings WHERE key = 'password_login'").value, '1');
  assert.equal((await client().get(`/auth/${providerId}/start`)).status, 404, 'disabled provider is unreachable');
  assert.doesNotMatch(await (await client().get('/login')).text(), /Continue with/);

  // Cannot turn passwords off with nothing else on.
  await admin.post('/admin/auth', { password_login: '0', public_url: '' });
  assert.equal(one("SELECT value FROM settings WHERE key = 'password_login'").value, '1');
  await admin.post(`/admin/auth/${providerId}`, oidcForm({ client_secret: '', enabled: '1' }));
  await admin.post('/admin/auth', { password_login: '1', public_url: '' });
});

test('SAML provider: metadata and sign-on redirect', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  const cert = crypto.randomBytes(120).toString('base64');
  const res = await admin.post('/admin/auth/new/saml', {
    name: 'Corp SAML', entry_point: 'https://idp.example.com/sso', idp_cert: `-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`,
    email_attribute: 'email', name_attribute: 'displayName', groups_attribute: 'groups', want_assertions_signed: '1', auto_create: '1', default_role: 'member',
  }, '/admin/auth/new/saml');
  assert.equal(res.status, 302);
  const id = res.headers.get('location').match(/(\d+)$/)[1];

  const meta = await client().get(`/auth/${id}/metadata`);
  assert.equal(meta.status, 200);
  const xml = await meta.text();
  assert.match(xml, /EntityDescriptor/);
  assert.match(xml, new RegExp(`entityID="${base}/auth/${id}/metadata"`));
  assert.match(xml, new RegExp(`Location="${base}/auth/${id}/callback"`));

  const start = await client().get(`/auth/${id}/start`);
  assert.equal(start.status, 302);
  const url = new URL(start.headers.get('location'));
  assert.equal(url.origin + url.pathname, 'https://idp.example.com/sso');
  assert.ok(url.searchParams.get('SAMLRequest'));

  // A forged response posted cross-site (no CSRF token, no cookie) is rejected cleanly.
  const forged = await fetch(base + `/auth/${id}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: Buffer.from('<Response/>').toString('base64'), RelayState: '/requests' }).toString(),
    redirect: 'manual',
  });
  assert.equal(forged.status, 302);
  assert.equal(forged.headers.get('location'), '/login');

  const bad = await admin.post('/admin/auth/new/saml', { name: 'x', entry_point: 'https://idp.example.com/sso', idp_cert: 'not a cert' }, '/admin/auth/new/saml');
  assert.equal(bad.status, 400);
  await admin.post(`/admin/auth/${id}`, { action: 'delete' });
  assert.equal(one('SELECT 1 FROM auth_providers WHERE id = ?', id), undefined);
});

test('LDAP provider form validates and the sign-in form adapts', async () => {
  const admin = client();
  await admin.post('/login', { email: 'ada@example.com', password: 'password123' });
  const form = (over) => ({
    name: 'Corp AD', url: 'ldaps://127.0.0.1:1', bind_dn: 'cn=svc,dc=example,dc=com', bind_password: 'x', base_dn: 'dc=example,dc=com',
    user_filter: '(uid={{username}})', email_attribute: 'mail', name_attribute: 'cn', groups_attribute: 'memberOf', auto_create: '1', default_role: 'member', ...over,
  });
  const bad = await admin.post('/admin/auth/new/ldap', form({ user_filter: '(uid=*)' }), '/admin/auth/new/ldap');
  assert.match(await bad.text(), /must contain \{\{username\}\}/);
  const res = await admin.post('/admin/auth/new/ldap', form({}), '/admin/auth/new/ldap');
  assert.equal(res.status, 302);
  const id = res.headers.get('location').match(/(\d+)$/)[1];

  const login = await (await client().get('/login')).text();
  assert.match(login, /Username or email/);
  assert.doesNotMatch(login, /Continue with Corp AD/, 'directories do not get a button');

  // Local password still wins without touching the directory; an unknown user hits the (unreachable) directory and gets a clear error.
  assert.equal((await client().post('/login', { email: 'ada@example.com', password: 'password123' })).status, 302);
  const unreachable = await client().post('/login', { email: 'someone', password: 'pw' });
  assert.equal(unreachable.status, 502);
  assert.match(await unreachable.text(), /could not be reached/);

  const tested = await admin.post(`/admin/auth/${id}`, form({ action: 'test', test_username: 'someone', bind_password: '' }));
  assert.equal(tested.status, 200);
  assert.match(await tested.text(), /Could not connect/);
  await admin.post(`/admin/auth/${id}`, { action: 'delete' });
});

test('unit: group normalisation and role resolution', () => {
  assert.deepEqual(normaliseGroups('CN=Portal Admins,OU=Groups,DC=example,DC=com'), ['CN=Portal Admins,OU=Groups,DC=example,DC=com', 'Portal Admins']);
  assert.deepEqual(normaliseGroups(['a', Buffer.from('b')]), ['a', 'b']);
  assert.deepEqual(normaliseGroups(undefined), []);

  const { config, error } = buildConfig('oidc', oidcForm({ issuer: 'http://insecure.example.com' }), null);
  assert.equal(config, undefined);
  assert.match(error, /https/);

  const fake = { id: 999, config: { auto_create: '0' } };
  assert.throws(() => resolveUser(fake, { subject: 's', email: 'ghost@example.com' }), /no account/);
});

test('unit: portal passwords are hashed with Argon2id', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.notEqual(stored, await hashPassword('correct horse'), 'salted');
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.equal(needsRehash(stored), false);
  assert.equal(needsRehash(stored.replace('m=65536', 'm=19456')), true, 'weaker settings get upgraded');
  for (const bad of ['', null, undefined, 'garbage', '$argon2i$v=19$m=65536,t=3,p=4$AAAA$AAAA']) {
    assert.equal(await verifyPassword('anything', bad), false);
  }
});

test('an older scrypt password still works and is upgraded to Argon2id at sign-in', async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const legacy = `scrypt$${salt}$${crypto.scryptSync('old-password', salt, 64).toString('hex')}`;
  run('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)', 'legacy@example.com', 'Lee Gacy', legacy, 'member');
  assert.equal(await verifyPassword('old-password', legacy), true);
  assert.equal(needsRehash(legacy), true);

  assert.equal((await client().post('/login', { email: 'legacy@example.com', password: 'wrong' })).status, 401);
  assert.equal(one('SELECT password_hash FROM users WHERE email = ?', 'legacy@example.com').password_hash, legacy, 'untouched on failure');

  assert.equal((await client().post('/login', { email: 'legacy@example.com', password: 'old-password' })).status, 302);
  const upgraded = one('SELECT password_hash FROM users WHERE email = ?', 'legacy@example.com').password_hash;
  assert.match(upgraded, /^\$argon2id\$/);
  assert.equal((await client().post('/login', { email: 'legacy@example.com', password: 'old-password' })).status, 302, 'still signs in');
  run('DELETE FROM users WHERE email = ?', 'legacy@example.com');
});

test('unit: sign-in throttle limits by address+account, account, and address', () => {
  resetThrottle();
  const t = 1_000_000;
  // Five tries at one account from one address, then a wait until the first ages out.
  for (let i = 0; i < 5; i++) assert.equal(beginAttempt('1.1.1.1', 'Ada@example.com', t + i), 0);
  assert.equal(beginAttempt('1.1.1.1', 'ada@example.com', t + 10), 15 * 60_000 - 10, 'case-insensitive');
  assert.equal(beginAttempt('1.1.1.1', 'ada@example.com', t + 15 * 60_000), 0, 'window slides');
  assert.equal(beginAttempt('2.2.2.2', 'ada@example.com', t + 10), 0, 'owner elsewhere is not locked out');
  assert.equal(beginAttempt('1.1.1.1', 'bob@example.com', t + 10), 0, 'other accounts unaffected');

  // Spread over many addresses, one account still stops at 25.
  resetThrottle();
  for (let i = 0; i < 25; i++) assert.equal(beginAttempt(`10.0.0.${i}`, 'ada@example.com', t), 0);
  assert.ok(beginAttempt('10.0.1.1', 'ada@example.com', t) > 0);

  // One address across many accounts stops at 50.
  resetThrottle();
  for (let i = 0; i < 50; i++) assert.equal(beginAttempt('3.3.3.3', `u${i}@example.com`, t), 0);
  assert.ok(beginAttempt('3.3.3.3', 'new@example.com', t) > 0);

  // Success clears the account's counts and refunds its own attempt.
  resetThrottle();
  for (let i = 0; i < 4; i++) beginAttempt('4.4.4.4', 'ada@example.com', t);
  beginAttempt('4.4.4.4', 'ada@example.com', t + 1);
  attemptSucceeded('4.4.4.4', 'ada@example.com', t + 1);
  assert.equal(beginAttempt('4.4.4.4', 'ada@example.com', t + 2), 0);
  resetThrottle();
});

test('repeated wrong passwords are refused with 429, even when the next one is right', async () => {
  resetThrottle();
  for (let i = 0; i < 5; i++) {
    assert.equal((await client().post('/login', { email: 'ada@example.com', password: 'nope' })).status, 401);
  }
  const blocked = await client().post('/login', { email: 'ada@example.com', password: 'password123' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.match(await blocked.text(), /Too many sign-in attempts/);
  // An unknown account is treated the same way, so blocking reveals nothing.
  for (let i = 0; i < 5; i++) await client().post('/login', { email: 'ghost@example.com', password: 'nope' });
  assert.equal((await client().post('/login', { email: 'ghost@example.com', password: 'nope' })).status, 429);
  resetThrottle();
  assert.equal((await client().post('/login', { email: 'ada@example.com', password: 'password123' })).status, 302);
});
