import crypto from 'node:crypto';
import { one, all, run } from './db.js';

// Server-side record of each signed-in browser. The session cookie holds a
// random token; the sessions table holds its hash, who it belongs to, and
// when it was last used. A session ends when it sits idle too long, reaches
// its overall lifetime, is signed out, or is revoked by an administrator.
// Both limits come from the Settings page (settings.sessionLimits).

// last_seen is written at most this often, not on every request.
const TOUCH_EVERY_MS = 60_000;

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const parse = (iso) => Date.parse(iso.replace(' ', 'T') + 'Z');
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Signs the browser in as `userId`, replacing whatever session it had (so a
// token planted before sign-in, CSRF token included, is never carried over).
export function startSession(req, userId) {
  if (req.session?.sid) run('DELETE FROM sessions WHERE id = ?', hash(req.session.sid));
  const token = crypto.randomBytes(32).toString('base64url');
  run(
    'INSERT INTO sessions (id, user_id, ip, user_agent) VALUES (?, ?, ?, ?)',
    hash(token),
    userId,
    String(req.ip || '').slice(0, 64),
    String(req.get('user-agent') || '').slice(0, 300),
  );
  req.session = { sid: token };
}

// The user behind this request's session, or null. `expired` is true when
// there was a session but it has run out, so the caller can say so.
export function resumeSession(req, limits) {
  const token = req.session?.sid;
  if (!token) {
    // Cookies from before server-side sessions carried only a user id.
    if (req.session?.userId) delete req.session.userId;
    return { user: null, expired: false };
  }
  const row = one(
    `SELECT s.id, s.created_at, s.last_seen, u.id AS user_id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    hash(token),
  );
  const now = Date.now();
  const live = row && now - parse(row.last_seen) < limits.idle && now - parse(row.created_at) < limits.max;
  if (!live) {
    if (row) run('DELETE FROM sessions WHERE id = ?', row.id);
    delete req.session.sid;
    return { user: null, expired: true };
  }
  if (now - parse(row.last_seen) > TOUCH_EVERY_MS) run('UPDATE sessions SET last_seen = ? WHERE id = ?', sqlTime(now), row.id);
  return { user: { id: row.user_id, email: row.email, name: row.name, role: row.role }, expired: false };
}

export function endSession(req) {
  if (req.session?.sid) run('DELETE FROM sessions WHERE id = ?', hash(req.session.sid));
  req.session = null;
}

// Signs a person out everywhere, optionally keeping the current browser.
export function endUserSessions(userId, keepReq = null) {
  const keep = keepReq?.session?.sid ? hash(keepReq.session.sid) : '';
  return Number(run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, keep).changes);
}

// Active sessions per user, for the People page: { count, lastSeen }.
export function sessionSummary(limits) {
  purgeExpired(limits);
  const out = new Map();
  for (const r of all('SELECT user_id, COUNT(*) AS n, MAX(last_seen) AS last_seen FROM sessions GROUP BY user_id')) {
    out.set(r.user_id, { count: r.n, lastSeen: r.last_seen });
  }
  return out;
}

export function purgeExpired(limits) {
  const now = Date.now();
  run('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?', sqlTime(now - limits.idle), sqlTime(now - limits.max));
}
