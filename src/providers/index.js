import { one, all, run, transaction } from '../db.js';
import { ROLES } from '../auth.js';
import { ROLE_CHOICES, getSettings } from '../settings.js';
import { SignInError } from './common.js';
import * as oidc from './oidc.js';
import * as saml from './saml.js';
import * as ldap from './ldap.js';

export { SignInError, normaliseGroups } from './common.js';

// Each sign-in method is a row in auth_providers with a JSON config. The
// admin form is rendered from `fields` below, so adding a setting to a
// provider means adding it here and reading it in the provider module.
//
// Field shape: { key, label, help, type: text|url|secret|textarea|checkbox|select,
//   required, default, options, placeholder }. Secrets are never echoed back
// into the form; a blank value on save keeps the stored one.

const COMMON_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Okta', help: 'Shown on the sign-in button.' },
  { key: 'auto_create', label: 'Create an account the first time someone signs in', type: 'checkbox', default: '1', help: 'When off, only people who already have an account (matched by email) can sign in this way.' },
  { key: 'default_role', label: 'New accounts start as', type: 'select', options: ROLE_CHOICES, default: 'member' },
  { key: 'admin_group', label: 'Group that makes someone an administrator', type: 'text', placeholder: 'e.g. portal-admins', help: 'Optional. Compared against the groups the provider sends (the claim or attribute above). When either group is set, roles are updated on every sign-in.' },
  { key: 'editor_group', label: 'Group that makes someone an editor', type: 'text', placeholder: 'e.g. portal-editors' },
];

export const TYPES = {
  oidc: {
    label: 'OpenID Connect',
    blurb: 'Single sign-on with Microsoft Entra ID, Okta, Google Workspace, Keycloak, Auth0, Authentik, or any other OpenID Connect provider.',
    presets: oidc.PRESETS,
    fields: [COMMON_FIELDS[0], ...oidc.FIELDS, ...COMMON_FIELDS.slice(1)],
    validate: oidc.validate,
  },
  saml: {
    label: 'SAML 2.0',
    blurb: 'Single sign-on with an identity provider that speaks SAML (Entra ID, Okta, OneLogin, ADFS, Shibboleth, Ping).',
    presets: saml.PRESETS,
    fields: [COMMON_FIELDS[0], ...saml.FIELDS, ...COMMON_FIELDS.slice(1)],
    validate: saml.validate,
  },
  ldap: {
    label: 'LDAP / Active Directory',
    blurb: 'People sign in on the portal with their directory username and password; the portal checks it against your LDAP or Active Directory server.',
    presets: ldap.PRESETS,
    fields: [COMMON_FIELDS[0], ...ldap.FIELDS, ...COMMON_FIELDS.slice(1)],
    validate: ldap.validate,
  },
};

export const MODULES = { oidc, saml, ldap };

// --- Storage -----------------------------------------------------------------

function hydrate(row) {
  if (!row) return null;
  const config = JSON.parse(row.config);
  const defaults = {};
  for (const f of TYPES[row.type].fields) if (f.default !== undefined) defaults[f.key] = f.default;
  return { ...row, enabled: row.enabled === 1, config: { ...defaults, ...config, name: row.name } };
}

export function listProviders() {
  return all('SELECT * FROM auth_providers ORDER BY created_at, id').map(hydrate);
}

export function enabledProviders(type) {
  return listProviders().filter((p) => p.enabled && (!type || p.type === type));
}

export function getProvider(id) {
  return hydrate(one('SELECT * FROM auth_providers WHERE id = ?', id));
}

