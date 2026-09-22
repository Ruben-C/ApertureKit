import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { one, all, run, transaction } from '../db.js';
import { hashPassword, verifyPassword, requireLogin, csrf } from '../auth.js';
import { validateSubmission } from '../fields.js';
import { parseDomains, uploadLimitMb, ROLE_CHOICES } from '../settings.js';
import { DATA_DIR } from '../config.js';
import { enabledProviders, resolveUser, SignInError, MODULES } from '../providers/index.js';
import { notify } from '../webhook.js';

const router = Router();

const attachmentStorage = multer.diskStorage({
  destination: path.join(DATA_DIR, 'uploads', 'attachments'),
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).slice(0, 10)),
});

// The size limit is a setting, so the multer instance is built per request.
function attachmentUpload(req, res, next) {
  const fileSize = uploadLimitMb(res.locals.settings) * 1024 * 1024;
  multer({ storage: attachmentStorage, limits: { fileSize, files: 20 } }).any()(req, res, next);
}

// --- First run ---------------------------------------------------------------

router.get('/setup', (req, res) => {
  res.render('setup', { title: 'Set up your portal', values: {} });
});

router.post('/setup', (req, res) => {
  const { name, email, password } = req.body;
  const error = validateAccount({ name, email, password });
  if (error) return res.status(400).render('setup', { title: 'Set up your portal', values: req.body, error });
  const result = run(
    'INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    email.trim(),
    name.trim(),
    hashPassword(password),
    'admin',
  );
  seedExamples();
  req.session.userId = Number(result.lastInsertRowid);
  req.flash('Your portal is ready. Change its name and banner under Settings.', 'success');
  res.redirect('/admin/settings');
});

// --- Sign in / register ------------------------------------------------------

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  // With one SSO button and nothing else, skip the page and go straight
  // there, unless we are showing an error from the last attempt.
  const { signIn } = res.locals;
  if (!signIn.password && !signIn.ldap && signIn.buttons.length === 1 && req.query.password !== '1' && res.locals.flash?.kind !== 'error') {
    return res.redirect(`/auth/${signIn.buttons[0].id}/start`);
  }
  res.render('login', { title: 'Sign in', values: {}, showPassword: signIn.password || signIn.ldap || req.query.password === '1' });
});

router.post('/login', async (req, res, next) => {
  const { email = '', password = '' } = req.body;
  const username = String(email).trim();
  const { signIn } = res.locals;
  const fail = (error, status = 401) => res.status(status).render('login', { title: 'Sign in', values: { email }, error, showPassword: true });

  // Portal passwords. When switched off, administrators can still use theirs.
  const local = one('SELECT * FROM users WHERE email = ?', username);
  let user = local && verifyPassword(password, local.password_hash) && (signIn.password || local.role === 'admin') ? local : null;

  // Then each directory, in order, until one recognises the person.
  if (!user && signIn.ldap && username && password) {
    for (const provider of enabledProviders('ldap')) {
      let profile;
      try {
        profile = await MODULES.ldap.authenticate(provider, username, password);
      } catch (err) {
        console.error(`LDAP sign-in via ${provider.name} failed:`, err);
        return fail(`The ${provider.name} directory could not be reached. Try again in a moment or tell an administrator.`, 502);
      }
      if (!profile) continue;
      try {
        user = resolveUser(provider, profile);
      } catch (err) {
        if (err instanceof SignInError) return fail(err.message, 403);
        return next(err);
      }
      break;
    }
  }

  if (!user) {
    return fail(signIn.ldap ? 'That username and password do not match.' : 'That email and password do not match.');
  }
  req.session.userId = user.id;
  const dest = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(dest);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  if (!res.locals.signIn.password || res.locals.settings.allow_registration !== '1') {
    return res.status(403).render('error', { title: 'Registration is closed', message: 'Ask an administrator for an account.' });
  }
  res.render('register', { title: 'Create an account', values: {} });
});

router.post('/register', (req, res) => {
  const settings = res.locals.settings;
  if (!res.locals.signIn.password || settings.allow_registration !== '1') return res.status(403).end();
  const { name, email, password } = req.body;
  let error = validateAccount({ name, email, password });
  const domains = parseDomains(settings.registration_domains);
  if (!error && domains.length && !domains.includes(email.trim().toLowerCase().split('@')[1])) {
    error = `Use an email address ending in ${domains.map((d) => '@' + d).join(' or ')}.`;
  }
  if (!error && one('SELECT 1 FROM users WHERE email = ?', email.trim())) error = 'An account with that email already exists.';
  if (error) return res.status(400).render('register', { title: 'Create an account', values: req.body, error });
  const result = run(
    'INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
    email.trim(),
    name.trim(),
    hashPassword(password),
    ROLE_CHOICES.includes(settings.default_role) ? settings.default_role : 'member',
  );
  req.session.userId = Number(result.lastInsertRowid);
  req.flash(`Welcome, ${name.trim()}.`, 'success');
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session = null;
  // On a private portal the home page would only bounce back to sign-in.
  res.redirect(res.locals.settings.require_login === '1' ? '/login' : '/');
});

