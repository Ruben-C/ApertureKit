import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, DATA_DIR, TRUST_PROXY, sessionSecret } from './config.js';
import { one } from './db.js';
import { getSettings, parseDomains, uploadLimitMb } from './settings.js';
import { loadUser, flash, csrf, requireLogin } from './auth.js';
import { FIELD_TYPES } from './fields.js';
import { STATUS } from './status.js';
import publicRoutes from './routes/public.js';
import requestRoutes from './routes/requests.js';
import editorRoutes from './routes/editor.js';
import adminRoutes from './routes/admin.js';
import ssoRoutes from './routes/sso.js';
import { enabledProviders } from './providers/index.js';
import { isSignedFileLink } from './webhook.js';

// Busts browser caches for /static assets when the app is upgraded.
const ASSET_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export function createApp() {
  const app = express();
  if (TRUST_PROXY) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'src', 'views'));
  app.disable('x-powered-by');

  // Liveness probe for Docker and reverse proxies; touches the database and
  // sits above the setup redirect so it answers before an admin exists.
  app.get('/healthz', (req, res) => {
    one('SELECT 1');
    res.type('text').send('ok');
  });

  app.use('/static', express.static(path.join(ROOT, 'src', 'public'), { maxAge: '1h' }));
  app.use('/branding', express.static(path.join(DATA_DIR, 'uploads', 'branding'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(
    cookieSession({
      name: 'portal.sid',
      keys: [sessionSecret()],
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
      secure: TRUST_PROXY,
    }),
  );
  app.use(flash);
  app.use(loadUser);

  // Template globals.
  app.use((req, res, next) => {
    res.locals.settings = getSettings();
    res.locals.domains = parseDomains(res.locals.settings.registration_domains);
    res.locals.uploadLimitMb = uploadLimitMb(res.locals.settings);
    res.locals.assetVersion = ASSET_VERSION;
    res.locals.path = req.path;
    res.locals.query = req.query;
    res.locals.FIELD_TYPES = FIELD_TYPES;
    res.locals.STATUS = STATUS;
    res.locals.fmtDate = fmtDate;
    res.locals.ticket = (id) => res.locals.settings.ticket_prefix + String(id).padStart(4, '0');
    // The sign-in page and header need to know which methods are on.
    res.locals.signIn = signInOptions(res.locals.settings);
    next();
  });

  // Until an admin exists, everything goes to setup.
  app.use((req, res, next) => {
    const hasUsers = one('SELECT 1 FROM users LIMIT 1');
    if (!hasUsers && !req.path.startsWith('/setup')) return res.redirect('/setup');
    if (hasUsers && req.path.startsWith('/setup')) return res.redirect('/');
    next();
  });

  // A private portal asks everyone to sign in before showing anything.
  app.use((req, res, next) => {
    if (req.user || res.locals.settings.require_login !== '1') return next();
    if (['/login', '/register'].includes(req.path) || req.path.startsWith('/auth/')) return next();
    if (isSignedFileLink(req)) return next(); // the route checks the signature itself
    requireLogin(req, res, next);
  });

  // Multipart routes run multer before CSRF so the token is readable.
  app.use(csrfUnlessMultipart);

  app.use(ssoRoutes);
  app.use(publicRoutes);
  app.use(requestRoutes);
  app.use('/editor', editorRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Page not found', message: 'Nothing lives at this address.' });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).render('error', {
      title: status === 413 ? 'File too large' : 'Something went wrong',
      message: status === 413
        ? `Attach a smaller file. Each file can be up to ${res.locals.uploadLimitMb ?? uploadLimitMb(getSettings())} MB.`
        : status >= 500 ? 'The server hit an error. Try again.' : err.message,
    });
  });
  return app;
}

function csrfUnlessMultipart(req, res, next) {
  const samlCallback = req.method === 'POST' && /^\/auth\/\d+\/callback$/.test(req.path);
  if (samlCallback || (req.method === 'POST' && req.is('multipart/form-data'))) {
    // Multipart: the route will call csrf itself after parsing. SAML: the
    // identity provider posts here cross-site and cannot carry our token;
    // the signed assertion is what proves the request is genuine.
    if (!req.session.csrf) req.session.csrf = crypto.randomUUID().replace(/-/g, '');
    res.locals.csrf = req.session.csrf;
    return next();
  }
  return csrf(req, res, next);
}

// Which ways of signing in are currently available. Password sign-in can be
// switched off once SSO works, but administrators can always use it via
// /login?password=1 so a broken IdP never locks everyone out.
function signInOptions(settings) {
  const providers = enabledProviders();
  return {
    password: settings.password_login === '1',
    buttons: providers.filter((p) => p.type !== 'ldap').map((p) => ({ id: p.id, name: p.name })),
    ldap: providers.some((p) => p.type === 'ldap'),
  };
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
