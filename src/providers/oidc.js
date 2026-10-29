import crypto from 'node:crypto';
import { SignInError, normaliseGroups, safePath } from './common.js';

// OpenID Connect, authorization-code flow with PKCE, implemented on fetch and
// node:crypto. Works with any provider that publishes
// /.well-known/openid-configuration.

export const PRESETS = [
  { key: 'entra', label: 'Microsoft Entra ID (Azure AD)', values: { name: 'Microsoft', issuer: 'https://login.microsoftonline.com/{tenant-id}/v2.0', groups_claim: 'groups' },
    note: 'Register an app under Entra ID → App registrations, add a Web redirect URI (shown after saving), and create a client secret. To map groups to roles, add a "groups" claim to the token; Entra sends group object IDs, so paste those IDs as the group names below. To link people to portal accounts that already exist, add the optional claims "email" and "xms_edov" to the ID token.' },
  { key: 'okta', label: 'Okta', values: { name: 'Okta', issuer: 'https://{your-org}.okta.com', groups_claim: 'groups' },
    note: 'Create a Web application in Okta with the redirect URI shown after saving. Add a "groups" claim to the ID token under Security → API → Authorization Servers if you want group-based roles.' },
  { key: 'google', label: 'Google Workspace', values: { name: 'Google', issuer: 'https://accounts.google.com', groups_claim: '' },
    note: 'Create OAuth credentials (Web application) in Google Cloud Console. Google does not send groups, so roles come from "New accounts start as" and the People page.' },
  { key: 'keycloak', label: 'Keycloak', values: { name: 'Keycloak', issuer: 'https://{host}/realms/{realm}', groups_claim: 'groups' } },
  { key: 'auth0', label: 'Auth0', values: { name: 'Auth0', issuer: 'https://{tenant}.auth0.com/', groups_claim: '' } },
  { key: 'authentik', label: 'Authentik', values: { name: 'Authentik', issuer: 'https://{host}/application/o/{slug}/', groups_claim: 'groups' } },
  { key: 'generic', label: 'Other OpenID Connect provider', values: { name: 'Single sign-on', groups_claim: 'groups' } },
];

export const FIELDS = [
  { key: 'issuer', label: 'Issuer URL', type: 'url', required: true, placeholder: 'https://login.example.com', help: 'The portal reads /.well-known/openid-configuration under this address to find everything else.' },
  { key: 'client_id', label: 'Client ID', type: 'text', required: true },
  { key: 'client_secret', label: 'Client secret', type: 'secret', help: 'Leave blank for a public client using PKCE only. When editing, leave blank to keep the current secret.' },
  { key: 'scopes', label: 'Scopes', type: 'text', default: 'openid profile email', help: 'Space-separated. Add "groups" or "offline_access" if your provider needs them.' },
  { key: 'email_claim', label: 'Email claim', type: 'text', default: 'email', help: 'Claim holding the email address. Falls back to preferred_username and upn for new accounts. An existing portal account is only linked when the provider marks the address verified (email_verified, or xms_edov for Entra ID).' },
  { key: 'groups_claim', label: 'Groups claim', type: 'text', default: 'groups', help: 'Claim holding group names, for the role mapping below. Leave blank if your provider does not send one.' },
];

export function validate(config) {
  try {
    const u = new URL(config.issuer);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return 'Issuer URL must use https.';
  } catch {
    return 'Issuer URL is not a valid URL.';
  }
  if (!/\bopenid\b/.test(config.scopes)) return 'Scopes must include "openid".';
  return null;
}

// --- Discovery and keys, cached per issuer -----------------------------------

const discovery = new Map(); // issuer -> { at, doc }
const jwks = new Map(); // jwks_uri -> { at, keys }
const TTL = 60 * 60 * 1000;

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

export async function discover(issuer) {
  const key = issuer.replace(/\/+$/, '');
  const hit = discovery.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.doc;
  const doc = await getJson(key + '/.well-known/openid-configuration');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'issuer']) {
    if (!doc[k]) throw new Error(`Discovery document is missing ${k}`);
  }
  discovery.set(key, { at: Date.now(), doc });
  return doc;
}

async function signingKey(jwksUri, kid, alg) {
  const load = async () => {
    const doc = await getJson(jwksUri);
    jwks.set(jwksUri, { at: Date.now(), keys: doc.keys || [] });
    return doc.keys || [];
  };
  const hit = jwks.get(jwksUri);
  let keys = hit && Date.now() - hit.at < TTL ? hit.keys : await load();
  const pick = () => keys.find((k) => (kid ? k.kid === kid : true) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg));
  let jwk = pick();
  if (!jwk && hit) { keys = await load(); jwk = pick(); } // key rotated since we cached
  if (!jwk) throw new Error('No matching signing key in JWKS');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

