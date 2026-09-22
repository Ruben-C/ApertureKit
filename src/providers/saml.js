import { SAML } from '@node-saml/node-saml';
import { SignInError, normaliseGroups } from './common.js';

// SAML 2.0, SP-initiated (and IdP-initiated) sign-in via @node-saml/node-saml.
// The portal is the service provider; the admin pastes the IdP's sign-on
// URL and certificate, and gives the IdP our metadata URL in return.

export const PRESETS = [
  { key: 'entra', label: 'Microsoft Entra ID (Azure AD)', values: { name: 'Microsoft', groups_attribute: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', email_attribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', name_attribute: 'http://schemas.microsoft.com/identity/claims/displayname' },
    note: 'Create an Enterprise application with SAML single sign-on. Set the Identifier (Entity ID) and Reply URL (ACS) to the values shown after saving, then copy the Login URL and Certificate (Base64) from the SAML certificates section into this form.' },
  { key: 'okta', label: 'Okta', values: { name: 'Okta', groups_attribute: 'groups', email_attribute: 'email', name_attribute: 'displayName' },
    note: 'Create a SAML 2.0 app integration. Use the ACS URL and Entity ID shown after saving. Add attribute statements named email and displayName, and a group attribute statement named groups if you want group-based roles.' },
  { key: 'adfs', label: 'AD FS', values: { name: 'Windows sign-in', groups_attribute: 'http://schemas.xmlsoap.org/claims/Group', email_attribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', name_attribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name' } },
  { key: 'generic', label: 'Other SAML 2.0 provider', values: { name: 'Single sign-on', groups_attribute: 'groups', email_attribute: 'email', name_attribute: 'displayName' } },
];

export const FIELDS = [
  { key: 'entry_point', label: 'IdP sign-on URL', type: 'url', required: true, placeholder: 'https://idp.example.com/sso/saml', help: 'Also called the SSO URL, Login URL, or HTTP-Redirect binding location.' },
  { key: 'idp_issuer', label: 'IdP entity ID', type: 'text', placeholder: 'https://idp.example.com/metadata', help: 'Optional. When set, responses from any other issuer are rejected.' },
  { key: 'idp_cert', label: 'IdP signing certificate', type: 'textarea', required: true, placeholder: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----', help: 'PEM or bare Base64. Several certificates can be pasted one after another for key rollover.' },
  { key: 'sp_entity_id', label: 'Our entity ID', type: 'text', placeholder: 'Leave blank to use the metadata URL', help: 'The identifier the IdP knows this portal by. Blank uses the metadata URL shown after saving.' },
  { key: 'email_attribute', label: 'Email attribute', type: 'text', default: 'email', help: 'Falls back to mail, emailaddress, and finally the NameID when it looks like an email.' },
  { key: 'name_attribute', label: 'Display name attribute', type: 'text', default: 'displayName', help: 'Falls back to cn, name, and first + last name attributes.' },
  { key: 'groups_attribute', label: 'Groups attribute', type: 'text', default: 'groups', help: 'Attribute holding group names, for the role mapping below.' },
  { key: 'want_assertions_signed', label: 'Require signed assertions (recommended)', type: 'checkbox', default: '1', help: 'Turn off only if your IdP signs the whole response but not the assertion inside it.' },
];

export function validate(config) {
  if (!parseCerts(config.idp_cert).length) return 'IdP signing certificate does not look like a certificate.';
  return null;
}

// Accepts PEM blocks or bare base64 and returns the list of certificates.
export function parseCerts(text) {
  const pems = String(text || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (pems) return pems.map((p) => p.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const bare = String(text || '').replace(/\s+/g, '');
  return /^[A-Za-z0-9+/=]{100,}$/.test(bare) ? [bare] : [];
}

export function entityId(provider, base) {
  return provider.config.sp_entity_id || `${base}/auth/${provider.id}/metadata`;
}

// One SAML instance per provider version; node-saml keeps the outstanding
// request IDs (for InResponseTo checks) in memory on the instance.
const instances = new Map();
function instance(provider, base) {
  const key = `${provider.id}:${base}:${JSON.stringify(provider.config)}`;
  if (instances.has(key)) return instances.get(key);
  if (instances.size > 50) instances.clear();
  const { config } = provider;
  const saml = new SAML({
    callbackUrl: `${base}/auth/${provider.id}/callback`,
    entryPoint: config.entry_point,
    issuer: entityId(provider, base),
    idpCert: parseCerts(config.idp_cert),
    idpIssuer: config.idp_issuer || undefined,
    audience: entityId(provider, base),
    wantAssertionsSigned: config.want_assertions_signed !== '0',
    wantAuthnResponseSigned: config.want_assertions_signed === '0',
    validateInResponseTo: 'ifPresent',
    identifierFormat: null,
    acceptedClockSkewMs: 2 * 60 * 1000,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  });
  instances.set(key, saml);
  return saml;
}

export function metadata(provider, base) {
  return instance(provider, base).generateServiceProviderMetadata(null, null);
}

export async function start(req, res, provider, base) {
  // The IdP posts back cross-site, where a SameSite cookie is not sent, so
  // the return path rides along in RelayState rather than the session.
  const returnTo = safePath(req.session.returnTo);
  delete req.session.returnTo;
  const url = await instance(provider, base).getAuthorizeUrlAsync(returnTo || '', req.get('host'), {});
  res.redirect(url);
}

// Returns { profile, returnTo }.
export async function callback(req, provider, base) {
  const { config } = provider;
  let result;
  try {
    result = await instance(provider, base).validatePostResponseAsync({
      SAMLResponse: String(req.body.SAMLResponse || ''),
      RelayState: String(req.body.RelayState || ''),
    });
  } catch (err) {
    throw new SignInError(`${provider.name} sent a response the portal could not verify: ${err.message}`);
  }
  const p = result.profile;
  if (!p || result.loggedOut) throw new SignInError('The identity provider did not sign you in.');

  const attr = (...names) => {
    for (const n of names.filter(Boolean)) {
      const v = p[n];
      if (v !== undefined && v !== null && v !== '') return Array.isArray(v) ? v[0] : v;
    }
    return '';
  };
  const nameID = String(p.nameID || '');
  const email = String(attr(config.email_attribute, 'email', 'mail', 'emailaddress',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3') || (/@/.test(nameID) ? nameID : ''));
  const first = attr('givenName', 'firstName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42');
  const last = attr('sn', 'surname', 'lastName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4');
  const name = String(attr(config.name_attribute, 'displayName', 'cn', 'name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') || [first, last].filter(Boolean).join(' '));
  const groups = config.groups_attribute ? normaliseGroups(p[config.groups_attribute]) : [];
  return {
    profile: { subject: nameID || email, email: /@/.test(email) ? email : '', name, groups },
    returnTo: safePath(req.body.RelayState),
  };
}

// Only ever send people to a path on this site.
export function safePath(p) {
  const s = String(p || '');
  return /^\/(?!\/)/.test(s) ? s : null;
}