// Turns a posted admin form into a clean config. Returns { config, error }.
export function buildConfig(type, body, existing) {
  const config = {};
  for (const f of TYPES[type].fields) {
    let v = body[f.key];
    if (f.type === 'checkbox') v = v === '1' ? '1' : '0';
    else if (f.type === 'select') v = f.options.includes(v) ? v : f.default;
    else {
      v = String(v ?? '').trim();
      if (f.type === 'secret' && !v && existing) v = existing.config[f.key] || '';
      if (f.type === 'url' && v && !/^https?:\/\/|^ldaps?:\/\//i.test(v)) return { error: `${f.label} must be a full URL.` };
    }
    if (f.required && !v) return { error: `${f.label} is required.` };
    config[f.key] = v.slice(0, f.type === 'textarea' ? 20000 : 2000);
  }
  const error = TYPES[type].validate?.(config);
  return error ? { error } : { config };
}

export function saveProvider({ id, type, config, enabled }) {
  const json = JSON.stringify(config);
  if (id) {
    run(
      "UPDATE auth_providers SET name = ?, enabled = ?, config = ?, updated_at = datetime('now') WHERE id = ?",
      config.name, enabled ? 1 : 0, json, id,
    );
    return Number(id);
  }
  const r = run('INSERT INTO auth_providers (type, name, enabled, config) VALUES (?, ?, ?, ?)', type, config.name, enabled ? 1 : 0, json);
  return Number(r.lastInsertRowid);
}

export function deleteProvider(id) {
  run('DELETE FROM auth_providers WHERE id = ?', id);
}

// --- Public address ----------------------------------------------------------

// Identity providers redirect back to absolute URLs, so the portal needs to
// know its own address. Admins can pin it under Sign-in methods; otherwise it
// is taken from the request (which needs TRUST_PROXY behind a proxy).
export function baseUrl(req) {
  const pinned = String(getSettings().public_url || '').trim();
  if (pinned) return pinned.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

export function callbackUrl(req, provider) {
  return `${baseUrl(req)}/auth/${provider.id}/callback`;
}

// --- Provisioning ------------------------------------------------------------

// A provider hands back a profile { subject, email, name, groups } after
// verifying the person. This finds or creates the matching account, keeps
// its role in step with the configured groups, and returns the user row.
export function resolveUser(provider, profile) {
  const email = String(profile.email || '').trim().toLowerCase();
  const subject = String(profile.subject || email);
  if (!subject) throw new SignInError('The identity provider did not say who you are.');
  const groups = (profile.groups || []).map((g) => String(g).toLowerCase());
  const mappedRole = roleFromGroups(provider.config, groups);

  return transaction(() => {
    let user = one(
      'SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider_id = ? AND i.subject = ?',
      provider.id, subject,
    );
    if (!user && email) {
      user = one('SELECT * FROM users WHERE email = ?', email);
      if (user) run('INSERT INTO identities (provider_id, user_id, subject) VALUES (?, ?, ?)', provider.id, user.id, subject);
    }
    if (!user) {
      if (provider.config.auto_create !== '1') {
        throw new SignInError(`There is no account for ${email || 'you'} yet. Ask an administrator to add you.`);
      }
      if (!email) throw new SignInError('The identity provider did not send an email address, which the portal needs to create an account.');
      const name = String(profile.name || '').trim() || email.split('@')[0];
      const role = mappedRole || (ROLE_CHOICES.includes(provider.config.default_role) ? provider.config.default_role : 'member');
      const r = run('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)', email, name.slice(0, 120), '', role);
      run('INSERT INTO identities (provider_id, user_id, subject) VALUES (?, ?, ?)', provider.id, Number(r.lastInsertRowid), subject);
      return one('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
    }

    run("UPDATE identities SET last_login = datetime('now') WHERE provider_id = ? AND subject = ?", provider.id, subject);
    if (mappedRole && mappedRole !== user.role) {
      // Never let a group change strip the last administrator.
      const admins = one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;
      if (!(user.role === 'admin' && admins === 1)) {
        run('UPDATE users SET role = ? WHERE id = ?', mappedRole, user.id);
        user.role = mappedRole;
      }
    }
    return user;
  });
}

// Group-to-role mapping only applies when the admin has configured a group;
// then it is authoritative: in the admin group -> admin, in the editor
// group -> editor, in neither -> member.
function roleFromGroups(config, groups) {
  const admin = String(config.admin_group || '').trim().toLowerCase();
  const editor = String(config.editor_group || '').trim().toLowerCase();
  if (!admin && !editor) return null;
  if (admin && groups.includes(admin)) return 'admin';
  if (editor && groups.includes(editor)) return 'editor';
  return 'member';
}

// Only used by templates to describe an account's sign-in sources.
export function identitiesFor(userIds) {
  if (!userIds.length) return new Map();
  const rows = all(
    `SELECT i.user_id, p.name FROM identities i JOIN auth_providers p ON p.id = i.provider_id
      WHERE i.user_id IN (${userIds.map(() => '?').join(',')}) ORDER BY p.name`,
    ...userIds,
  );
  const map = new Map();
  for (const r of rows) map.set(r.user_id, [...(map.get(r.user_id) || []), r.name]);
  return map;
}

export { ROLES };
