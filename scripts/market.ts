import path from 'node:path';
import { createMarket } from '../src/platform/market';
const server = await createMarket(
  path.resolve(process.env.SCREENMATE_MARKET_DATA ?? 'workspace/local-market'),
  Number(process.env.SCREENMATE_MARKET_PORT ?? 47831),
  process.env.SOFAMATE_PUBLIC_ORIGIN ? {
    publicOrigin: process.env.SOFAMATE_PUBLIC_ORIGIN,
    adminTokenHash: process.env.SOFAMATE_ADMIN_TOKEN_HASH,
    maxTotalBytes: Number(process.env.SOFAMATE_MAX_STORAGE_BYTES ?? 10 * 1024 ** 3),
    maxOwnerBytes: Number(process.env.SOFAMATE_MAX_USER_BYTES ?? 2 * 1024 ** 3),
    auth: {
      oidc: process.env.SOFAMATE_OIDC_ISSUER && process.env.SOFAMATE_OIDC_CLIENT_ID && process.env.SOFAMATE_OIDC_CLIENT_SECRET ? { issuer: process.env.SOFAMATE_OIDC_ISSUER, clientId: process.env.SOFAMATE_OIDC_CLIENT_ID, clientSecret: process.env.SOFAMATE_OIDC_CLIENT_SECRET } : undefined,
      resendKey: process.env.SOFAMATE_RESEND_API_KEY,
      emailFrom: process.env.SOFAMATE_EMAIL_FROM,
      github: process.env.SOFAMATE_GITHUB_CLIENT_ID && process.env.SOFAMATE_GITHUB_CLIENT_SECRET ? { clientId: process.env.SOFAMATE_GITHUB_CLIENT_ID, clientSecret: process.env.SOFAMATE_GITHUB_CLIENT_SECRET } : undefined,
      google: process.env.SOFAMATE_GOOGLE_CLIENT_ID && process.env.SOFAMATE_GOOGLE_CLIENT_SECRET ? { clientId: process.env.SOFAMATE_GOOGLE_CLIENT_ID, clientSecret: process.env.SOFAMATE_GOOGLE_CLIENT_SECRET } : undefined,
    },
  } : {},
);
console.log(`SofaMate market listening on loopback port ${(server.address() as { port: number }).port}; public=${!!process.env.SOFAMATE_PUBLIC_ORIGIN}`);
for (const event of ['SIGINT', 'SIGTERM'] as const)
  process.once(event, () => server.close(() => process.exit(0)));
