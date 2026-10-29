// Shared by every provider module; deliberately imports nothing so the
// modules can be loaded in any order.

// Only ever send people to a path on this site. Browsers treat a leading
// "//" or "/\" as another host, and ignore tabs and newlines inside URLs.
export function safePath(p) {
  const s = String(p || '');
  return /^\/(?![/\\])/.test(s) && !/[\\\x00-\x1f]/.test(s) ? s : null;
}

// A sign-in that failed for a reason worth telling the person (as opposed
// to a bug), shown on the sign-in page.
export class SignInError extends Error {}

// Group values arrive in many shapes: arrays, single strings, DNs
// (memberOf). Normalise to a flat list, adding the CN of any DN so admins
// can type "portal-admins" instead of the full distinguished name.
export function normaliseGroups(value) {
  const out = [];
  for (const v of [].concat(value ?? [])) {
    if (v === null || v === undefined) continue;
    const s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    out.push(s);
    const cn = s.match(/^\s*cn=([^,]+)/i);
    if (cn) out.push(cn[1].trim());
  }
  return out;
}
