# Unified Aveniqa account

SofaMate uses Aveniqa's Supabase identity provider through OAuth 2.1 / OpenID Connect. Aveniqa and SofaMate share registration and sign-in with email codes, Google and GitHub. Each product retains its own works, permissions, storage quota and sessions.

SofaMate is a separate confidential OAuth client with an exact callback, browser-bound state, nonce and PKCE. The server validates signature, issuer, audience, expiry and nonce before accepting a verified email from UserInfo. Identity ownership is keyed by issuer and subject; email alone never grants another identity's works.

The desktop keeps browser pairing and Windows DPAPI session storage. No Supabase SDK, identity database or server secret is added to the executable. SQLite stores SofaMate's user mapping, moderation state and hashed product sessions, not an independent public registration system.

The Aveniqa consent endpoint permits only the registered SofaMate client and identity scopes. Delegated OAuth bearer tokens are rejected by Aveniqa's first-party account resolver. Public Data API grants and storage policies were checked before integration; business database credentials remain isolated.

Logging out of SofaMate revokes that product session. Central logout and product logout are distinct. Product suspension immediately revokes that user's SofaMate sessions. Central deletion/revocation propagation across all product sessions is not yet automated.

The initial cutover resets only pre-release SofaMate test login state after backup and a check for published works. There is no public legacy-account migration or duplicate sign-up UI.

Reference: https://supabase.com/docs/guides/auth/oauth-server