// --- JWT ---------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

const ALGS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
  PS384: { hash: 'sha384', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 },
  PS512: { hash: 'sha512', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'sha384', dsaEncoding: 'ieee-p1363' },
  ES512: { hash: 'sha512', dsaEncoding: 'ieee-p1363' },
  EdDSA: { hash: null },
};

export async function verifyIdToken(token, { issuer, clientId, nonce, jwksUri }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('ID token is not a JWT');
  const header = JSON.parse(fromB64url(parts[0]));
  const claims = JSON.parse(fromB64url(parts[1]));
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`Unsupported token algorithm ${header.alg}`);

  const key = await signingKey(jwksUri, header.kid, header.alg);
  const { hash, ...opts } = alg;
  const ok = crypto.verify(hash, Buffer.from(parts[0] + '.' + parts[1]), { key, ...opts }, fromB64url(parts[2]));
  if (!ok) throw new Error('ID token signature is invalid');

  const now = Math.floor(Date.now() / 1000);
  const skew = 120;
  if (claims.iss !== issuer) throw new Error('ID token issuer does not match');
  const aud = [].concat(claims.aud);
  if (!aud.includes(clientId)) throw new Error('ID token audience does not match');
  if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw new Error('ID token authorized party does not match');
  if (typeof claims.exp !== 'number' || claims.exp < now - skew) throw new Error('ID token has expired');
  if (typeof claims.iat === 'number' && claims.iat > now + skew) throw new Error('ID token is from the future');
  if (nonce && claims.nonce !== nonce) throw new Error('ID token nonce does not match');
  if (!claims.sub) throw new Error('ID token has no subject');
  return claims;
}

// --- Flow --------------------------------------------------------------------

export async function start(req, res, provider, callbackUrl) {
  const { config } = provider;
  const doc = await discover(config.issuer);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  req.session.oidc = { id: provider.id, state, nonce, verifier, returnTo: safePath(req.session.returnTo) };
  delete req.session.returnTo;

  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.client_id);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('scope', config.scopes || 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
}

// Returns { profile, returnTo }.
export async function callback(req, provider, callbackUrl) {
  const { config } = provider;
  const pending = req.session.oidc;
  delete req.session.oidc;
  if (!pending || pending.id !== provider.id) throw new SignInError('Your sign-in attempt expired. Try again.');
  if (req.query.error) throw new SignInError(`The identity provider refused: ${req.query.error_description || req.query.error}`);
  if (!req.query.code || req.query.state !== pending.state) throw new SignInError('The sign-in response did not match the request. Try again.');

  const doc = await discover(config.issuer);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(req.query.code),
    redirect_uri: callbackUrl,
    code_verifier: pending.verifier,
    client_id: config.client_id,
  });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (config.client_secret) {
    headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(config.client_id)}:${encodeURIComponent(config.client_secret)}`).toString('base64');
  }
  const tokenRes = await fetch(doc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.id_token) {
    throw new SignInError(`Could not get a token from ${provider.name}: ${tokens.error_description || tokens.error || tokenRes.status}`);
  }

  const claims = await verifyIdToken(tokens.id_token, {
    issuer: doc.issuer, clientId: config.client_id, nonce: pending.nonce, jwksUri: doc.jwks_uri,
  });

  // Some providers keep email and groups out of the ID token; userinfo has them.
  let extra = {};
  const emailClaim = config.email_claim || 'email';
  if (doc.userinfo_endpoint && tokens.access_token && (!claims[emailClaim] || (config.groups_claim && !claims[config.groups_claim]))) {
    extra = await getJson(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } }).catch(() => ({}));
    if (extra.sub && extra.sub !== claims.sub) extra = {};
  }
  const c = { ...extra, ...claims };
  // preferred_username and upn are only a fallback for naming new accounts;
  // neither is a confirmed address, so they never link to an existing one.
  const claimed = c[emailClaim] || c.email || '';
  const email = claimed || c.preferred_username || c.upn || '';
  // email_verified is the standard claim; Entra ID sends xms_edov instead
  // (as an optional claim) when the address is on a verified domain.
  const emailVerified = !!claimed && [c.email_verified, c.xms_edov].some((v) => v === true || v === 'true' || v === 1 || v === '1');
  const name = c.name || [c.given_name, c.family_name].filter(Boolean).join(' ') || c.preferred_username || '';
  const groups = config.groups_claim ? normaliseGroups(c[config.groups_claim]) : [];
  return {
    profile: { subject: claims.sub, email: /@/.test(email) ? email : '', emailVerified, name, groups },
    returnTo: safePath(pending.returnTo),
  };
}
