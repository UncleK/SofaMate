import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { digest, matches, MarketError } from './market-access';
import { verifyIdentityToken, type OidcConfig } from './oidc';

type Provider = 'github' | 'google';
type User = { id: string; email: string; name: string; disabled: number };
type Credentials = { clientId: string; clientSecret: string };
export type AuthOptions = {
  oidc?: OidcConfig;
  github?: Credentials;
  google?: Credentials;
  resendKey?: string;
  emailFrom?: string;
  // Dependencies below are only supplied by isolated tests, never environment configuration.
  sendCode?: (email: string, code: string, requestId: string) => Promise<void>;
  oauthFetch?: typeof fetch;
};
const opaque = () => randomBytes(32).toString('hex');
const now = () => Date.now();
const DAY = 86400_000;
const safeId = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
const cookie = (req: IncomingMessage, key: string) => req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(key + '='))?.slice(key.length + 1) ?? '';
function fail(status: number, message: string): never { throw new MarketError(status, message); }
function emailAddress(value: unknown) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) fail(400, '请输入有效的邮箱地址');
  return value.trim().toLowerCase();
}
const displayName = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : 'SofaMate user';

export function createAuth(root: string, origin: string, options: AuthOptions = {}) {
  const db = new DatabaseSync(path.join(root, 'accounts.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(provider,subject));
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS email_codes(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,code_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS codes_email ON email_codes(email,created);
    CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY,provider TEXT NOT NULL,verifier TEXT NOT NULL,desktop TEXT NOT NULL,link_user TEXT,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS desktop_logins(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,display_code TEXT NOT NULL,user_id TEXT REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,hits INTEGER NOT NULL,until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oidc_states(hash TEXT PRIMARY KEY,verifier TEXT NOT NULL,nonce TEXT NOT NULL,desktop TEXT NOT NULL,link_user TEXT,expires INTEGER NOT NULL);
  `);
  if (options.oidc && (!options.oidc.issuer.startsWith('https://') || new URL(options.oidc.issuer).search || options.oidc.issuer.endsWith('/'))) throw new Error('Invalid OIDC issuer');
  const getUser = (id: string) => db.prepare('SELECT * FROM users WHERE id=?').get(id) as User | undefined;
  const profile = (u: User) => ({ id: u.id, name: u.name, email: u.email });
  const bearer = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? cookie(req, '__Host-sofamate');
  function session(req: IncomingMessage): User {
    const token = bearer(req);
    if (!safeId(token)) fail(401, '请先登录后再分享');
    const row = db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?').get(digest(token), now()) as User | undefined;
    if (!row || row.disabled) fail(401, '登录已过期，请重新登录');
    return row;
  }
  function optionalSession(req: IncomingMessage) { try { return session(req); } catch { return undefined; } }
  function limit(key: string, max: number, ms: number) {
    const row = db.prepare('SELECT hits,until FROM rate_limits WHERE key=?').get(key) as { hits: number; until: number } | undefined;
    if (row && row.until > now() && row.hits >= max) fail(429, '操作太频繁，请稍后再试');
    if (!row || row.until <= now()) db.prepare('INSERT OR REPLACE INTO rate_limits VALUES(?,1,?)').run(key, now() + ms);
    else db.prepare('UPDATE rate_limits SET hits=hits+1 WHERE key=?').run(key);
  }
  const json = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  function issue(u: User, req: IncomingMessage, res: ServerResponse) {
    if (u.disabled) fail(403, '账号已停用');
    const token = opaque();
    db.prepare('DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 9)').run(u.id, u.id);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token), u.id, now() + 30 * DAY, now());
    res.setHeader('Set-Cookie', `__Host-sofamate=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    json(res, 200, { user: profile(u), ...(req.headers['x-sofamate-client'] === 'desktop' ? { token } : {}) });
  }
  const remote = options.oauthFetch ?? fetch;
  async function external(url: string, init: RequestInit) {
    const response = await remote(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(502, '登录服务暂时不可用，请稍后重试');
    const text = await response.text();
    if (text.length > 256 * 1024) fail(502, '登录服务响应无效');
    return JSON.parse(text);
  }
  async function sendCode(email: string, code: string, id: string) {
    if (options.sendCode) return options.sendCode(email, code, id);
    if (!options.resendKey || !options.emailFrom) fail(503, '邮箱登录暂未启用');
    const text = `你的 SofaMate 登录验证码是 ${code}。\n10 分钟内有效，仅可使用一次。首次验证将创建账号。\n如果不是你发起的请求，请忽略此邮件，不要向他人提供验证码。\n\nYour SofaMate verification code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`;
    const body = { from: options.emailFrom, to: [email], subject: 'SofaMate · 登录验证码 / Sign-in code', text, html: `<!doctype html><html lang="zh-CN"><body style="margin:0;background:#f5f2ed;color:#302d28;font:16px Arial,sans-serif"><table role="presentation" style="width:100%;max-width:520px;margin:40px auto;padding:36px;background:#fff;border-radius:16px"><tr><td><p style="font-size:24px;font-weight:bold">SofaMate</p><h1 style="font-size:24px">让喜欢的画面，陪你一会儿。</h1><p>输入以下验证码，完成注册或登录。</p><p style="font:36px monospace;letter-spacing:8px;padding:24px;background:#f5f2ed;border-radius:8px;text-align:center">${code}</p><p>10 分钟内有效，仅可使用一次。</p><p style="color:#726b61;font-size:14px">如果不是你发起的请求，请忽略此邮件。不要向他人提供验证码。</p><hr style="border:0;border-top:1px solid #eee"><p style="font-size:14px">Use this code to sign in to SofaMate. It expires in 10 minutes. If you did not request it, ignore this email.</p></td></tr></table></body></html>` };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${options.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `sofamate-login/${id}` }, body: JSON.stringify(body) });
        if (response.ok) { await response.body?.cancel(); return; }
        await response.body?.cancel();
        if (response.status < 500 && response.status !== 429) break;
      } catch { /* Retry once using the same idempotency key; never log codes or recipients. */ }
      if (!attempt) await new Promise(r => setTimeout(r, 1000));
    }
    fail(503, '验证码发送失败，请稍后重试');
  }
  function cleanup() {
    db.prepare('DELETE FROM oidc_states WHERE expires<?').run(now());
    for (const table of ['sessions', 'email_codes', 'oauth_states', 'desktop_logins']) db.prepare(`DELETE FROM ${table} WHERE expires<?`).run(now());
    db.prepare('DELETE FROM rate_limits WHERE until<?').run(now());
  }
  cleanup();
  const timer = setInterval(cleanup, 60000); timer.unref();

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<any>) {
    const route = url.pathname;
    if (!route.startsWith('/v1/auth/')) return false;
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 80);
    if (route === '/v1/auth/config' && req.method === 'GET') { json(res, 200, { unified: !!options.oidc, email: !options.oidc && !!(options.sendCode || options.resendKey && options.emailFrom), github: !options.oidc && !!options.github, google: !options.oidc && !!options.google }); return true; }
    if (route.startsWith('/v1/auth/aveniqa/')) return handleUnified(req, res, url, ip);
    if (route === '/v1/auth/me' && req.method === 'GET') { json(res, 200, { user: profile(session(req)) }); return true; }
    if (route === '/v1/auth/logout' && req.method === 'POST') {
      db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(bearer(req)));
      res.setHeader('Set-Cookie', '__Host-sofamate=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'); json(res, 200, { loggedOut: true }); return true;
    }
    if (route === '/v1/auth/email/start' && req.method === 'POST') {
      if (options.oidc) fail(400, '请使用 Aveniqa 统一登录');
      limit('mail-ip:' + ip, 10, 3600_000);
      const input = await body(), email = emailAddress(input.email), name = displayName(input.name);
      limit('mail:' + digest(email), 3, 3600_000); limit('mail-cooldown:' + digest(email), 1, 60000);
      limit('mail-global', 80, DAY);
      const id = opaque(), code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      db.prepare('DELETE FROM email_codes WHERE email=?').run(email);
      db.prepare('INSERT INTO email_codes(id,email,name,code_hash,expires,created) VALUES(?,?,?,?,?,?)').run(id, email, name, digest(id + ':' + code), now() + 600000, now());
      try { await sendCode(email, code, id); } catch(e) { db.prepare('DELETE FROM email_codes WHERE id=?').run(id); throw e; }
      json(res, 200, { challengeId: id, expiresIn: 600, retryAfter: 60 }); return true;
    }
    if (route === '/v1/auth/email/verify' && req.method === 'POST') {
      if (options.oidc) fail(400, '请使用 Aveniqa 统一登录');
      limit('verify:' + ip, 30, 600000);
      const input = await body();
      const challenge = db.prepare('SELECT * FROM email_codes WHERE id=?').get(safeId(input.challengeId)) as { id: string; email: string; name: string; code_hash: string; attempts: number; expires: number } | undefined;
      if (!challenge || challenge.expires < now() || challenge.attempts >= 5) fail(400, '验证码已失效，请重新获取');
      db.prepare('UPDATE email_codes SET attempts=attempts+1 WHERE id=?').run(challenge.id);
      if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code) || !matches(challenge.id + ':' + input.code, challenge.code_hash)) fail(400, '验证码不正确');
      db.prepare('DELETE FROM email_codes WHERE id=?').run(challenge.id);
      let u = db.prepare('SELECT * FROM users WHERE email=?').get(challenge.email) as User | undefined;
      if (!u) { const id = randomUUID(); db.prepare('INSERT INTO users(id,email,name,created) VALUES(?,?,?,?)').run(id, challenge.email, challenge.name, now()); u = getUser(id)!; }
      issue(u, req, res); return true;
    }
    if (route === '/v1/auth/desktop' && req.method === 'POST') {
      limit('desktop:' + ip, 12, 600000);
      const id = opaque(), secret = opaque(), code = String(randomInt(100000, 1_000_000));
      db.prepare('INSERT INTO desktop_logins(id,secret_hash,display_code,expires) VALUES(?,?,?,?)').run(id, digest(secret), code, now() + 600000);
      json(res, 201, { id, secret, code, loginUrl: `${origin}/login?desktop=${id}`, expiresIn: 600 }); return true;
    }
    if (route === '/v1/auth/desktop/info' && req.method === 'GET') {
      const row = db.prepare('SELECT display_code AS code FROM desktop_logins WHERE id=? AND expires>?').get(safeId(url.searchParams.get('id')), now());
      if (!row) fail(404, '客户端登录已过期，请重新发起');
      json(res, 200, row); return true;
    }
    if (route === '/v1/auth/desktop/approve' && req.method === 'POST') {
      const u = session(req), input = await body();
      const result = db.prepare('UPDATE desktop_logins SET user_id=? WHERE id=? AND expires>? AND user_id IS NULL').run(u.id, safeId(input.id), now());
      if (!result.changes) fail(400, '客户端登录已过期，请重新发起');
      json(res, 200, { approved: true }); return true;
    }
    if (route === '/v1/auth/desktop/poll' && req.method === 'POST') {
      const input = await body();
      const row = db.prepare('SELECT * FROM desktop_logins WHERE id=? AND expires>?').get(safeId(input.id), now()) as { id: string; secret_hash: string; user_id: string | null } | undefined;
      if (!row || !matches(safeId(input.secret), row.secret_hash)) fail(400, '客户端登录已过期，请重新发起');
      if (!row.user_id) { json(res, 200, { pending: true }); return true; }
      db.prepare('DELETE FROM desktop_logins WHERE id=?').run(row.id);
      issue(getUser(row.user_id)!, req, res); return true;
    }
    return handleOAuth(req, res, url, ip);
  }

  async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL, ip: string) {
    if (options.oidc) fail(400, '请使用 Aveniqa 统一登录');
    const oauth = url.pathname.match(/^\/v1\/auth\/oauth\/(github|google)\/(start|callback)$/);
    if (!oauth || req.method !== 'GET') fail(404, '接口不存在');
    const provider = oauth[1] as Provider, credentials = options[provider];
    if (!credentials) fail(503, '此登录方式暂未启用');
    const redirectUri = `${origin}/v1/auth/oauth/${provider}/callback`;
    if (oauth[2] === 'start') {
      limit('oauth:' + ip, 20, 600000);
      const state = opaque(), verifier = randomBytes(32).toString('base64url');
      const desktop = safeId(url.searchParams.get('desktop'));
      const linking = url.searchParams.get('link') === '1' ? session(req).id : null;
      db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,?,?)').run(digest(state), provider, verifier, desktop, linking, now() + 600000);
      res.setHeader('Set-Cookie', `__Host-sofamate-oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      const target = new URL(provider === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({ client_id: credentials.clientId, redirect_uri: redirectUri, response_type: 'code', scope: provider === 'github' ? 'read:user user:email' : 'openid email profile', state, code_challenge: Buffer.from(digest(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' })) target.searchParams.set(key, value);
      res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    const state = safeId(url.searchParams.get('state'));
    if (!state || cookie(req, '__Host-sofamate-oauth') !== state) fail(400, '登录状态不匹配，请重新登录');
    const pending = db.prepare('SELECT * FROM oauth_states WHERE hash=? AND provider=? AND expires>?').get(digest(state), provider, now()) as { verifier: string; desktop: string; link_user: string | null } | undefined;
    if (!pending) fail(400, '登录状态已过期，请重新登录');
    db.prepare('DELETE FROM oauth_states WHERE hash=?').run(digest(state));
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) fail(400, '登录已取消，请重试');
    const token = await external(provider === 'github' ? 'https://github.com/login/oauth/access_token' : 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code, redirect_uri: redirectUri, code_verifier: pending.verifier, grant_type: 'authorization_code' }) });
    if (typeof token.access_token !== 'string') fail(502, '授权失败，请重新登录');
    const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'SofaMate' };
    const identity = await external(provider === 'github' ? 'https://api.github.com/user' : 'https://openidconnect.googleapis.com/v1/userinfo', { headers });
    let email: string;
    if (provider === 'github') {
      const emails = await external('https://api.github.com/user/emails', { headers });
      const verified = Array.isArray(emails) && emails.find((e: any) => e.primary && e.verified);
      if (!verified) fail(400, '请先在 GitHub 验证主邮箱');
      email = emailAddress(verified.email);
    } else {
      if (identity.email_verified !== true) fail(400, '请先在 Google 验证邮箱');
      email = emailAddress(identity.email);
    }
    const subject = String(provider === 'github' ? identity.id ?? '' : identity.sub ?? '');
    if (!subject || subject.length > 255) fail(502, '登录服务响应无效');
    const existing = db.prepare('SELECT user_id FROM identities WHERE provider=? AND subject=?').get(provider, subject) as { user_id: string } | undefined;
    let u: User;
    if (pending.link_user) {
      if (optionalSession(req)?.id !== pending.link_user) fail(401, '绑定账号前请重新登录');
      if (existing && existing.user_id !== pending.link_user) fail(409, '此登录方式已绑定其他账号');
      u = getUser(pending.link_user)!;
    } else if (existing) u = getUser(existing.user_id)!;
    else {
      // A matching email never silently merges accounts. Sign in first, then explicitly link.
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) { res.writeHead(302, { Location: `/login?error=link-required${pending.desktop ? '&desktop=' + pending.desktop : ''}`, 'Cache-Control': 'no-store' }); res.end(); return true; }
      const id = randomUUID(); db.prepare('INSERT INTO users(id,email,name,created) VALUES(?,?,?,?)').run(id, email, displayName(identity.name ?? identity.login), now()); u = getUser(id)!;
    }
    if (u.disabled) fail(403, '账号已停用');
    db.prepare('INSERT OR IGNORE INTO identities VALUES(?,?,?)').run(provider, subject, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 9)').run(u.id, u.id);
    const sessionToken = opaque(); db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(sessionToken), u.id, now() + 30 * DAY, now());
    res.setHeader('Set-Cookie', [`__Host-sofamate=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`, '__Host-sofamate-oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
    res.writeHead(302, { Location: `/login${pending.desktop ? '?desktop=' + pending.desktop : ''}`, 'Cache-Control': 'no-store' }); res.end(); return true;
  }

  async function handleUnified(req: IncomingMessage, res: ServerResponse, url: URL, ip: string) {
    const config = options.oidc;
    if (!config || req.method !== 'GET') fail(404, '接口不存在');
    const callback = `${origin}/v1/auth/aveniqa/callback`;
    if (url.pathname === '/v1/auth/aveniqa/start') {
      limit('unified:' + ip, 20, 600000);
      const state = opaque(), verifier = randomBytes(32).toString('base64url'), nonce = opaque();
      db.prepare('INSERT INTO oidc_states VALUES(?,?,?,?,?,?)').run(digest(state), verifier, nonce, safeId(url.searchParams.get('desktop')), null, now() + 600000);
      const target = new URL(`${config.issuer}/oauth/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: callback, scope: 'openid email profile', state, nonce, code_challenge: Buffer.from(digest(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' })) target.searchParams.set(key, value);
      res.setHeader('Set-Cookie', `__Host-sofamate-oidc=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    if (url.pathname !== '/v1/auth/aveniqa/callback') fail(404, '接口不存在');
    const state = safeId(url.searchParams.get('state'));
    if (!state || cookie(req, '__Host-sofamate-oidc') !== state) fail(400, '登录状态不匹配，请重新登录');
    const pending = db.prepare('DELETE FROM oidc_states WHERE hash=? AND expires>? RETURNING *').get(digest(state), now()) as { verifier: string; nonce: string; desktop: string; link_user: string | null } | undefined;
    if (!pending) fail(400, '登录状态已过期，请重新登录');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) fail(400, '登录已取消，请重试');
    const token = await external(`${config.issuer}/oauth/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: pending.verifier }) });
    if (typeof token.id_token !== 'string' || typeof token.access_token !== 'string') fail(502, '统一登录响应无效');
    const claims = await verifyIdentityToken(token.id_token, config, pending.nonce, remote);
    const info = await external(`${config.issuer}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (info.sub !== claims.sub || info.email_verified !== true) fail(400, '请先验证 Aveniqa 账号邮箱');
    const email = emailAddress(info.email);
    const subject = config.issuer + '|' + claims.sub;
    const existing = db.prepare("SELECT user_id FROM identities WHERE provider='aveniqa' AND subject=?").get(subject) as { user_id: string } | undefined;
    let u: User;
    if (existing) u = getUser(existing.user_id)!;
    else {
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
        fail(409, '此邮箱已被另一身份使用，请使用原 Aveniqa 账号登录');
      }
      const id = randomUUID(); db.prepare('INSERT INTO users(id,email,name,created) VALUES(?,?,?,?)').run(id, email, displayName(info.name), now()); u = getUser(id)!;
    }
    if (u.disabled) fail(403, '账号已停用');
    db.prepare("INSERT OR IGNORE INTO identities VALUES('aveniqa',?,?)").run(subject, u.id);
    const sessionToken = opaque();
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(sessionToken), u.id, now() + 30 * DAY, now());
    res.setHeader('Set-Cookie', [`__Host-sofamate=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`, '__Host-sofamate-oidc=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
    res.writeHead(302, { Location: `/login${pending.desktop ? '?desktop=' + pending.desktop : ''}`, 'Cache-Control': 'no-store' }); res.end(); return true;
  }
  return { handle, session, profile, suspend(id: string) { db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }, close() { clearInterval(timer); db.close(); } };
}
