# Changelog

Notable changes to PortalCake. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