// --- Browsing ----------------------------------------------------------------

router.get('/', (req, res) => {
  const categories = all('SELECT * FROM categories ORDER BY sort_order, name');
  const forms = all('SELECT id, category_id, slug, title, description FROM forms WHERE published = 1 ORDER BY sort_order, title');
  const byCategory = new Map(categories.map((c) => [c.id, { ...c, forms: [] }]));
  for (const f of forms) byCategory.get(f.category_id)?.forms.push(f);
  res.render('home', { title: null, categories: [...byCategory.values()].filter((c) => c.forms.length) });
});

router.get('/c/:slug', (req, res) => {
  const category = one('SELECT * FROM categories WHERE slug = ?', req.params.slug);
  if (!category) return res.status(404).render('error', { title: 'Category not found', message: 'It may have been removed.' });
  const forms = all(
    'SELECT id, slug, title, description FROM forms WHERE category_id = ? AND published = 1 ORDER BY sort_order, title',
    category.id,
  );
  res.render('category', { title: category.name, category, forms });
});

router.get('/f/:slug', (req, res) => {
  const form = loadForm(req.params.slug, res.locals.can('editor'));
  if (!form) return res.status(404).render('error', { title: 'Form not found', message: 'It may be unpublished or removed.' });
  res.render('form', { title: form.title, form, values: {}, errors: {} });
});

router.post('/f/:slug', requireLogin, attachmentUpload, csrf, (req, res) => {
  const form = loadForm(req.params.slug, false);
  if (!form) return res.status(404).render('error', { title: 'Form not found', message: 'It may be unpublished or removed.' });

  const files = {};
  for (const f of req.files || []) files[f.fieldname] = f;
  const { answers, errors } = validateSubmission(form.fields, req.body, files);
  if (Object.keys(errors).length) {
    return res.status(400).render('form', { title: form.title, form, values: req.body, errors });
  }

  const id = transaction(() => {
    const r = run(
      'INSERT INTO requests (form_id, user_id, answers, form_snapshot) VALUES (?, ?, ?, ?)',
      form.id,
      req.user.id,
      JSON.stringify(answers),
      JSON.stringify({ title: form.title, category: form.category_name, confirmation: form.confirmation, fields: form.fields }),
    );
    const requestId = Number(r.lastInsertRowid);
    for (const field of form.fields) {
      // A file field hidden by a show-when rule has no answer, and its upload is not kept.
      const file = field.type === 'file' && field.id in answers && files[field.id];
      if (!file) continue;
      run(
        'INSERT INTO attachments (request_id, field_id, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
        requestId,
        field.id,
        file.originalname.slice(0, 255),
        file.filename,
        file.mimetype,
        file.size,
      );
    }
    return requestId;
  });
  notify(req, 'request.submitted', id);
  res.redirect(`/requests/${id}?submitted=1`);
});

function loadForm(slug, includeUnpublished) {
  const form = one(
    `SELECT f.*, c.name AS category_name, c.slug AS category_slug, c.color AS category_color
       FROM forms f JOIN categories c ON c.id = f.category_id
      WHERE f.slug = ? ${includeUnpublished ? '' : 'AND f.published = 1'}`,
    slug,
  );
  if (form) form.fields = JSON.parse(form.fields);
  return form;
}

function validateAccount({ name, email, password }) {
  if (!name || !name.trim()) return 'Enter your name.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
  if (!password || password.length < 8) return 'Use a password of at least 8 characters.';
  return null;
}

// A starter category and form so the portal is not empty on first visit.
function seedExamples() {
  if (one('SELECT 1 FROM categories LIMIT 1')) return;
  const cat = run(
    'INSERT INTO categories (slug, name, description, color, sort_order) VALUES (?, ?, ?, ?, ?)',
    'general',
    'General',
    'Anything that does not fit elsewhere.',
    '#2A4BC7',
    0,
  );
  run(
    'INSERT INTO forms (category_id, slug, title, description, fields, confirmation, published) VALUES (?, ?, ?, ?, ?, ?, 1)',
    Number(cat.lastInsertRowid),
    'general-request',
    'General request',
    'Describe what you need and we will route it to the right person.',
    JSON.stringify([
      { id: 'summary', type: 'text', label: 'What do you need?', help: 'One line is enough.', required: true, placeholder: '' },
      { id: 'details', type: 'textarea', label: 'Details', help: 'Anything that helps us act on it.', required: false, placeholder: '' },
      { id: 'urgency', type: 'radio', label: 'How urgent is this?', help: '', required: true, options: ['Whenever', 'This week', 'Today'] },
    ]),
    'Thanks. Someone will pick this up and you can follow progress here.',
  );
}

export default router;
