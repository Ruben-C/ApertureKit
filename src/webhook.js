import crypto from 'node:crypto';
import { one, all } from './db.js';
import { getSettings } from './settings.js';
import { sessionSecret } from './config.js';
import { baseUrl } from './providers/index.js';

// Outgoing webhook: one JSON POST per event to the address set on the
// Settings page. Built for n8n (its Webhook node accepts exactly this), but
// any endpoint that takes JSON works. Events never block the response: the
// request is saved first, the POST goes out afterwards, and a failure is
// only logged.

export const EVENTS = {
  'request.submitted': { setting: 'webhook_on_submit', label: 'A request is sent' },
  'request.status_changed': { setting: 'webhook_on_status', label: 'A request changes status' },
  'comment.added': { setting: 'webhook_on_comment', label: 'A note is added to a request' },
};

const TIMEOUT_MS = 10000;
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// --- Signed attachment links -------------------------------------------------
// Payloads link to attachments with a token so a workflow can download them
// without an account. The key is derived from the session secret, so it
// survives restarts and rotates with it; links stop working after a week.

const linkKey = () => crypto.createHmac('sha256', sessionSecret()).update('attachment-link').digest();
const linkSig = (requestId, attachmentId, expires) =>
  crypto.createHmac('sha256', linkKey()).update(`${requestId}:${attachmentId}:${expires}`).digest('hex');

export function attachmentLink(base, requestId, attachmentId) {
  const expires = Date.now() + LINK_TTL_MS;
  return `${base}/requests/${requestId}/files/${attachmentId}?token=${expires}.${linkSig(requestId, attachmentId, expires)}`;
}

export function verifyAttachmentToken(token, requestId, attachmentId) {
  const [expires, sig] = String(token || '').split('.');
  if (!/^\d+$/.test(expires || '') || Number(expires) < Date.now()) return false;
  const expected = linkSig(requestId, attachmentId, expires);
  if (!/^[0-9a-f]+$/.test(sig || '') || sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

// True for a file address carrying a token; the route still has to verify it.
export const isSignedFileLink = (req) => /^\/requests\/\d+\/files\/\d+$/.test(req.path) && typeof req.query.token === 'string';

// Fire-and-forget. `extra` is merged into the payload (e.g. previous_status).
export function notify(req, event, requestId, extra = {}) {
  const settings = getSettings();
  const url = String(settings.webhook_url || '').trim();
  if (!url) return;
  if (EVENTS[event] && settings[EVENTS[event].setting] !== '1') return;
  const payload = { event, ...describeRequest(req, settings, requestId), ...extra };
  deliver(url, settings.webhook_secret, payload).catch((err) => {
    console.warn(`Webhook ${event} to ${url} failed: ${err.message}`);
  });
}

// Used by the "send a test" button; resolves to an error message or null.
export async function sendTest(req, settings) {
  const url = String(settings.webhook_url || '').trim();
  if (!url) return 'Enter a webhook address first.';
  const payload = {
    event: 'webhook.test',
    sent_at: new Date().toISOString(),
    portal: { name: settings.site_name, url: baseUrl(req) },
    sent_by: { id: req.user.id, name: req.user.name, email: req.user.email },
  };
  try {
    await deliver(url, settings.webhook_secret, payload);
    return null;
  } catch (err) {
    return err.message;
  }
}

async function deliver(url, secret, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'ApertureKit',
    'x-aperturekit-event': payload.event,
  };
  if (secret) {
    // Two ways to check the sender: a plain shared secret (n8n "Header Auth"
    // credential) or an HMAC of the body for endpoints that verify signatures.
    headers['x-webhook-secret'] = secret;
    headers['x-webhook-signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`endpoint answered ${res.status} ${res.statusText}`.trim());
}

// Everything a workflow might want about a request, in one flat-ish object.
function describeRequest(req, settings, requestId) {
  const base = baseUrl(req);
  const r = one(
    `SELECT r.*, u.name AS requester, u.email AS requester_email, f.slug AS form_slug
       FROM requests r JOIN users u ON u.id = r.user_id LEFT JOIN forms f ON f.id = r.form_id
      WHERE r.id = ?`,
    requestId,
  );
  const snapshot = JSON.parse(r.form_snapshot);
  const answers = JSON.parse(r.answers);
  const files = all('SELECT * FROM attachments WHERE request_id = ? ORDER BY id', requestId);
  const ticket = settings.ticket_prefix + String(r.id).padStart(4, '0');
  return {
    sent_at: new Date().toISOString(),
    portal: { name: settings.site_name, url: base },
    request: {
      id: r.id,
      ticket,
      url: `${base}/requests/${r.id}`,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      form: { id: r.form_id, slug: r.form_slug, title: snapshot.title, category: snapshot.category },
      requester: { id: r.user_id, name: r.requester, email: r.requester_email },
      // Both shapes: a list in form order with labels, and a map by question id.
      answers: snapshot.fields
        .filter((f) => f.id in answers)
        .map((f) => ({ id: f.id, label: f.label, type: f.type, value: answers[f.id] })),
      answers_by_id: answers,
      attachments: files.map((a) => ({
        id: a.id,
        field_id: a.field_id,
        name: a.original_name,
        mime: a.mime,
        size: a.size,
        url: attachmentLink(base, r.id, a.id), // works without an account for a week
      })),
    },
  };
}
