import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import en from '../src/i18n/locales/en.js';
import ptBR from '../src/i18n/locales/pt-BR.js';
import {
  translate,
  getTranslator,
  resolveLocale,
  parseAcceptLanguage,
  matchLocale,
  getLocalizedStatus,
  getLocalizedFieldTypes,
  getClientTranslations,
  fmtDate,
  fmtAgo,
  SUPPORTED_LOCALES,
} from '../src/i18n/index.js';
import { validateSubmission, sanitizeFields } from '../src/fields.js';

test('i18n: en and pt-BR translation dictionaries have identical key structure', () => {
  function getLeaves(obj, prefix = '') {
    const leaves = {};
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(leaves, getLeaves(v, full));
      } else {
        leaves[full] = String(v);
      }
    }
    return leaves;
  }

  const enLeaves = getLeaves(en);
  const ptLeaves = getLeaves(ptBR);

  const missingInPt = Object.keys(enLeaves).filter((k) => !(k in ptLeaves));
  assert.deepEqual(missingInPt, [], 'pt-BR should not miss any keys present in en');

  const missingInEn = Object.keys(ptLeaves).filter((k) => !(k in enLeaves));
  assert.deepEqual(missingInEn, [], 'en should not miss any keys present in pt-BR');

  // Verify that parameter placeholders match between translations
  for (const key of Object.keys(enLeaves)) {
    const enParams = (enLeaves[key].match(/(?:%\{|\{)([a-zA-Z0-9_-]+)(?:\})/g) || []).sort();
    const ptParams = (ptLeaves[key].match(/(?:%\{|\{)([a-zA-Z0-9_-]+)(?:\})/g) || []).sort();
    assert.deepEqual(
      ptParams,
      enParams,
      `Placeholders for key "${key}" should match: en=${JSON.stringify(enParams)}, pt=${JSON.stringify(ptParams)}`,
    );
  }
});

test('i18n: translate resolves strings and interpolates params', () => {
  assert.equal(translate('common.save', null, 'en'), 'Save');
  assert.equal(translate('common.save', null, 'pt-BR'), 'Salvar');
  assert.equal(translate('auth.welcome_name', { name: 'Maria' }, 'en'), 'Welcome, Maria.');
  assert.equal(translate('auth.welcome_name', { name: 'Maria' }, 'pt-BR'), 'Boas-vindas, Maria.');

  // Fallback to key if unknown
  assert.equal(translate('non.existent.key', null, 'pt-BR'), 'non.existent.key');
});

test('i18n: parseAcceptLanguage and matchLocale', () => {
  const langs = parseAcceptLanguage('pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7');
  assert.deepEqual(langs, ['pt-BR', 'pt', 'en-US', 'en']);
  assert.equal(matchLocale(langs, SUPPORTED_LOCALES), 'pt-BR');

  const enLangs = parseAcceptLanguage('en-US,en;q=0.9');
  assert.equal(matchLocale(enLangs, SUPPORTED_LOCALES), 'en');

  const ptLangs = parseAcceptLanguage('pt');
  assert.equal(matchLocale(ptLangs, SUPPORTED_LOCALES), 'pt-BR');
});

test('i18n: resolveLocale respects priority order', () => {
  // 1. Query parameter ?lang=
  assert.equal(resolveLocale({ query: { lang: 'pt-BR' } }, { locale: 'en' }), 'pt-BR');
  assert.equal(resolveLocale({ query: { lang: 'en' } }, { locale: 'pt-BR' }), 'en');

  // 2. Session
  assert.equal(resolveLocale({ session: { locale: 'pt-BR' } }, { locale: 'en' }), 'pt-BR');

  // 3. Portal setting
  assert.equal(resolveLocale({}, { locale: 'pt-BR' }), 'pt-BR');
  assert.equal(resolveLocale({}, { locale: 'en' }), 'en');

  // 4. Accept-Language header when setting is 'auto'
  assert.equal(resolveLocale({ headers: { 'accept-language': 'pt-BR,pt;q=0.9' } }, { locale: 'auto' }), 'pt-BR');
  assert.equal(resolveLocale({ headers: { 'accept-language': 'en-US' } }, { locale: 'auto' }), 'en');

  // 5. Default fallback
  assert.equal(resolveLocale({}, {}), 'en');
});

