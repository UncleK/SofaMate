import { createPublicKey, verify } from 'node:crypto';
import { MarketError } from './market-access';

export type OidcConfig = { issuer: string; clientId: string; clientSecret: string };
export async function verifyIdentityToken(token: string, config: OidcConfig, nonce: string, remote: typeof fetch = fetch) {
  const invalid = () => new MarketError(400, '统一登录验证失败，请重新登录');
  try {
    if (token.length > 16384) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 3) throw invalid();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') throw invalid();
    const result = await remote(`${config.issuer}/.well-known/jwks.json`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!result.ok) throw invalid();
    const data = await result.text();
    if (data.length > 65536) throw invalid();
    const keys = JSON.parse(data).keys;
    const key = Array.isArray(keys) && keys.find((k: any) => k.kid === header.kid && (!k.alg || k.alg === header.alg) && (!k.use || k.use === 'sig') && (header.alg === 'ES256' ? k.kty === 'EC' && k.crv === 'P-256' : k.kty === 'RSA'));
    if (!key || !verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))) throw invalid();
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const seconds = Date.now() / 1000;
    if (claims.iss !== config.issuer || !aud.includes(config.clientId) || (aud.length > 1 && claims.azp !== config.clientId) || (claims.azp && claims.azp !== config.clientId) || claims.nonce !== nonce || typeof claims.exp !== 'number' || claims.exp <= seconds || typeof claims.iat !== 'number' || claims.iat > seconds + 60 || (claims.nbf && claims.nbf > seconds + 60) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw invalid();
    return claims as { sub: string; email?: string; email_verified?: boolean; name?: string };
  } catch { throw invalid(); }
}
