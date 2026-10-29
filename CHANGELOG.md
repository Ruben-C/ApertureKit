# Changelog

Notable changes to ApertureKit. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Failed sign-ins are rate limited.** After 5 wrong passwords for one
  account from one address within 15 minutes, that address has to wait before
  trying that account again. Wider limits catch guessing at one account from
  many addresses (25) and one address trying many accounts (50). Someone
  elsewhere cannot lock the real owner out with the tight limit, and unknown
  accounts are limited the same way, so a refusal says nothing about who has
  an account. Applies to portal passwords and LDAP alike.
- **Built-in HTTPS.** Set `COMPOSE_PROFILES=https`, `DOMAIN` and
  `TRUST_PROXY=1` in `.env` and Compose also starts Caddy, which fetches a
  Let's Encrypt certificate and serves the portal on ports 80 and 443.
- **One-command Azure deployment.** `deploy/azure/deploy.sh <name>` creates
  an Ubuntu VM with the Azure CLI, installs Docker on first boot, and serves
  the portal at `https://<name>.<region>.cloudapp.azure.com`.

### Changed

- **Portal passwords are hashed with Argon2id** (64 MiB, 3 passes, 4 lanes,
  the settings RFC 9106 recommends) instead of scrypt. Existing passwords keep
  working and are upgraded the next time each person signs in; nobody has to
  reset anything.
- A failed sign-in now takes the same time whether or not the account exists
  or has a password, so the sign-in form no longer hints at which emails are
  registered.
- **Requires Node.js 24.7 or newer** for the built-in Argon2. The Docker image
  now uses `node:24-alpine`; rebuild it as usual with
  `docker compose up -d --build`.

## [0.5.0] - 2026-10-22

### Added

- **Sessions time out.** Sign-ins are now tracked on the server. People are
  signed out after 8 hours without opening a page, and after a week no
  matter what. Change both under Settings → Accounts. Someone whose session
  ran out is told so on the sign-in page and sent back to where they were.
- **Sign out everywhere.** The account menu has "Sign out on all devices".
  On the People page, administrators can see when each person was last
  active and how many sessions they have, and can sign anyone out.
- Changing someone's password signs them out on every other device. Removing
  a person ends their sessions at once.

### Changed

- Signing out now ends the session on the server, so a copied cookie stops
  working too. **Everyone is signed out once after upgrading**, because
  sign-ins from earlier versions were not tracked.

### Fixed

- The "Sign in" button in the top bar had dark text on the accent color.
- On admin and form-builder pages, the top bar and footer now widen with the
  content instead of sitting narrower than it.
- On phones, "Create account" no longer wraps onto two lines in the top bar.
  On very narrow screens it is hidden; the sign-in page still links to it.
- The setup page no longer shows navigation and sign-in links that only led
  back to setup.

## [0.4.0] - 2026-09-23

### Changed

- **Renamed PortalCake to ApertureKit.** The package, Docker image, container
  and volume names, the footer credit, and the webhook `User-Agent` follow
  suit. Two things to update on an existing install:
  - The webhook event header is now `X-ApertureKit-Event` (was
    `X-PortalCake-Event`). Adjust any n8n workflow that reads it.
  - The compose service and named volume are now `aperturekit` and
    `aperturekit_data`. Data in the old `portalcake_data` volume is not moved;
    either keep the old volume name in your compose override or copy it
    across with the backup/restore commands in the README.

## [0.3.0] - 2026-09-22

### Changed

- **Interface rebuilt on one design system.** Layered surfaces (page, card,
  raised menus and dialogs) with a real elevation scale instead of flat
  boxes; a sticky, translucent top bar with an account menu (avatar with
  initials, email, role, sign out) and a collapsing menu on phones; page
  headers with breadcrumbs, a one-line summary, and the actions on the
  right; cross-page view transitions where the browser supports them.
- **Home page** opens with the banner and a search box that filters the
  forms as you type. Categories are a grid of cards with a colored tile,
  description and form count. Signed-in people see their open requests and
  the three most recent ones above the directory.
- **Category page** lists forms as cards; the request form gets a sidebar
  ("About this form", "Need help?", edit link for editors), a sticky action
  bar, boxed answer choices, and a summary of errors that links to each
  field.
- **Queue and My requests**: Everyone / Mine segmented control, status
  filters with colored dots and counts, a live filter box, relative dates,
  requester avatars, and status chips drawn as dot-on-tint rather than
  white-on-color.
- **Request page** is two columns: answers and a notes timeline (avatars,
  composer at the bottom) on the left; status control and details
  (requester, category, dates, answer and file counts) in a sticky sidebar.
- **Editor**: each category is a card with its forms; creating and editing
  categories happens in dialogs. The builder gets a wider layout, a "Form
  settings" card, and the save button in the page header.
- **Admin** area has a left-hand navigation (Settings with its sections,
  People, Sign-in methods, plus shortcuts to editing). Settings shows one
  section at a time with a sticky save bar that says when there are unsaved
  changes and warns before leaving. People get avatars, stacked
  name/email, and an "Add a person" dialog. Sign-in methods get icons per
  type and a separate "Remove this method" zone.
- **Sign-in, registration, setup and error pages** are centered cards with
  the portal mark; setup shows the three first-run steps.
- Flash messages are toasts (top right, auto-dismiss except errors);
  buttons show a spinner once a form is on its way; reduced motion is
  respected throughout.

### Fixed

- Number inputs on request forms rendered a literal `step=&#34;any&#34;`
  attribute instead of accepting decimals.

## [0.2.0] - 2026-09-22

### Added

- **Outgoing webhook.** Settings → Webhook takes one address and the portal
  POSTs a JSON event there when a request is sent (`request.submitted`),
  changes status (`request.status_changed`), or gets a note
  (`comment.added`). Each event can be switched on or off. Built for the
  n8n Webhook node; any endpoint that accepts JSON works.
- Optional shared secret, sent as `X-Webhook-Secret` (for n8n Header Auth)
  together with an HMAC-SHA256 body signature in `X-Webhook-Signature`.
- "Save and send a test event" button on the Settings page, which delivers a
  `webhook.test` event and reports whether the endpoint answered.
- Attachments in webhook payloads carry signed download links that work
  without an account for seven days, so a workflow can fetch the files.
  Links are tied to the session secret; rotating it invalidates them.

### Changed

- Delivery is fire-and-forget: the request is saved first, the POST has a
  10-second timeout, and a failure is logged rather than shown to the member.

## [0.1.2] and earlier

No changelog was kept before 0.2.0.
