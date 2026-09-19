# SofaMate server

The public service is a standalone Node.js 24 process and a static website. The Windows client does not include Node.js, a database, an OAuth SDK, or FFmpeg.

## Build and run locally

```powershell
npm ci
npm run build:market
npm run market
```

Local mode binds to `127.0.0.1:47831`. Launch the desktop with `--market-port 47831` to test local sharing. It deliberately does not pretend to have public accounts.

## Public deployment

Use an isolated service user, data directory and loopback port. `sofamate.service` sets CPU and memory limits. Copy `dist/market/` into a versioned release directory; point `/srv/sofamate/current` at that directory. Store configuration outside the release tree in a root-owned, mode `0600` `/etc/sofamate/server.env`, based on `server.env.example`.

The example Nginx configuration terminates HTTPS and serves the website. Set the exact canonical origin in both Nginx and the service configuration. Provision a valid certificate before enabling the HTTPS block. Uploads stream to disk; the public API never accepts a supplied filesystem path. Never expose the loopback API port.

The included certificate timer uses a separately pinned official Certbot image, recorded in `/etc/sofamate/certbot-image`. It renews via the ACME webroot without stopping other applications. Keep the image maintained. After each release, validate Nginx before reloading it and check `/health` plus `/v1/auth/config`.

## Authentication

Email sign-in uses single-use six-digit codes (10 minutes, five attempts), delivered with a dedicated domain-restricted Resend sending key. The first successful verification creates the account. Limits include per-address cooldown, per-IP requests and an 80-email rolling daily global budget for the beta.

GitHub and Google use server-side authorization code flows with browser-bound state and PKCE. Register exact redirect URIs:

- `https://YOUR_HOST/v1/auth/oauth/github/callback`
- `https://YOUR_HOST/v1/auth/oauth/google/callback`

Only verified provider emails are accepted. A matching email does not silently merge accounts: sign in with email first, then explicitly link the provider. Provider access tokens are not persisted. Configure a provider only after both its client ID and secret are ready; unavailable options stay disabled.

Web sessions are HttpOnly, Secure, SameSite cookies. Desktop authorization uses a short-lived pairing code and an explicit browser confirmation. Its polling secret stays in native code; the returned session is encrypted using Windows DPAPI. Renderer code never receives the session token. Accounts and hashed session records live in SQLite, outside the source/release tree.

## Capacity and moderation

Default public beta limits: 1 GiB per video, 2 GiB and 50 items per account, 10 GiB total, 1,000 active items, five unfinished drafts per account, two simultaneous uploads. Draft capacity is reserved before uploading; expired drafts are removed after 24 hours by a periodic cleanup. These limits are a deliberate beta budget, not a scaling claim.

Uploads require an account; browsing and downloads are public. Owners can withdraw their uploads. An administrator can withdraw any item or suspend an account through `/v1/admin/items/:id` (DELETE) and `/v1/admin/users/:id` (POST), using a dedicated bearer credential whose SHA-256 is configured on the server. Nginx blocks these routes publicly; use the server's loopback interface with the canonical Host header over SSH. Never put administrator credentials in the client or repository.

Back up the SQLite database with SQLite's backup API and retain the `items/` directory together. Database files contain private email addresses; backup access must be restricted. For a consistent complete backup, stop **only** SofaMate briefly, copy its data, then restart it. Store an encrypted off-host backup before relying on this beta for irreplaceable media. A release rollback changes the `current` symlink; do not overwrite user data during rollback.

Access logs omit query strings so OAuth codes and pairing identifiers are not logged. Do not enable verbose auth logging. Logs and user data require an operator-defined retention policy.
