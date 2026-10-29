import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { one, all, run } from '../db.js';
import { requireRole, csrf, hashPassword, ROLES } from '../auth.js';
import {
  getSettings, setSettings, resetSettings, parseDomains,
  DEFAULTS, ROLE_CHOICES, COMMENT_CHOICES, MAX_UPLOAD_CEILING_MB,
  SESSION_IDLE_CHOICES, SESSION_MAX_CHOICES, sessionLimits,
} from '../settings.js';
import { endUserSessions, sessionSummary } from '../sessions.js';
import { attachmentFilesWhere, removeAttachmentFiles } from '../uploads.js';
import { DATA_DIR } from '../config.js';
import {
  TYPES, MODULES, listProviders, enabledProviders, getProvider, buildConfig, saveProvider, deleteProvider,
  baseUrl, identitiesFor,
} from '../providers/index.js';
import { EVENTS as WEBHOOK_EVENTS, sendTest as sendWebhookTest } from '../webhook.js';

const router = Router();
router.use(requireRole('admin'));

const BRANDING_DIR = path.join(DATA_DIR, 'uploads', 'branding');
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };

const bannerUpload = multer({
  storage: multer.diskStorage({
    destination: BRANDING_DIR,
    filename: (req, file, cb) => cb(null, 'banner-' + crypto.randomBytes(6).toString('hex') + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, !!IMAGE_TYPES[file.mimetype]),
});

// --- Branding & settings -----------------------------------------------------

const settingsLocals = () => ({
  title: 'Settings',
  values: getSettings(),
  defaults: DEFAULTS,
  roleChoices: ROLE_CHOICES,
  commentChoices: COMMENT_CHOICES,
  uploadCeiling: MAX_UPLOAD_CEILING_MB,
  sessionIdleChoices: SESSION_IDLE_CHOICES,
  sessionMaxChoices: SESSION_MAX_CHOICES,
  webhookEvents: WEBHOOK_EVENTS,
});

router.get('/settings', (req, res) => {
  res.render('admin/settings', settingsLocals());
});

router.post('/settings', bannerUpload.single('banner_image'), csrf, async (req, res) => {
  const current = getSettings();
  if (req.body.action === 'reset') {
    removeBanner(current.banner_image);
    resetSettings();
    req.flash('Back to the defaults.', 'success');
    return res.redirect('/admin/settings');
  }
  const b = req.body;
  const patch = {
    site_name: text(b.site_name, 80) || DEFAULTS.site_name,
    tagline: text(b.tagline, 200),
    welcome_text: text(b.welcome_text, 1000),
    login_text: text(b.login_text, 500),
    footer_text: text(b.footer_text, 500),
    show_credit: flag(b.show_credit),
    banner_color: hex(b.banner_color, current.banner_color),
    banner_text_color: hex(b.banner_text_color, current.banner_text_color),
    allow_registration: flag(b.allow_registration),
    registration_domains: parseDomains(b.registration_domains).join(', '),
    default_role: ROLE_CHOICES.includes(b.default_role) ? b.default_role : DEFAULTS.default_role,
    require_login: flag(b.require_login),
    session_idle_minutes: b.session_idle_minutes in SESSION_IDLE_CHOICES ? b.session_idle_minutes : current.session_idle_minutes,
    session_max_minutes: b.session_max_minutes in SESSION_MAX_CHOICES ? b.session_max_minutes : current.session_max_minutes,
    max_upload_mb: integer(b.max_upload_mb, 1, MAX_UPLOAD_CEILING_MB, current.max_upload_mb),
    comments: b.comments in COMMENT_CHOICES ? b.comments : DEFAULTS.comments,
    // Blank is a deliberate choice here (plain numbers); only a missing field falls back.
    ticket_prefix: b.ticket_prefix === undefined ? current.ticket_prefix : text(b.ticket_prefix, 8),
    webhook_url: text(b.webhook_url, 500),
    webhook_secret: text(b.webhook_secret, 200),
    webhook_on_submit: flag(b.webhook_on_submit),
    webhook_on_status: flag(b.webhook_on_status),
    webhook_on_comment: flag(b.webhook_on_comment),
  };
  if (patch.webhook_url && !isHttpUrl(patch.webhook_url)) {
    req.flash('Webhook address should be a full http:// or https:// address.', 'error');
    return res.redirect('/admin/settings');
  }
  if (req.body.remove_banner === '1') {
    removeBanner(current.banner_image);
    patch.banner_image = '';
  }
  if (req.file) {
    removeBanner(current.banner_image);
    patch.banner_image = req.file.filename;
  }
  setSettings(patch);
  if (req.body.action === 'webhook_test') {
    // Saves first so the test uses exactly what is on the page.
    const error = await sendWebhookTest(req, getSettings());
    if (error) req.flash(`Settings saved, but the test event failed: ${error}`, 'error');
    else req.flash('Settings saved and a test event was delivered.', 'success');
    return res.redirect('/admin/settings#webhook');
  }
  req.flash('Settings saved.', 'success');
  res.redirect('/admin/settings');
});

// --- Sign-in methods ---------------------------------------------------------

router.get('/auth', (req, res) => {
  res.render('admin/auth', {
    title: 'Sign-in methods',
    providers: listProviders(),
    types: TYPES,
    values: getSettings(),
    detectedUrl: `${req.protocol}://${req.get('host')}`,
  });
});

// General options: password sign-in and the public address.
router.post('/auth', (req, res) => {
  const passwordLogin = flag(req.body.password_login);
  if (passwordLogin === '0' && !enabledProviders().length) {
    req.flash('Switch on at least one other sign-in method before turning off passwords.', 'error');
    return res.redirect('/admin/auth');
  }
  let publicUrl = text(req.body.public_url, 300).replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\/[^\s/]+$/i.test(publicUrl)) {
    req.flash('Portal address should look like https://portal.example.com (no path).', 'error');
    return res.redirect('/admin/auth');
  }
  setSettings({ password_login: passwordLogin, public_url: publicUrl });
  req.flash('Sign-in options saved.', 'success');
  res.redirect('/admin/auth');
});

const providerLocals = (req, type, provider, values, extra = {}) => ({
  title: provider ? provider.name : `Add ${TYPES[type].label}`,
  type,
  typeInfo: TYPES[type],
  provider,
  values,
  base: baseUrl(req),
  ...extra,
});

router.get('/auth/new/:type', (req, res) => {
  const type = req.params.type;
  if (!TYPES[type]) return res.status(404).end();
  const preset = TYPES[type].presets.find((p) => p.key === req.query.preset) || TYPES[type].presets[0];
  const values = {};
  for (const f of TYPES[type].fields) if (f.default !== undefined) values[f.key] = f.default;
  Object.assign(values, preset.values);
  res.render('admin/auth_provider', providerLocals(req, type, null, values, { preset }));
});

router.post('/auth/new/:type', (req, res) => {
  const type = req.params.type;
  if (!TYPES[type]) return res.status(404).end();
  const { config, error } = buildConfig(type, req.body, null);
  if (error) return res.status(400).render('admin/auth_provider', providerLocals(req, type, null, req.body, { error }));
  const id = saveProvider({ type, config, enabled: req.body.enabled !== '0' });
  req.flash(`${config.name} added. ${type === 'ldap' ? 'Use the test below to check the connection.' : 'Give your identity provider the addresses shown below.'}`, 'success');
  res.redirect(`/admin/auth/${id}`);
});

router.get('/auth/:id', (req, res) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).end();
  res.render('admin/auth_provider', providerLocals(req, provider.type, provider, provider.config));
});

