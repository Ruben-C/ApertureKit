import crypto from 'node:crypto';
import { one } from './db.js';

export const ROLES = ['member', 'editor', 'admin'];
const rank = (role) => ROLES.indexOf(role);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// Loads the signed-in user (if any) onto req.user and the templates.
export function loadUser(req, res, next) {
  req.user = null;
  if (req.session?.userId) {
    req.user = one('SELECT id, email, name, role FROM users WHERE id = ?', req.session.userId) || null;
    if (!req.user) req.session = null;
  }
  res.locals.user = req.user;
  res.locals.can = (role) => !!req.user && rank(req.user.role) >= rank(role);
  next();
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  req.flash('Sign in to continue.');
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
