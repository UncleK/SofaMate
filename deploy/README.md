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

Registration and email/Google/GitHub sign-in belong to the shared Aveniqa identity provider. Enable Supabase's OAuth server with dynamic registration disabled, implement the Aveniqa consent page, and register a separate confidential SofaMate client with the exact callback `https://YOUR_HOST/v1/auth/aveniqa/callback`. Aveniqa must allowlist that client ID in `SOFAMATE_OAUTH_CLIENT_ID`.

Configure all three `SOFAMATE_OIDC_*` variables in the SofaMate server environment. Keep the client secret isolated from business databases and out of the desktop. Requests use browser-bound state, PKCE and a nonce; ID tokens are verified against the provider's signing keys. Provider tokens are not persisted. Independent email/provider routes are disabled in unified mode. See [account architecture](../docs/ACCOUNT_ARCHITECTURE.md).

Web sessions are HttpOnly, Secure, SameSite cookies. Desktop authorization uses a short-lived pairing code and an explicit browser confirmation. Its polling secret stays in native code; the returned session is encrypted using Windows DPAPI. Renderer code never receives the session token. Accounts and hashed session records live in SQLite, outside the source/release tree.

## Capacity and moderation

Default public beta limits: 1 GiB per video, 2 GiB and 50 items per account, 10 GiB total, 1,000 active items, five unfinished drafts per account, two simultaneous uploads. Draft capacity is reserved before uploading; expired drafts are removed after 24 hours by a periodic cleanup. These limits are a deliberate beta budget, not a scaling claim.

Uploads require an account; browsing and downloads are public. Owners can withdraw their uploads. An administrator can withdraw any item or suspend an account through `/v1/admin/items/:id` (DELETE) and `/v1/admin/users/:id` (POST), using a dedicated bearer credential whose SHA-256 is configured on the server. Nginx blocks these routes publicly; use the server's loopback interface with the canonical Host header over SSH. Never put administrator credentials in the client or repository.

Back up the SQLite database with SQLite's backup API and retain the `items/` directory together. Database files contain private email addresses; backup access must be restricted. For a consistent complete backup, stop **only** SofaMate briefly, copy its data, then restart it. Store an encrypted off-host backup before relying on this beta for irreplaceable media. A release rollback changes the `current` symlink; do not overwrite user data during rollback.

Access logs omit query strings so OAuth codes and pairing identifiers are not logged. Do not enable verbose auth logging. Logs and user data require an operator-defined retention policy.

## Website discovery and official preview

Home, Discover (`/market`), About and Download are separate pages. Discover loads actual community works from the same `/v1/items` catalog as the client. Preview plays inside its original card, starts only on request and pauses offscreen. The separate download page retains the selected video and offers the Windows client plus a video download/import path. It does not claim automatic installation of a complete official theme. Chinese, English and Japanese have static localized pages; see [website authoring](../docs/WEBSITE.md).

Keep the approved preview outside Git and release directories at `/srv/sofamate/public-media/night-scene.mp4`, readable by Nginx. The exact `/previews/night-scene.mp4` location supports range requests and limits transfer rate. The selected E12 screen-wiping preview has SHA-256 `a6aee3b093d5d450ae72a2840c6ba44355e802cac331b8c27408e319e3569536`, 5,332,657 bytes. It is one 720P24 excerpt, not a full scene graph. Reuse this media directory on later deployments.

Public pages include canonical URLs, Open Graph/Twitter cards and accurate software/FAQ structured data. `robots.txt` and `sitemap.xml` cover public pages; login is noindex. Keep schema text and visible FAQ answers synchronized. No fabricated reviews, user counts or search/AI ranking guarantees are used.