router.post('/auth/:id', async (req, res, next) => {
  const provider = getProvider(req.params.id);
  if (!provider) return res.status(404).end();
  const { type } = provider;

  if (req.body.action === 'delete') {
    deleteProvider(provider.id);
    if (!enabledProviders().length) setSettings({ password_login: '1' });
    req.flash(`${provider.name} removed. Accounts that used it are kept.`, 'success');
    return res.redirect('/admin/auth');
  }

  const { config, error } = buildConfig(type, req.body, provider);
  if (error) {
    return res.status(400).render('admin/auth_provider', providerLocals(req, type, provider, { ...req.body }, { error }));
  }

  if (req.body.action === 'test' && type === 'ldap') {
    let result;
    try {
      result = await MODULES.ldap.test(config, text(req.body.test_username, 200), String(req.body.test_password || ''));
    } catch (err) {
      result = { ok: false, message: `Could not connect: ${err.message}` };
    }
    return res.render('admin/auth_provider', providerLocals(req, type, provider, { ...req.body }, { test: result }));
  }

  const enabled = req.body.enabled !== '0';
  saveProvider({ id: provider.id, type, config, enabled });
  if (getSettings().password_login !== '1' && !enabledProviders().length) {
    // Never leave the portal with no way in.
    setSettings({ password_login: '1' });
    req.flash(`${config.name} saved. It was the last sign-in method, so password sign-in is back on.`, 'info');
  } else {
    req.flash(`${config.name} saved.`, 'success');
  }
  res.redirect(`/admin/auth/${provider.id}`);
});

