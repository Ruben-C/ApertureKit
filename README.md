# PortalCake

A self-hosted request portal. Editors build categories and request forms;
members pick a form, send a request, and follow it to completion.

Runs on one Node.js process with a SQLite file. No build step, no external
services, six npm dependencies. Signs people in with portal passwords,
single sign-on (OpenID Connect or SAML), or an LDAP / Active Directory
server, all set up from the admin pages.

## Quick start (Docker)

The recommended way to run PortalCake on a self-hosted box is to build the
image from a checkout of this repo. Docker is the only requirement.

```sh
git clone https://github.com/rcane/PortalCake.git
cd PortalCake
docker compose up -d --build
```

Open <http://localhost:3000>. The first visit asks you to create the
administrator account, seeds a starter category and form, and drops you
on the Settings page to rename the portal and add a banner.

Everything persistent (SQLite database, uploads, session secret) is kept in
the `portalcake_data` volume. The container runs as an unprivileged user,
reports its health to Docker via `/healthz`, and shuts down cleanly on
`docker stop`.

Day-to-day:

```sh
docker compose logs -f                      # follow the log
git pull && docker compose up -d --build    # upgrade
docker compose down                         # stop (data stays in the volume)
```

To change settings, copy `.env.example` to `.env` next to
`docker-compose.yml` and edit it; `docker compose up -d` picks it up. See
[Configuration](#configuration) for what each one does.

Without Compose, the same thing by hand:

```sh
docker build -t portalcake .
docker run -d --name portalcake --restart unless-stopped --init \
  -p 3000:3000 -v portalcake_data:/data -e TRUST_PROXY=1 portalcake
```

To keep the data in a host directory instead of a named volume, mount it at
`/data` (`-v /srv/portalcake:/data`, or `./data:/data` in the compose file)
and make sure it is writable by uid 1000: `chown -R 1000:1000 /srv/portalcake`.

### Running without Docker

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`).

```sh
npm install
npm start
```

## What it does

**Branding, with defaults.** Out of the box the portal is called
"Request Portal" with a solid blue banner. Administrators can change the name,
tagline, welcome text, sign-in page text, footer, banner color, text color,
and upload a banner image. One click resets everything to the defaults.

**Everything else is a setting too.** The same Settings page controls
whether the portal is private (sign in to see anything), whether people can
create their own accounts and from which email domains, the role new
accounts start with, the largest file that can be attached to a request, who
can add notes to requests (everyone involved, editors only, or nobody), the
ticket number prefix, whether the footer credits PortalCake, and a webhook
address for sending events to n8n or similar. Nothing on that page needs a
restart or an environment variable.

**Roles.**

| Role     | Can                                                                 |
|----------|---------------------------------------------------------------------|
| member   | Browse forms, send requests, add notes to their own requests        |
| editor   | Everything above, plus build categories and forms and work the queue|
| admin    | Everything above, plus settings and people                          |

**Categories and forms.** Editors create categories (name, description,
color) and forms inside them. The form builder supports short and long
answers, email, number, date, dropdown, choose-one, choose-several, yes/no,
file upload, and section headings. Each type has its own icon: you add a
question by picking its tile from a palette, the icon marks the question in
the builder and its type switcher, and it appears again beside the question
on the member's form and next to the answer on the request page, so a form
reads the same everywhere. The queue shows each request's kinds of question
as a row of the same icons. Each question can be required and have help
text. Forms are drafts until published, so you can preview them first.

**Conditional questions.** Any question can be shown only for certain
answers to a question above it: "Show this question when *Need parking?* is
*Yes*", or when a question *is not* a given answer, *is answered*, or *is
not answered*. Put the rule on a section heading and it hides the whole
section up to the next heading. The member's form shows and hides questions
as they answer, and the server applies the same rules when the request is
sent, so a hidden question is never required, never stored, and never
listed on the request.

**Requests.** Each submission gets a ticket number and a status: New,
In progress, Done, or Declined. Members see their own requests; editors see
everyone's in a filterable queue. Anyone involved can add notes (an
administrator can limit that to editors, or switch notes off). Submissions
store a snapshot of the form, so editing a form later never breaks old
requests.

**Accounts.** Self-registration can be switched off, in which case
administrators add people from the People page. It can also be limited to
certain email domains, and new accounts can start as members or editors.
A private portal hides everything behind sign-in.

**Enterprise sign-in.** Under Settings → Sign-in methods an administrator
can connect any number of identity providers, with no restart and nothing
in the environment:

| Method              | Works with                                                          |
|---------------------|---------------------------------------------------------------------|
| OpenID Connect      | Microsoft Entra ID, Okta, Google Workspace, Keycloak, Auth0, Authentik, anything with a discovery document |
| SAML 2.0            | Entra ID, Okta, OneLogin, AD FS, Shibboleth, PingFederate, …        |
| LDAP / Active Directory | People use their directory username and password on the portal's own sign-in form |

Each method comes with presets that pre-fill the right claim and attribute
names, and shows the redirect URI, entity ID, ACS URL, or metadata URL to
paste into the identity provider. For every method you choose whether
accounts are created on first sign-in, which role they start with, and
optionally which group makes someone an editor or an administrator (roles
are then kept in step on every sign-in, though the last administrator is
never demoted). Existing password accounts are linked by email the first
time they sign in through a provider, so switching an established portal
over is painless.

Once single sign-on works you can turn off password sign-in. Administrators
can still use their portal password at `/login?password=1`, so a
misconfigured identity provider never locks you out, and the portal turns
passwords back on by itself if the last provider is removed or switched off.

Details worth knowing:

- OpenID Connect uses the authorization-code flow with PKCE and verifies
  ID tokens against the provider's JWKS (RS/PS/ES/EdDSA). Public clients
  without a secret work too. Groups are read from a configurable claim,
  falling back to the userinfo endpoint.
- SAML expects signed assertions (or, if you turn that off, a signed
  response), rejects unsigned or tampered responses, and does not support
  encrypted assertions. Authentication requests are not signed. Both
  SP-initiated and IdP-initiated sign-in work.
- LDAP binds with a service account to find the person, then binds as them
  to check the password. Use `ldaps://` or StartTLS; group membership comes
  from `memberOf` (or any attribute you name) and can be matched by CN or
  full DN. The provider page has a test button that tries the connection,
  lookup, and optionally a password without saving anything.
- Client secrets and bind passwords are stored in the SQLite database, so
  treat the data directory (and backups of it) as sensitive.
- Behind a reverse proxy, set `TRUST_PROXY=1` so callback URLs use the
  public scheme and host, or pin the portal address explicitly under
  Sign-in methods → Options.

**Webhook (n8n and friends).** Under Settings → Webhook an administrator
can paste one address and the portal POSTs a JSON event to it whenever a
request is sent, changes status, or gets a note (each switchable). It is
built to drop straight into an [n8n](https://n8n.io) Webhook node, but any
endpoint that accepts JSON works:

1. In n8n, add a **Webhook** node, set its method to **POST**, and copy
   the production URL.
2. On the portal's Settings page, paste it as the webhook address. If you
   set a shared secret, set the Webhook node's authentication to
   **Header Auth** with name `X-Webhook-Secret` and the same value.
3. Click **Save and send a test event**; a `webhook.test` event lands in
   n8n so you can build the rest of the workflow from real data.

Every event carries `event`, `sent_at`, `portal` (name and address), and a
`request` object with `id`, `ticket`, `url`, `status`, `form`, `requester`,
`answers` (in form order, with labels), `answers_by_id`, and `attachments`
(each with a signed download `url` that works without an account for seven
days, so an n8n HTTP Request node can fetch the file; the signature is tied
to the session secret, so rotating that invalidates old links). `request.status_changed`
adds `previous_status` and `changed_by`; `comment.added` adds `comment`.
Headers: `X-PortalCake-Event` names the event, and when a secret is set,
`X-Webhook-Secret` carries it and `X-Webhook-Signature` holds
`sha256=<HMAC-SHA256 of the body>`. Delivery is fire-and-forget with a
10-second timeout: the request is always saved first, and a failed POST is
logged, never retried, and never shown to the member.

## Configuration

Everything is optional. With Docker Compose, put them in a `.env` file next
to `docker-compose.yml`; otherwise set them as environment variables.

| Variable          | Default        | Meaning                                              |
|-------------------|----------------|------------------------------------------------------|
| `PORT`            | `3000`         | Port to listen on (with Compose: the host port to publish) |
| `TRUST_PROXY`     | `0`            | Set to `1` behind a reverse proxy that terminates TLS (also marks cookies `Secure`) |
| `MAX_UPLOAD_MB`   | `10`           | Starting size limit for attached files; admins can change it under Settings |
| `SESSION_SECRET`  | auto-generated | Signs session cookies; generated once and saved in the data dir if unset |
| `HOST`            | `0.0.0.0`      | Interface to bind (bare Node only; the image binds all interfaces) |
| `PORTAL_DATA_DIR` | `./data`       | Where the database, uploads, and session secret live (bare Node only; the image uses `/data`) |

## Running in production

Put it behind any reverse proxy (Caddy, nginx, Traefik) that handles HTTPS,
and set `TRUST_PROXY=1`. The container listens on plain HTTP; a Caddyfile
that fronts it is two lines:

```
portal.example.com {
    reverse_proxy localhost:3000
}
```

`GET /healthz` returns `200 ok` once the database is reachable; the image
already uses it for Docker's health check, and it is handy for uptime
monitors.

**Backups.** Everything is in the data volume. To snapshot it to a tarball
in the current directory:

```sh
docker run --rm -v portalcake_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/portalcake-backup.tgz -C /data .
```

Restore by extracting into an empty volume the same way (`tar xzf`), then
`docker compose up -d`.

**Without Docker**, a minimal systemd unit:

```ini
[Service]
WorkingDirectory=/opt/portalcake
Environment=PORT=3000 TRUST_PROXY=1 PORTAL_DATA_DIR=/var/lib/portalcake
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
```

## Development

```sh
npm run dev    # restarts on file changes
npm test       # node:test suite, uses a throwaway data directory
```

Layout:

```
src/
  server.js        entry point
  app.js           express app, middleware, error pages
  db.js            sqlite connection and migrations
  settings.js      branding settings and their defaults
  fields.js        question types, schema sanitising, submission validation
  auth.js          password hashing, sessions, roles, CSRF
  webhook.js       outgoing JSON events (n8n etc.) for requests, statuses, notes
  providers/       sign-in methods: OpenID Connect, SAML, LDAP, and account linking
  routes/          public, sso (OIDC/SAML callbacks), requests, editor, admin
  views/           EJS templates; partials/field_icon.ejs draws the question-type
                   icons, partials/field_sprite.ejs bundles them as an SVG sprite
  public/          stylesheet; components/ holds the form builder web components
                   (form-builder, field-card, option-list, question-preview);
                   conditions.js evaluates show-when rules for both the server
                   and the member's form (form-conditions.js)
```

Adding a question type: add it to `FIELD_TYPES` in `src/fields.js`, handle
it in `validateSubmission`, render it in `src/views/form.ejs`, draw its icon
in `src/views/partials/field_icon.ejs` (24×24, stroked in `currentColor`;
unknown types get a placeholder), and (if it needs extra settings) add to
the `<field-card>` template in `src/public/components/field-card.js`. The icon
then shows up by itself in the builder palette, the type switcher, the
member form, and the request page, all of which read `FIELD_TYPES` and the
sprite.

## License

MIT. See `LICENSE`.
