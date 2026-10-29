import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getSettings, sessionLimits } from './settings.js';
import { resumeSession } from './sessions.js';
import { safePath } from './providers/common.js';

export const ROLES = ['member', 'editor', 'admin'];
const rank = (role) => ROLES.indexOf(role);

// Portal passwords are hashed with Argon2id at the first parameter set RFC 9106
// recommends (64 MiB, 3 passes, 4 lanes), stored as a standard PHC string:
// $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>. Hashes made by earlier
// versions (scrypt) still verify and are replaced at the next sign-in.
const ARGON2 = { memory: 65536, passes: 3, parallelism: 4, tagLength: 32 };
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const argon2 = promisify(crypto.argon2);
const scrypt = promisify(crypto.scrypt);
const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(password) {
  const nonce = crypto.randomBytes(16);
  const hash = await argon2('argon2id', { message: String(password), nonce, ...ARGON2 });
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(nonce)}$${b64(hash)}`;
}

// Always does one full hash, even for an unknown email or an account with no
// password, so response times do not reveal which accounts exist.
export async function verifyPassword(password, stored) {
  stored = String(stored ?? '');
  const message = String(password ?? '');
  const phc = PHC.exec(stored);
  if (phc) {
    const [, memory, passes, parallelism, nonce, hash] = phc;
    const expected = Buffer.from(hash, 'base64');
    const candidate = await argon2('argon2id', {
      message, nonce: Buffer.from(nonce, 'base64'), tagLength: expected.length,
      memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism),
    });
    return crypto.timingSafeEqual(candidate, expected);
  }
  const [scheme, salt, hash] = stored.split('$');
  if (scheme === 'scrypt' && salt && hash) {
    const expected = Buffer.from(hash, 'hex');
    const candidate = await scrypt(message, salt, 64);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  }
  await hashPassword(message);
  return false;
}

// True when a stored hash is from an older scheme or weaker settings than the
// current ones, so it should be replaced after a successful sign-in.
export function needsRehash(stored) {
  const phc = PHC.exec(String(stored ?? ''));
  return !phc || Number(phc[1]) < ARGON2.memory || Number(phc[2]) < ARGON2.passes || Number(phc[3]) < ARGON2.parallelism;
}

// Loads the signed-in user (if any) onto req.user and the templates. An
// expired session is dropped here; the next page that needs sign-in says so.
export function loadUser(req, res, next) {
  const limits = sessionLimits(getSettings());
  // The cookie lives no longer than the longest a session can last.
  if (req.sessionOptions) req.sessionOptions.maxAge = limits.max;
  const { user, expired } = resumeSession(req, limits);
  req.user = user;
  req.sessionExpired = expired;
  res.locals.user = req.user;
  res.locals.can = (role) => !!req.user && rank(req.user.role) >= rank(role);
  next();
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = safePath(req.originalUrl);
  req.flash(req.sessionExpired ? 'Your session timed out. Sign in again to continue.' : 'Sign in to continue.');
  res.redirect('/login');
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (rank(req.user.role) >= rank(role)) return next();
    res.status(403).render('error', { title: 'Not allowed', message: `This page is for ${role}s.` });
  };
}

// One-time flash messages stored in the session cookie.
export function flash(req, res, next) {
  req.flash = (message, kind = 'info') => {
    req.session.flash = { message, kind };
  };
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  next();
}

// Synchroniser-token CSRF check for every state-changing request.
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const token = req.body?._csrf || req.get('x-csrf-token');
    if (token !== req.session.csrf) {
      return res.status(403).render('error', {
        title: 'Form expired',
        message: 'The page was open too long or the session changed. Go back and try again.',
      });
    }
  }
  next();
}