// --- People ------------------------------------------------------------------

router.get('/users', (req, res) => {
  const users = all(
    `SELECT u.*, (SELECT COUNT(*) FROM requests r WHERE r.user_id = u.id) AS request_count
       FROM users u ORDER BY u.created_at`,
  );
  res.render('admin/users', { title: 'People', users, roles: ROLES, values: {}, ...peopleLocals(users) });
});

const peopleLocals = (users) => ({
  signsInWith: identitiesFor(users.map((u) => u.id)),
  sessions: sessionSummary(sessionLimits(getSettings())),
});

router.post('/users', async (req, res) => {
  const { name = '', email = '', password = '', role = 'member' } = req.body;
  // A blank password is allowed when another sign-in method exists: the
  // person then gets in through SSO or the directory, matched by email.
  const ssoOnly = !password && enabledProviders().length > 0;
  let error = null;
  if (!name.trim()) error = 'Enter a name.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) error = 'Enter a valid email address.';
  else if (!ssoOnly && password.length < 8) error = 'Use a password of at least 8 characters.';
  else if (one('SELECT 1 FROM users WHERE email = ?', email.trim())) error = 'Someone already has that email.';
  if (error) {
    const users = all('SELECT u.*, 0 AS request_count FROM users u ORDER BY u.created_at');
    return res.status(400).render('admin/users', { title: 'People', users, roles: ROLES, values: req.body, error, ...peopleLocals(users) });
  }
  run(
    'INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    email.trim(), name.trim(), ssoOnly ? '' : await hashPassword(password), ROLES.includes(role) ? role : 'member',
  );
  req.flash(ssoOnly ? `Added ${name.trim()}. They can sign in through single sign-on or the directory.` : `Added ${name.trim()}.`, 'success');
  res.redirect('/admin/users');
});

router.post('/users/:id', async (req, res) => {
  const target = one('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).end();
  const admins = one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
  const lastAdmin = target.role === 'admin' && admins === 1;

  if (req.body.action === 'delete') {
    if (lastAdmin) req.flash('You cannot remove the only administrator.', 'error');
    else {
      const files = attachmentFilesWhere('r.user_id = ?', target.id);
      run('DELETE FROM users WHERE id = ?', target.id);
      removeAttachmentFiles(files);
      req.flash(`Removed ${target.name}.`, 'success');
    }
    return res.redirect('/admin/users');
  }
  if (req.body.action === 'role') {
    const role = ROLES.includes(req.body.role) ? req.body.role : target.role;
    if (lastAdmin && role !== 'admin') req.flash('Promote someone else to administrator first.', 'error');
    else { run('UPDATE users SET role = ? WHERE id = ?', role, target.id); req.flash(`${target.name} is now a ${role}.`, 'success'); }
    return res.redirect('/admin/users');
  }
  if (req.body.action === 'password') {
    const password = String(req.body.password || '');
    if (password.length < 8) req.flash('Use a password of at least 8 characters.', 'error');
    else {
      run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), target.id);
      // Anyone signed in with the old password is signed out (you stay signed in here).
      endUserSessions(target.id, req);
      req.flash(`Password changed for ${target.name}. They have been signed out everywhere else.`, 'success');
    }
    return res.redirect('/admin/users');
  }
  if (req.body.action === 'signout') {
    const n = endUserSessions(target.id, req);
    const where = target.id === req.user.id ? ' on your other devices' : '';
    req.flash(n ? `Signed ${target.name} out of ${n} session${n === 1 ? '' : 's'}${where}.` : `${target.name} had no other sessions.`, 'success');
    return res.redirect('/admin/users');
  }
  res.redirect('/admin/users');
});

function text(input, max) {
  return String(input || '').trim().slice(0, max);
}

function flag(input) {
  return input === '1' ? '1' : '0';
}

function integer(input, min, max, fallback) {
  const n = Math.floor(Number(input));
  return Number.isFinite(n) && n >= min && n <= max ? String(n) : fallback;
}

function hex(input, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(input || '') ? input.toUpperCase() : fallback;
}

function isHttpUrl(input) {
  try {
    return ['http:', 'https:'].includes(new URL(input).protocol);
  } catch {
    return false;
  }
}

function removeBanner(name) {
  if (!name) return;
  fs.rm(path.join(BRANDING_DIR, path.basename(name)), { force: true }, () => {});
}

export default router;
