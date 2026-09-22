import { Client, escapeFilter } from 'ldapts';
import { SignInError, normaliseGroups } from './common.js';

// LDAP / Active Directory. Unlike the redirect-based providers, the person
// types their directory username and password into the portal's own sign-in
// form; the portal binds as a service account, finds their entry, then binds
// as them to check the password.

export const PRESETS = [
  { key: 'ad', label: 'Active Directory', values: {
      name: 'Windows account',
      user_filter: '(&(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(|(sAMAccountName={{username}})(userPrincipalName={{username}})(mail={{username}})))',
      email_attribute: 'mail', name_attribute: 'displayName', groups_attribute: 'memberOf',
    },
    note: 'Use ldaps://dc.example.com:636 (or ldap:// with StartTLS). The bind account needs read access to users. The filter above also skips disabled accounts. For roles, paste a group name such as "Portal Admins" (its CN) or the full distinguished name.' },
  { key: 'openldap', label: 'OpenLDAP / FreeIPA / other', values: {
      name: 'Directory account',
      user_filter: '(|(uid={{username}})(mail={{username}}))',
      email_attribute: 'mail', name_attribute: 'cn', groups_attribute: 'memberOf',
    },
    note: 'memberOf needs the memberof overlay on OpenLDAP; FreeIPA and 389 Directory Server provide it out of the box.' },
];

export const FIELDS = [
  { key: 'url', label: 'Server URL', type: 'url', required: true, placeholder: 'ldaps://ldap.example.com:636', help: 'ldaps:// for TLS, or ldap:// with StartTLS below. Plain ldap:// without StartTLS sends passwords unencrypted; only use it on a trusted network.' },
  { key: 'start_tls', label: 'Use StartTLS (for ldap:// URLs)', type: 'checkbox', default: '0' },
  { key: 'skip_cert_check', label: 'Skip certificate verification (self-signed servers)', type: 'checkbox', default: '0' },
  { key: 'bind_dn', label: 'Bind DN', type: 'text', required: true, placeholder: 'cn=portal,ou=service,dc=example,dc=com', help: 'A read-only service account used to look people up. Active Directory also accepts user@domain here.' },
  { key: 'bind_password', label: 'Bind password', type: 'secret', help: 'When editing, leave blank to keep the current password.' },
  { key: 'base_dn', label: 'Search base', type: 'text', required: true, placeholder: 'ou=people,dc=example,dc=com' },
  { key: 'user_filter', label: 'User filter', type: 'text', required: true, default: '(|(uid={{username}})(mail={{username}}))', help: '{{username}} is replaced with what the person typed (escaped).' },
  { key: 'email_attribute', label: 'Email attribute', type: 'text', default: 'mail' },
  { key: 'name_attribute', label: 'Display name attribute', type: 'text', default: 'cn' },
  { key: 'groups_attribute', label: 'Groups attribute', type: 'text', default: 'memberOf', help: 'Group DNs are matched by their full DN or just their CN.' },
];

export function validate(config) {
  if (!/^ldaps?:\/\//i.test(config.url)) return 'Server URL must start with ldap:// or ldaps://.';
  if (!config.user_filter.includes('{{username}}')) return 'User filter must contain {{username}}.';
  if (!/^\(.*\)$/.test(config.user_filter)) return 'User filter must be wrapped in parentheses.';
  return null;
}

function connect(config) {
  const tlsOptions = config.skip_cert_check === '1' ? { rejectUnauthorized: false } : undefined;
  return new Client({ url: config.url, connectTimeout: 5000, timeout: 10000, tlsOptions });
}

async function withClient(config, fn) {
  const client = connect(config);
  try {
    if (config.start_tls === '1' && /^ldap:\/\//i.test(config.url)) {
      await client.startTLS(config.skip_cert_check === '1' ? { rejectUnauthorized: false } : {});
    }
    return await fn(client);
  } finally {
    await client.unbind().catch(() => {});
  }
}

const str = (v) => (Array.isArray(v) ? v[0] : v) ?? '';
const attrOf = (entry, name) => {
  if (!name) return '';
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(str(entry[key])) : '';
};

// Finds the entry for a username; null when nobody matches.
async function lookup(client, config, username) {
  await client.bind(config.bind_dn, config.bind_password || '');
  const filter = config.user_filter.replaceAll('{{username}}', escapeFilter`${username}`);
  const attributes = ['dn', config.email_attribute, config.name_attribute, config.groups_attribute, 'givenName', 'sn', 'uid', 'sAMAccountName', 'userPrincipalName'].filter(Boolean);
  const { searchEntries } = await client.search(config.base_dn, { scope: 'sub', filter, attributes, sizeLimit: 2 });
  if (searchEntries.length > 1) throw new SignInError('That username matches more than one directory entry. Ask an administrator to tighten the user filter.');
  return searchEntries[0] || null;
}

function toProfile(config, entry) {
  const email = attrOf(entry, config.email_attribute) || attrOf(entry, 'userPrincipalName');
  const name = attrOf(entry, config.name_attribute) || [attrOf(entry, 'givenName'), attrOf(entry, 'sn')].filter(Boolean).join(' ');
  const groupsKey = Object.keys(entry).find((k) => k.toLowerCase() === String(config.groups_attribute || '').toLowerCase());
  return {
    subject: entry.dn,
    email: /@/.test(email) ? email : '',
    name,
    groups: groupsKey ? normaliseGroups(entry[groupsKey]) : [],
  };
}

// Returns a profile when the username and password check out, null when
// the person is not in this directory or the password is wrong. Throws
// when the server cannot be reached.
export async function authenticate(provider, username, password) {
  const { config } = provider;
  if (!username || !password) return null;
  return withClient(config, async (client) => {
    const entry = await lookup(client, config, username);
    if (!entry) return null;
    try {
      await client.bind(entry.dn, password);
    } catch {
      return null;
    }
    return toProfile(config, entry);
  });
}

// Used by the admin form's "Test" button. Never signs anyone in.
export async function test(config, username, password) {
  return withClient(config, async (client) => {
    const entry = await lookup(client, config, username);
    if (!entry) return { ok: false, message: `Connected and bound as ${config.bind_dn}, but no entry matched "${username}" under ${config.base_dn}.` };
    if (password) {
      try {
        await client.bind(entry.dn, password);
      } catch {
        return { ok: false, message: `Found ${entry.dn}, but the password was rejected.` };
      }
    }
    const profile = toProfile(config, entry);
    return {
      ok: true,
      message: `Found ${entry.dn}${password ? ' and the password is correct' : ''}. Email: ${profile.email || '(none)'}. Name: ${profile.name || '(none)'}. Groups: ${profile.groups.filter((g) => !/=/.test(g)).join(', ') || '(none)'}.`,
    };
  });
}
