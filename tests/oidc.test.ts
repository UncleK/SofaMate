import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import http from 'node:http';
import { verifyIdentityToken } from '../src/platform/oidc';
import { createMarket } from '../src/platform/market';

const config = { issuer: 'https://identity.example.test/auth/v1', clientId: 'sofa-client', clientSecret: 'test-only-secret' };
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'ES256', use: 'sig' };
function jwt(nonce: string, overrides: Record<string, unknown> = {}) {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const message = encode({ alg: 'ES256', kid: key.kid }) + '.' + encode({ iss: config.issuer, aud: config.clientId, sub: 'central-user', nonce, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...overrides });
  return message + '.' + sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
test('OIDC rejects wrong audience, issuer, nonce, expiry and modified signatures', async () => {
  const remote = (async () => Response.json({ keys: [key] })) as typeof fetch;
  assert.equal((await verifyIdentityToken(jwt('nonce'), config, 'nonce', remote)).sub, 'central-user');
  for (const change of [{ aud: 'another-app' }, { iss: 'https://evil.test' }, { nonce: 'wrong' }, { exp: 1 }, { iat: Date.now()/1000+600 }, { aud: [config.clientId, 'other'] }]) await assert.rejects(verifyIdentityToken(jwt('nonce', change), config, 'nonce', remote));
  const good = jwt('nonce'); const parts = good.split('.'); const sig = Buffer.from(parts[2], 'base64url'); sig[0] ^= 1;
  await assert.rejects(verifyIdentityToken(parts[0]+'.'+parts[1]+'.'+sig.toString('base64url'), config, 'nonce', remote));
});

test('unified login binds PKCE/state, preserves pairing and disallows independent signup', async () => {
  await mkdir('test-results/oidc', { recursive: true });
  const root = await mkdtemp(path.resolve('test-results/oidc/run-'));
  let nonce = '', challenge = '', badAudience = false;
  const remote = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [key] });
    if (String(url).endsWith('/oauth/token')) {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), challenge);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Basic '+Buffer.from(config.clientId+':'+config.clientSecret).toString('base64'));
      return Response.json({ id_token: jwt(nonce, badAudience ? { aud: 'other' } : {}), access_token: 'test-access-token' });
    }
    return Response.json({ sub: 'central-user', email: 'unified@example.test', email_verified: true, name: 'Unified user' });
  }) as typeof fetch;
  const server = await createMarket(root, 0, { publicOrigin: 'https://market.example.test', adminTokenHash: 'a'.repeat(64), auth: { oidc: config, oauthFetch: remote } });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (route: string, method='GET', body?: unknown, cookie='') => new Promise<Response>((resolve,reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const r = http.request(base+route, { method, headers: { Host: 'market.example.test', Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-SofaMate-Client': 'desktop' } }, res => {
      const chunks: Buffer[]=[];res.on('data', b=>chunks.push(b));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):String(v)]))})));
    });r.on('error',reject);r.end(payload);
  });
  const start = async () => {
    const res = await request('/v1/auth/aveniqa/start'); assert.equal(res.status,302);
    const target = new URL(res.headers.get('location')!); nonce=target.searchParams.get('nonce')!;challenge=target.searchParams.get('code_challenge')!;
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], callback: '/v1/auth/aveniqa/callback?code=test&state='+target.searchParams.get('state') };
  };
  try {
    assert.equal((await request('/v1/auth/email/start','POST',{email:'a@example.test'})).status,400);
    assert.equal((await request('/v1/auth/oauth/github/start')).status,400);
    const first=await start(); assert.equal((await request(first.callback)).status,400);
    const result=await request(first.callback,'GET',undefined,first.cookie);assert.equal(result.status,302);
    assert.equal((await request(first.callback,'GET',undefined,first.cookie)).status,400);
    const cookie=result.headers.get('set-cookie')!.split(';')[0];
    const user=(await (await request('/v1/auth/me','GET',undefined,cookie)).json() as any).user;
    const second=await start();const again=await request(second.callback,'GET',undefined,second.cookie);
    const againUser=await (await request('/v1/auth/me','GET',undefined,again.headers.get('set-cookie')!.split(';')[0])).json() as any;assert.equal(againUser.user.id,user.id);
    const pair=await (await request('/v1/auth/desktop','POST',{})).json() as any;
    assert.equal((await request('/v1/auth/desktop/approve','POST',{id:pair.id},cookie)).status,200);
    const paired=await (await request('/v1/auth/desktop/poll','POST',{id:pair.id,secret:pair.secret})).json() as any;assert.equal(paired.user.id,user.id);
    const db=new DatabaseSync(path.join(root,'accounts.sqlite'));db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(user.id);db.close();
    assert.equal((await request('/v1/auth/me','GET',undefined,cookie)).status,401);
    const disabled=await start();assert.equal((await request(disabled.callback,'GET',undefined,disabled.cookie)).status,403);
    badAudience=true; const invalid=await start();assert.equal((await request(invalid.callback,'GET',undefined,invalid.cookie)).status,400);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