test('i18n: fmtDate and fmtAgo format correctly in pt-BR and en', () => {
  const now = new Date().toISOString();
  assert.equal(fmtAgo(now, 'en'), 'just now');
  assert.equal(fmtAgo(now, 'pt-BR'), 'agora mesmo');

  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  assert.match(fmtAgo(tenMinAgo, 'en'), /10 minutes ago/);
  assert.match(fmtAgo(tenMinAgo, 'pt-BR'), /10 minutos/);

  const formattedPt = fmtDate(now, 'pt-BR');
  assert.ok(formattedPt.length > 0);
});

test('i18n: getLocalizedStatus and getLocalizedFieldTypes', () => {
  const statusEn = getLocalizedStatus('en');
  assert.equal(statusEn.new, 'New');
  assert.equal(statusEn.in_progress, 'In progress');
  assert.equal(statusEn.done, 'Done');
  assert.equal(statusEn.declined, 'Declined');

  const statusPt = getLocalizedStatus('pt-BR');
  assert.equal(statusPt.new, 'Novo');
  assert.equal(statusPt.in_progress, 'Em andamento');
  assert.equal(statusPt.done, 'Concluído');
  assert.equal(statusPt.declined, 'Recusado');

  const typesPt = getLocalizedFieldTypes('pt-BR');
  assert.equal(typesPt.text.label, 'Resposta curta');
  assert.equal(typesPt.email.label, 'E-mail');
  assert.equal(typesPt.yesno.label, 'Sim / não');
});

test('i18n: validateSubmission translates validation errors with t', () => {
  const tPt = getTranslator('pt-BR');
  const fields = sanitizeFields([
    { id: 'name', type: 'text', label: 'Nome', required: true },
    { id: 'opt', type: 'select', label: 'Opção', options: ['A', 'B'], required: true },
  ]);

  const { errors } = validateSubmission(fields, { name: '', opt: '' }, {}, tPt);
  assert.equal(errors.name, 'Este campo é obrigatório.');
  assert.equal(errors.opt, 'Escolha uma opção.');
});

// Full app HTTP integration test with pt-BR locale
process.env.PORTAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aperturekit-i18n-test-'));
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

function client() {
  let cookie = '';
  const get = async (p, headers = {}) => {
    const res = await fetch(base + p, { headers: { cookie, ...headers }, redirect: 'manual' });
    if (res.headers.get('set-cookie')) cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = async (p, body, headers = {}) => {
    const page = await get(p);
    const html = await page.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ _csrf: csrf, ...body }).toString(),
      redirect: 'manual',
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  return { get, post, cookie: () => cookie };
}

test('integration: setup and portal pages adapt to ?lang=pt-BR and portal locale setting', async () => {
  const c = client();

  // Setup page in English by default
  const setupEn = await (await c.get('/setup')).text();
  assert.match(setupEn, /Set up your portal/);
  assert.match(setupEn, /lang="en"/);

  // Setup page with ?lang=pt-BR
  const setupPt = await (await c.get('/setup?lang=pt-BR')).text();
  assert.match(setupPt, /Configurar seu portal/);
  assert.match(setupPt, /Criar administrador/);
  assert.match(setupPt, /lang="pt-BR"/);

  // Create admin
  const res = await c.post('/setup', { name: 'Admin', email: 'admin@example.com', password: 'password123' });
  assert.equal(res.status, 302);

  // Check login page with pt-BR as a guest (signed-out)
  const guest = client();
  const loginPt = await (await guest.get('/login?lang=pt-BR')).text();
  assert.match(loginPt, /Entrar/);
  assert.match(loginPt, /Senha/);

  // Sign in
  await c.post('/login', { email: 'admin@example.com', password: 'password123' });

  // Change default portal language to pt-BR in Settings
  const save = await c.post('/admin/settings', {
    site_name: 'Portal de Chamados',
    locale: 'pt-BR',
    allow_registration: '1',
  });
  assert.equal(save.status, 302);

  // Home page is now in Portuguese
  const home = await (await c.get('/')).text();
  assert.match(home, /lang="pt-BR"/);
  assert.match(home, /Localizar um formulário/);
  assert.match(home, /Minhas solicitações/);

  // Editor page is in Portuguese
  const editor = await (await c.get('/editor')).text();
  assert.match(editor, /Categorias e formulários/);
  assert.match(editor, /Nova categoria/);
});
