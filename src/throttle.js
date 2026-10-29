// Slows down password guessing on the sign-in form. Failed attempts are
// counted in memory over a sliding window at three levels: one address trying
// one account (tight, so someone elsewhere cannot lock the owner out), one
// account from anywhere (guessing spread over many addresses), and one
// address across all accounts (password spraying). Once any count reaches its
// limit, attempts are refused until its oldest failure ages out.
//
// Each attempt counts as a failure the moment it starts, before any password
// work, so a burst of parallel requests cannot slip past the limit; a
// successful sign-in takes its attempt back. Unknown accounts are counted the
// same as real ones, so a refusal reveals nothing. The counts live in this
// process and start over when it restarts.

const WINDOW_MS = 15 * 60_000;
const LIMITS = { pair: 5, account: 25, ip: 50 };
// Bounds memory if someone sprays many addresses or account names.
const MAX_KEYS = 50_000;

const failures = new Map(); // key -> timestamps of recent failures, oldest first

function keysFor(ip, account) {
  const who = String(account ?? '').trim().toLowerCase().slice(0, 320);
  const from = String(ip ?? '');
  return [['pair', `p:${from}|${who}`], ['account', `a:${who}`], ['ip', `i:${from}`]];
}

function recent(key, now) {
  const list = failures.get(key);
  if (!list) return [];
  while (list.length && list[0] <= now - WINDOW_MS) list.shift();
  if (!list.length) failures.delete(key);
  return list;
}

// Starts a sign-in attempt. Returns the milliseconds until this address may
// try this account again, or 0 after counting the attempt so it can go ahead.
export function beginAttempt(ip, account, now = Date.now()) {
  const keys = keysFor(ip, account);
  let wait = 0;
  for (const [kind, key] of keys) {
    const list = recent(key, now);
    const limit = LIMITS[kind];
    if (list.length >= limit) wait = Math.max(wait, list[list.length - limit] + WINDOW_MS - now);
  }
  if (wait) return wait;
  for (const [kind, key] of keys) {
    const list = recent(key, now);
    list.push(now);
    // Only the newest `limit` failures matter for when the block lifts.
    if (list.length > LIMITS[kind]) list.splice(0, list.length - LIMITS[kind]);
    failures.delete(key);
    failures.set(key, list);
  }
  if (failures.size > MAX_KEYS) {
    for (const key of failures.keys()) recent(key, now);
    // Still too many: forget the least recently failed keys.
    for (const key of failures.keys()) {
      if (failures.size <= MAX_KEYS) break;
      failures.delete(key);
    }
  }
  return 0;
}

// The attempt begun at `startedAt` succeeded: clear that account's counts and
// take this attempt back from the address's count across accounts.
export function attemptSucceeded(ip, account, startedAt) {
  for (const [kind, key] of keysFor(ip, account)) {
    if (kind !== 'ip') { failures.delete(key); continue; }
    const list = failures.get(key);
    const i = list ? list.lastIndexOf(startedAt) : -1;
    if (i >= 0) list.splice(i, 1);
    if (list && !list.length) failures.delete(key);
  }
}

export function resetThrottle() {
  failures.clear();
}
