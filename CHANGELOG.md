# Changelog

Notable changes to PortalCake. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
