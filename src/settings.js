import { all, run } from './db.js';
import { MAX_UPLOAD_MB } from './config.js';

// Every setting has a default, so a fresh install works with no configuration.
// All of these are editable by administrators on the Settings page.
export const DEFAULTS = {
  // Name and words
  site_name: 'Request Portal',
  tagline: 'Tell us what you need and we will take it from there.',
  welcome_text: 'Pick a category below to find the right form.',
  login_text: '',
  footer_text: '',
  show_credit: '1',
  // Banner
  banner_color: '#2A4BC7',
  banner_image: '', // stored file name under data/uploads/branding
  banner_text_color: '#FFFFFF',
  // Accounts
  allow_registration: '1',
  registration_domains: '', // comma-separated; empty means any domain
  default_role: 'member', // role given to self-registered accounts
  require_login: '0', // '1' hides the whole portal behind sign-in
  // Sessions (see sessions.js), in minutes
  session_idle_minutes: '480', // signed out after this long without a visit
  session_max_minutes: '10080', // and after this long regardless
  // Sign-in methods (the rest live in the auth_providers table)
  password_login: '1', // '0' hides the password form once SSO/LDAP is set up
  public_url: '', // e.g. https://portal.example.com; blank means work it out per request
  // Requests
  max_upload_mb: String(MAX_UPLOAD_MB), // MAX_UPLOAD_MB from the environment is only the starting value
  comments: 'all', // who can add notes: all | staff | off
  ticket_prefix: '#',
  // Outgoing webhook (see webhook.js); blank address means off
  webhook_url: '',
  webhook_secret: '',
  webhook_on_submit: '1',
  webhook_on_status: '1',
  webhook_on_comment: '1',
};

export const ROLE_CHOICES = ['member', 'editor'];
export const COMMENT_CHOICES = {
  all: 'Everyone involved (the requester and editors)',
  staff: 'Editors only',
  off: 'Nobody (notes are switched off)',
};
export const MAX_UPLOAD_CEILING_MB = 512;
// Values are minutes, keyed as strings to match the stored settings.
export const SESSION_IDLE_CHOICES = {
  15: '15 minutes',
  60: '1 hour',
  240: '4 hours',
  480: '8 hours',
  1440: '1 day',
  10080: '1 week',
};
export const SESSION_MAX_CHOICES = {
  480: '8 hours',
  1440: '1 day',
  10080: '1 week',
  43200: '30 days',
  129600: '90 days',
};

// Session limits in milliseconds; the idle limit never exceeds the overall one.
export function sessionLimits(settings) {
  const pick = (value, choices, fallback) => Number(value in choices ? value : fallback) * 60_000;
  const max = pick(settings.session_max_minutes, SESSION_MAX_CHOICES, DEFAULTS.session_max_minutes);
  const idle = pick(settings.session_idle_minutes, SESSION_IDLE_CHOICES, DEFAULTS.session_idle_minutes);
  return { idle: Math.min(idle, max), max };
}

export function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const out = { ...DEFAULTS };
  for (const { key, value } of rows) if (key in DEFAULTS) out[key] = value;
  return out;
}

export function setSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      String(value ?? ''),
    );
  }
}

export function resetSettings() {
  run('DELETE FROM settings');
}

// Normalises free text like "Example.com, @corp.org" to a clean list of
// lowercase domains; anything that is not a domain is dropped.
export function parseDomains(input) {
  const seen = new Set();
  for (const raw of String(input || '').split(/[\s,;]+/)) {
    const d = raw.trim().replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) seen.add(d);
  }
  return [...seen];
}

export function uploadLimitMb(settings) {
  const n = Math.floor(Number(settings.max_upload_mb));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_UPLOAD_CEILING_MB) : MAX_UPLOAD_MB;
}
