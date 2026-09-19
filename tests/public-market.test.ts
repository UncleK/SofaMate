import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import http from 'node:http';
import { createMarket } from '../src/platform/market';

const results = path.resolve('test-results/public-market');
await mkdir(results, { recursive: true });
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const admin = 'a'.repeat(64), origin = 'https://market.example.test';
const video = await readFile('content/engineering-second/0.1.0/media/video/quiet_read.mp4');
const cover = await readFile('tests/fixtures/platform-preview.jpg');

test('public accounts, desktop pairing, ownership and capacity are enforced by the server', async t => {
  const root = await mkdtemp(path.join(results, 'run-'));
  const codes = new Map<string, string>();
  let githubEmail = 'github@example.test', githubVerified = true;
  let lastTokenBody = '';
  const options = { publicOrigin: origin, adminTokenHash: hash(admin), maxOwnerItems: 2,
    auth: { github: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      sendCode: async (_email: string, code: string, id: string) => { codes.set(id, code); },
      oauthFetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/access_token')) { lastTokenBody = String(init?.body); return Response.json({ access_token: 'provider-fixture' }); }
        if (String(url).endsWith('/emails')) return Response.json([{email:githubEmail,primary:true,verified:githubVerified}]);
        return Response.json({id:87654,name:'Fixture creator'});
      }) as typeof fetch,
    } };
  let server = await createMarket(root, 0, options);
  let base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (route: string, method='GET', body?: unknown, token?: string, extra: Record<string,string>={}) => new Promise<Response>((resolve,reject)=>{
    const payload=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    const r=http.request(base+route,{method,headers:{Host:'market.example.test', ...(payload ? {'Content-Length':String(payload.length)}:{}), ...(body && !Buffer.isBuffer(body) ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:`Bearer ${token}`} : {}), ...extra}},res=>{
      const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):String(v)]))})));
    });r.on('error',reject);r.end(payload);
  });
  async function emailLogin(email: string) {
    const start = await request('/v1/auth/email/start','POST',{email,name:'Test creator'});
    assert.equal(start.status,200); const challenge = await start.json() as any;
    const result = await request('/v1/auth/email/verify','POST',{challengeId:challenge.challengeId,code:codes.get(challenge.challengeId)},undefined,{'X-SofaMate-Client':'desktop'});
    assert.equal(result.status,200); return { ...await result.json() as any, challenge };
  }
  let a:any, b:any, item = '';
  try {
    await t.test('anonymous publication and legacy registration are blocked; reads stay public',async()=>{
      assert.equal((await request('/v1/sessions','POST',{name:'Anonymous'})).status,403);
      assert.equal((await request('/v1/items','POST',{})).status,401);
      assert.equal((await request('/v1/items')).status,200);
      assert.equal((await request('/v1/auth/email/start','POST',{email:'x@example.test'},undefined,{Origin:'https://evil.test'})).status,403);
      assert.equal((await request('/health','GET',undefined,undefined,{Host:'other.test'})).status,403);
    });
    await t.test('verified email creates a stable identity; one-time code cannot be replayed',async()=>{
      a=await emailLogin('one@example.test'); b=await emailLogin('two@example.test');
      assert.notEqual(a.user.id,b.user.id); assert.match(a.token,/^[a-f0-9]{64}$/);
      assert.equal((await request('/v1/auth/email/verify','POST',{challengeId:a.challenge.challengeId,code:codes.get(a.challenge.challengeId)})).status,400);
      assert.equal((await request('/v1/auth/email/start','POST',{email:'one@example.test'})).status,429);
      const profile=await (await request('/v1/auth/me','GET',undefined,a.token)).json() as any; assert.equal(profile.user.id,a.user.id);
      const db=new DatabaseSync(path.join(root,'accounts.sqlite')); const stored=db.prepare('SELECT hash FROM sessions').all(); db.close();
      assert(stored.every(row=>row.hash!==a.token && row.hash!==b.token));
    });
    await t.test('five wrong guesses exhaust a code; expiry is enforced',async()=>{
      const c=await (await request('/v1/auth/email/start','POST',{email:'guess@example.test'})).json() as any;
      const wrong=codes.get(c.challengeId)==='000000'?'111111':'000000';
      for(let i=0;i<5;i++) assert.equal((await request('/v1/auth/email/verify','POST',{challengeId:c.challengeId,code:wrong})).status,400);
      assert.equal((await request('/v1/auth/email/verify','POST',{challengeId:c.challengeId,code:codes.get(c.challengeId)})).status,400);
      const db=new DatabaseSync(path.join(root,'accounts.sqlite')); db.prepare('UPDATE sessions SET expires=0 WHERE hash=?').run(hash(b.token)); db.close();
      assert.equal((await request('/v1/auth/me','GET',undefined,b.token)).status,401);
    });
    await t.test('desktop token requires browser approval, secret and single consumption',async()=>{
      const d=await (await request('/v1/auth/desktop','POST',{})).json() as any;
      assert.match(d.code,/^\d{6}$/);
      assert.equal((await request('/v1/auth/desktop/approve','POST',{id:d.id})).status,401);
      assert.equal((await request('/v1/auth/desktop/poll','POST',{id:d.id,secret:'b'.repeat(64)})).status,400);
      assert.equal((await request('/v1/auth/desktop/approve','POST',{id:d.id},a.token)).status,200);
      const paired=await (await request('/v1/auth/desktop/poll','POST',{id:d.id,secret:d.secret},undefined,{'X-SofaMate-Client':'desktop'})).json() as any;
      assert.equal(paired.user.id,a.user.id); assert(paired.token);
      assert.equal((await request('/v1/auth/desktop/poll','POST',{id:d.id,secret:d.secret})).status,400);
      assert.equal((await request('/v1/auth/logout','POST',{},paired.token)).status,200);
      assert.equal((await request('/v1/auth/me','GET',undefined,paired.token)).status,401);
    });
    await t.test('concurrent drafts reserve quota before uploading bytes',async()=>{
      const body={title:'Verified upload',description:'Test only',bytes:video.length,sha256:hash(video)};
      const rows=await Promise.all([1,2,3,4].map(()=>request('/v1/items','POST',body,a.token)));
      assert.equal(rows.filter(r=>r.status===201).length,2); assert.equal(rows.filter(r=>r.status===413).length,2);
      const accepted=await Promise.all(rows.filter(r=>r.status===201).map(r=>r.json())) as any[]; item=accepted[0].id;
      assert.equal((await request(`/v1/items/${item}/video`,'PUT',video,a.token)).status,200);
      assert.equal((await request(`/v1/items/${item}/cover`,'PUT',cover,a.token)).status,200);
      assert.equal((await request(`/v1/items/${item}/publish`,'POST',undefined,a.token)).status,200);
      const publicBytes=Buffer.from(await (await request(`/v1/items/${item}/video`)).arrayBuffer()); assert.equal(hash(publicBytes),hash(video));
      assert.equal((await request(`/v1/items/${item}`,'DELETE',undefined,b.token)).status,401);
      assert.equal((await request('/v1/items/mine','GET',undefined,a.token)).status,200);
    });
    async function oauthStart() {
      const r=await request('/v1/auth/oauth/github/start'); assert.equal(r.status,302);
      const u=new URL(r.headers.get('location')!); assert.equal(u.searchParams.get('code_challenge_method'),'S256');
      return {state:u.searchParams.get('state')!,cookie:r.headers.get('set-cookie')!.split(';')[0]};
    }
    await t.test('OAuth checks browser state, PKCE, verified email and refuses silent account merging',async()=>{
      let state=await oauthStart();
      assert.equal((await request(`/v1/auth/oauth/github/callback?state=${state.state}&code=fixture`)).status,400);
      githubVerified=false;
      assert.equal((await request(`/v1/auth/oauth/github/callback?state=${state.state}&code=fixture`,'GET',undefined,undefined,{Cookie:state.cookie})).status,400);
      githubVerified=true; githubEmail='one@example.test'; state=await oauthStart();
      const collision=await request(`/v1/auth/oauth/github/callback?state=${state.state}&code=fixture`,'GET',undefined,undefined,{Cookie:state.cookie});
      assert.equal(collision.status,302); assert(collision.headers.get('location')!.includes('link-required')); assert(lastTokenBody.includes('code_verifier='));
      githubEmail='github@example.test'; state=await oauthStart();
      const success=await request(`/v1/auth/oauth/github/callback?state=${state.state}&code=fixture`,'GET',undefined,undefined,{Cookie:state.cookie});
      assert.equal(success.status,302); assert(success.headers.get('set-cookie')!.includes('HttpOnly'));
      assert.equal((await request(`/v1/auth/oauth/github/callback?state=${state.state}&code=fixture`,'GET',undefined,undefined,{Cookie:state.cookie})).status,400);
    });
    await t.test('restart preserves identities and ownership; suspension and removal are admin-only',async()=>{
      server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));
      server=await createMarket(root,0,options); base=`http://127.0.0.1:${(server.address() as any).port}`;
      assert.equal((await request('/v1/auth/me','GET',undefined,a.token)).status,200);
      assert.equal((await request(`/v1/admin/items/${item}`,'DELETE',undefined,a.token)).status,403);
      assert.equal((await request(`/v1/admin/items/${item}`,'DELETE',undefined,admin)).status,200);
      assert.equal((await request(`/v1/items/${item}/video`)).status,404);
      await assert.rejects(stat(path.join(root,'items',item,'video.mp4')));
      assert.equal((await request(`/v1/admin/users/${a.user.id}`,'POST',{},admin)).status,200);
      assert.equal((await request('/v1/auth/me','GET',undefined,a.token)).status,401);
    });
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); }
});
