import { Router } from 'express';
import { startSession } from '../sessions.js';
import { getProvider, resolveUser, baseUrl, callbackUrl, safePath, SignInError, MODULES } from '../providers/index.js';

// Redirect-based sign-in (OpenID Connect and SAML). LDAP goes through the
// normal password form in routes/public.js.

const router = Router();

function load(req, res, next) {
  const provider = /^\d+$/.test(req.params.id) ? getProvider(Number(req.params.id)) : null;
  if (!provider || !provider.enabled || provider.type === 'ldap') {
    return res.status(404).render('error', { title: 'Sign-in method not found', message: 'It may have been switched off. Ask an administrator.' });
  }
  req.provider = provider;
  next();
}

router.get('/auth/:id/start', load, async (req, res, next) => {
  if (req.user) return res.redirect('/');
  const p = req.provider;
  try {
    if (p.type === 'oidc') await MODULES.oidc.start(req, res, p, callbackUrl(req, p));
    else await MODULES.saml.start(req, res, p, baseUrl(req));
  } catch (err) {
    next(err);
  }
});

// OIDC comes back with a GET; SAML posts. Both end up here.
async function finish(req, res, next) {
  const p = req.provider;
  try {
    const { profile, returnTo } = p.type === 'oidc'
      ? await MODULES.oidc.callback(req, p, callbackUrl(req, p))
      : await MODULES.saml.callback(req, p, baseUrl(req));
    const user = resolveUser(p, profile);
    startSession(req, user.id);
    res.redirect(safePath(returnTo) || '/');
  } catch (err) {
    if (err instanceof SignInError) {
      req.flash(err.message, 'error');
      return res.redirect('/login');
    }
    console.error(`Sign-in via ${p.name} (${p.type}) failed:`, err);
    req.flash(`Signing in with ${p.name} did not work. If this keeps happening, tell an administrator.`, 'error');
    res.redirect('/login');
  }
}
router.get('/auth/:id/callback', load, finish);
router.post('/auth/:id/callback', load, finish);

router.get('/auth/:id/metadata', load, (req, res) => {
  if (req.provider.type !== 'saml') return res.status(404).end();
  res.type('application/xml').send(MODULES.saml.metadata(req.provider, baseUrl(req)));
});

export default router;
