import { Router } from 'express';
import path from 'node:path';
import { one, all, run } from '../db.js';
import { requireLogin, requireRole } from '../auth.js';
import { STATUS } from '../status.js';
import { ATTACHMENTS_DIR } from '../uploads.js';
import { notify, isSignedFileLink, verifyAttachmentToken } from '../webhook.js';

const router = Router();

const actor = (req) => ({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role });

// A member sees their own requests; editors see everyone's.
router.get('/requests', requireLogin, (req, res) => {
  const isEditor = res.locals.can('editor');
  const status = STATUS[req.query.status] ? req.query.status : null;
  const mine = !isEditor || req.query.mine === '1';
  const where = [];
  const params = [];
  if (mine) { where.push('r.user_id = ?'); params.push(req.user.id); }
  if (status) { where.push('r.status = ?'); params.push(status); }
  const requests = all(
    `SELECT r.id, r.status, r.created_at, r.updated_at, r.form_snapshot, u.name AS requester
       FROM requests r JOIN users u ON u.id = r.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC LIMIT 500`,
    ...params,
  ).map((r) => ({ ...r, snapshot: JSON.parse(r.form_snapshot) }));
  const counts = Object.fromEntries(
    all(`SELECT status, COUNT(*) AS n FROM requests ${mine ? 'WHERE user_id = ?' : ''} GROUP BY status`, ...(mine ? [req.user.id] : []))
      .map((r) => [r.status, r.n]),
  );
  res.render('requests', { title: mine ? 'My requests' : 'All requests', requests, status, mine, isEditor, counts });
});

router.get('/requests/:id', requireLogin, (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  const comments = all(
    'SELECT c.*, u.name AS author, u.role AS author_role FROM comments c JOIN users u ON u.id = c.user_id WHERE c.request_id = ? ORDER BY c.created_at',
    request.id,
  );
  const attachments = all('SELECT * FROM attachments WHERE request_id = ?', request.id);
  res.render('request', {
    title: `Request ${res.locals.ticket(request.id)}`,
    request,
    comments,
    attachments: Object.groupBy(attachments, (a) => a.field_id),
    justSubmitted: req.query.submitted === '1',
    canComment: canComment(res),
  });
});

router.post('/requests/:id/comments', requireLogin, (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  if (!canComment(res)) {
    return res.status(403).render('error', { title: 'Notes are off', message: 'Notes cannot be added to requests right now.' });
  }
  const body = String(req.body.body || '').trim().slice(0, 5000);
  if (body) {
    const r = run('INSERT INTO comments (request_id, user_id, body) VALUES (?, ?, ?)', request.id, req.user.id, body);
    run("UPDATE requests SET updated_at = datetime('now') WHERE id = ?", request.id);
    notify(req, 'comment.added', request.id, { comment: { id: Number(r.lastInsertRowid), body, author: actor(req) } });
  }
  res.redirect(`/requests/${request.id}#comments`);
});

router.post('/requests/:id/status', requireRole('editor'), (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  const status = req.body.status;
  if (STATUS[status] && status !== request.status) {
    run("UPDATE requests SET status = ?, updated_at = datetime('now') WHERE id = ?", status, request.id);
    notify(req, 'request.status_changed', request.id, { previous_status: request.status, changed_by: actor(req) });
    req.flash(`Marked as ${STATUS[status].toLowerCase()}.`, 'success');
  }
  res.redirect(`/requests/${request.id}`);
});

// Webhook payloads carry signed links, so an automation tool can fetch a
// file with no account; everyone else needs to be signed in and involved.
router.get('/requests/:id/files/:attachmentId', (req, res, next) => {
  if (!isSignedFileLink(req)) return next();
  if (!verifyAttachmentToken(req.query.token, req.params.id, req.params.attachmentId)) {
    return res.status(403).render('error', { title: 'Link expired', message: 'This file link is no longer valid.' });
  }
  sendAttachment(req, res, req.params.id);
}, requireLogin, (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  sendAttachment(req, res, request.id);
});

function sendAttachment(req, res, requestId) {
  const file = one('SELECT * FROM attachments WHERE id = ? AND request_id = ?', req.params.attachmentId, requestId);
  if (!file) return res.status(404).render('error', { title: 'File not found', message: 'This attachment no longer exists.' });
  res.download(path.join(ATTACHMENTS_DIR, file.stored_name), file.original_name);
}

// The "who can add notes" setting: everyone involved, editors only, or nobody.
function canComment(res) {
  const policy = res.locals.settings.comments;
  if (policy === 'off') return false;
  if (policy === 'staff') return res.locals.can('editor');
  return true;
}

function loadRequest(req, res) {
  const request = one(
    'SELECT r.*, u.name AS requester, u.email AS requester_email FROM requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?',
    req.params.id,
  );
  if (!request || (request.user_id !== req.user.id && !res.locals.can('editor'))) {
    res.status(404).render('error', { title: 'Request not found', message: 'It may belong to someone else or have been removed.' });
    return null;
  }
  request.answers = JSON.parse(request.answers);
  request.snapshot = JSON.parse(request.form_snapshot);
  return request;
}

export default router;
