import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inspectVideo, inspectJpeg, MAX_VIDEO_BYTES, type VideoInfo } from './video';
import { createAuth } from './auth';
import { MarketError, matches, serial, type MarketOptions } from './market-access';

interface Item {
  id: string;
  owner: string;
  author: string;
  title: string;
  description: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  state: 'draft' | 'published' | 'withdrawn';
  info?: VideoInfo;
}
interface Session {
  id: string;
  name: string;
}
const validId = (s: string) => /^[a-f0-9-]{36}$/.test(s);
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
async function jsonBody(req: IncomingMessage, max = 16384): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Error('需要 JSON 请求');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function text(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim()))
    throw Error('标题、简介或昵称长度无效');
  return value.trim();
}
export async function createMarket(root: string, port = 47831, options: MarketOptions = {}) {
  root = path.resolve(root);
  const publicMode = !!options.publicOrigin;
  const origin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (origin && (origin.protocol !== 'https:' || origin.origin !== options.publicOrigin || !options.adminTokenHash?.match(/^[a-f0-9]{64}$/))) throw Error('Public mode requires an HTTPS origin and admin token hash');
  await mkdir(path.join(root, 'items'), { recursive: true });
  await mkdir(path.join(root, 'sessions'), { recursive: true });
  const auth = publicMode ? createAuth(root, options.publicOrigin!, options.auth) : null;
  const isAdmin = (req: IncomingMessage) => matches(req.headers.authorization?.replace(/^Bearer /, '') ?? '', options.adminTokenHash);
  const mutate = serial();
  const catalog = new Map<string, Item>();
  let uploads = 0;
  const busy = new Set<string>();
  const itemDir = (id: string) => {
    if (!validId(id)) throw Error('内容不存在');
    return path.join(root, 'items', id);
  };
  const readItem = async (id: string): Promise<Item> =>
    JSON.parse(await readFile(path.join(itemDir(id), 'item.json'), 'utf8'));
  async function saveItem(item: Item) {
    const p = path.join(itemDir(item.id), 'item.json');
    await writeFile(p + '.tmp', JSON.stringify(item));
    await rename(p + '.tmp', p);
    catalog.set(item.id, item);
  }
  async function erase(item: Item) {
    const dir = itemDir(item.id);
    // Files in an item directory have fixed names. Never delete a caller-supplied path.
    for (const name of ['video.mp4', 'video.mp4.upload', 'cover.jpg', 'cover.jpg.upload', 'item.json.tmp']) await unlink(path.join(dir, name)).catch(e => { if(e.code !== 'ENOENT') throw e; });
    item.state = 'withdrawn'; await saveItem(item);
    catalog.delete(item.id);
  }
  for (const dir of await readdir(path.join(root, 'items'), { withFileTypes: true })) {
    if (!dir.isDirectory() || !validId(dir.name)) continue;
    const item = await readItem(dir.name);
    if (item.id !== dir.name || !Number.isSafeInteger(item.bytes) || item.bytes < 32 || item.bytes > MAX_VIDEO_BYTES) throw Error('Invalid market item metadata');
    if (publicMode && (item.state === 'withdrawn' || item.state === 'draft' && Date.parse(item.createdAt) < Date.now() - 86400000)) await erase(item);
    else if (item.state !== 'withdrawn') catalog.set(item.id, item);
    for (const name of ['video.mp4.upload', 'cover.jpg.upload']) await unlink(path.join(itemDir(item.id), name)).catch(e => { if(e.code !== 'ENOENT') throw e; });
  }
  async function session(req: IncomingMessage): Promise<Session> {
    if (auth) return auth.session(req);
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) throw Error('请先连接本机市场');
    const key = createHash('sha256').update(token).digest('hex');
    try {
      return JSON.parse(await readFile(path.join(root, 'sessions', key + '.json'), 'utf8'));
    } catch {
      throw Error('市场身份已失效，请重新连接');
    }
  }
  async function owned(req: IncomingMessage, id: string) {
    const s = await session(req),
      item = await readItem(id);
    if (item.owner !== s.id) throw Error('只能操作自己的分享');
    return item;
  }
  const publicItem = (i: Item) => ({
    id: i.id,
    owner: i.owner,
    author: i.author,
    title: i.title,
    description: i.description,
    bytes: i.bytes,
    sha256: i.sha256,
    createdAt: i.createdAt,
    info: i.info,
    coverPath: `/v1/items/${i.id}/cover`,
    downloadPath: `/v1/items/${i.id}/video`,
    sharePath: `/wallpaper/${i.id}`,
  });
  function respond(res: ServerResponse, code: number, value: unknown) {
    if (!res.headersSent)
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, mime: string) {
    const total = (await stat(file)).size;
    let start = 0,
      end = total - 1,
      status = 200;
    if (req.headers.range) {
      const match = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
      if (!Number.isSafeInteger(start) || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      status = 206;
    }
    res.writeHead(status, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    });
    if (req.method === 'HEAD') res.end();
    else await pipeline(createReadStream(file, { start, end }), res);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Native clients have no Origin. Browser mutations must be same-origin and use JSON/bearer auth.
    if (
      !['GET', 'HEAD'].includes(req.method ?? '') &&
      ((req.headers.origin && req.headers.origin !== options.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site')
    ) {
      respond(res, 403, { error: '不接受跨站请求' });
      return;
    }
    if (origin ? req.headers.host !== origin.host : !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) {
      respond(res, 403, { error: '访问地址无效' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;
    try {
      if (auth && await auth.handle(req, res, url, () => jsonBody(req))) return;
      if (req.method === 'GET' && route === '/health') {
        respond(res, 200, { service: 'sofamate-market', schemaVersion: 2, public: publicMode });
        return;
      }
      if (req.method === 'POST' && route === '/v1/sessions') {
        if (publicMode) throw new MarketError(403, '请使用邮箱、GitHub 或 Google 登录');
        const name = text((await jsonBody(req)).name, 40);
        const token = randomBytes(32).toString('hex'),
          s = { id: randomUUID(), name };
        await writeFile(
          path.join(root, 'sessions', createHash('sha256').update(token).digest('hex') + '.json'),
          JSON.stringify(s),
          { flag: 'wx' },
        );
        respond(res, 201, { ...s, token });
        return;
      }
      const admin = route.match(/^\/v1\/admin\/(items|users)\/([a-f0-9-]{36})$/);
      if (admin) {
        if (!isAdmin(req)) throw new MarketError(403, '需要管理员权限');
        if (admin[1] === 'users' && req.method === 'POST' && auth) { auth.suspend(admin[2]); respond(res, 200, { suspended: true }); return; }
        if (admin[1] === 'items' && req.method === 'DELETE') {
          if (busy.has(admin[2])) throw new MarketError(409, '这条分享正在上传，请稍后重试');
          busy.add(admin[2]); try { await erase(await readItem(admin[2])); } finally { busy.delete(admin[2]); }
          respond(res, 200, { withdrawn: true }); return;
        }
      }
      if (req.method === 'GET' && route === '/v1/items/mine') {
        const user = await session(req);
        respond(res, 200, { items: [...catalog.values()].filter(i => i.owner === user.id).map(i => ({ ...publicItem(i), state: i.state })) }); return;
      }
      if (req.method === 'GET' && route === '/v1/items') {
        const q = (url.searchParams.get('q') ?? '').slice(0, 100).toLocaleLowerCase();
        const items: Item[] = [];
        for (const i of catalog.values()) {
            if (
              i.state === 'published' &&
              `${i.title} ${i.description} ${i.author}`.toLocaleLowerCase().includes(q)
            )
              items.push(i);
        }
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const sorted = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        respond(res, 200, {
          items: sorted.slice(offset, offset + 50).map(publicItem),
          total: sorted.length,
          nextOffset: offset + 50 < sorted.length ? offset + 50 : null,
        });
        return;
      }
      if (req.method === 'POST' && route === '/v1/items') {
        const s = await session(req),
          data = await jsonBody(req);
        if (
          !Number.isSafeInteger(data.bytes) ||
          data.bytes < 32 ||
          data.bytes > MAX_VIDEO_BYTES ||
          !/^[a-f0-9]{64}$/.test(data.sha256)
        )
          throw Error('视频大小或校验值无效');
        const i: Item = {
          id: randomUUID(),
          owner: s.id,
          author: s.name,
          title: text(data.title, 80),
          description: text(data.description ?? '', 1000, false),
          bytes: data.bytes,
          sha256: data.sha256,
          createdAt: new Date().toISOString(),
          state: 'draft',
        };
        await mutate(async () => {
          const all = [...catalog.values()], mine = all.filter(v => v.owner === s.id);
          const used = (rows: Item[]) => rows.reduce((n, v) => n + v.bytes + 1024 * 1024, 0);
          if (all.length >= (options.maxItems ?? 1000) || used(all) + i.bytes + 1024 * 1024 > (options.maxTotalBytes ?? 10 * 1024 ** 3)) throw new MarketError(507, '市场容量已满，请稍后再试');
          if (mine.length >= (options.maxOwnerItems ?? 50) || used(mine) + i.bytes + 1024 * 1024 > (options.maxOwnerBytes ?? 2 * 1024 ** 3)) throw new MarketError(413, '已达到账号分享容量上限，请先撤回不需要的分享');
          if (mine.filter(v => v.state === 'draft').length >= 5) throw new MarketError(429, '未完成的分享过多，请先清理草稿');
          await mkdir(itemDir(i.id)); await saveItem(i);
        });
        respond(res, 201, { id: i.id });
        return;
      }
      const match = route.match(/^\/v1\/items\/([a-f0-9-]{36})(?:\/(video|cover|publish))?$/);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' || req.method === 'HEAD') {
          const i = catalog.get(id);
          if (!i || i.state !== 'published') {
            respond(res, 404, { error: '分享不存在或已撤回' });
            return;
          }
          if (action === 'video' || action === 'cover') {
            await sendFile(
              req,
              res,
              path.join(itemDir(id), action === 'video' ? 'video.mp4' : 'cover.jpg'),
              action === 'video' ? 'video/mp4' : 'image/jpeg',
            );
            return;
          }
          if (!action) {
            respond(res, 200, publicItem(i));
            return;
          }
        }
        const item = await owned(req, id);
        if (busy.has(id)) throw Error('这条分享正在上传，请稍后重试');
        busy.add(id);
        try {
        if (req.method === 'DELETE' && !action) {
          await erase(item);
          respond(res, 200, { withdrawn: true });
          return;
        }
        if (item.state !== 'draft') throw Error('已发布的文件不能覆盖，请创建新分享');
        if (req.method === 'PUT' && (action === 'video' || action === 'cover')) {
          const expected = Number(req.headers['content-length']),
            max = action === 'video' ? item.bytes : 1024 * 1024;
          if (
            !Number.isSafeInteger(expected) ||
            expected < 32 ||
            expected > max ||
            (action === 'video' && expected !== item.bytes)
          )
            throw Error('文件大小不匹配');
          const dir = itemDir(id),
            target = path.join(dir, action === 'video' ? 'video.mp4' : 'cover.jpg'),
            temp = target + '.upload';
          if (uploads >= 2) throw new MarketError(429, '正在上传的用户较多，请稍后重试');
          uploads++;
          let bytes = 0;
          const digest = createHash('sha256');
          try {
            await pipeline(
              req,
              new Transform({
                transform(chunk, _, done) {
                  bytes += chunk.length;
                  if (bytes > expected) return done(Error('上传超出声明大小'));
                  digest.update(chunk);
                  done(null, chunk);
                },
              }),
              createWriteStream(temp, { flags: 'wx' }),
            );
            if (bytes !== expected) throw Error('上传未完成');
            if (action === 'video') {
              if (digest.digest('hex') !== item.sha256) throw Error('视频校验失败');
              item.info = await inspectVideo(temp);
            } else inspectJpeg(await readFile(temp));
            await rename(temp, target);
            await saveItem(item);
            respond(res, 200, { uploaded: true });
          } finally {
            uploads--;
            await unlink(temp).catch(() => {});
          }
          return;
        }
        if (req.method === 'POST' && action === 'publish') {
          if (!item.info) throw Error('视频尚未上传完成');
          await stat(path.join(itemDir(id), 'video.mp4'));
          inspectJpeg(await readFile(path.join(itemDir(id), 'cover.jpg')));
          item.state = 'published';
          await saveItem(item);
          respond(res, 200, publicItem(item));
          return;
        }
        } finally { busy.delete(id); }
      }
      const page = route.match(/^\/wallpaper\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && page) {
        const i = await readItem(page[1]);
        if (i.state !== 'published') {
          respond(res, 404, { error: '分享不存在或已撤回' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="description" content="${escape(i.description.slice(0,160))}"><title>${escape(i.title)} · SofaMate</title><style>body{background:#242323;color:#ece8e1;font:16px system-ui;max-width:960px;margin:5vh auto;padding:24px}img{width:100%;border-radius:16px}h1{font-size:clamp(30px,5vw,52px);letter-spacing:-1px}p{white-space:pre-wrap;color:#a8a29a;line-height:1.8}a{display:inline-block;background:#c9ae8a;color:#29251f;padding:12px 20px;border-radius:8px;text-decoration:none}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:48px}header a{background:none;color:#ece8e1;padding:0;font-weight:600}small{color:#aaa}</style><header><a href="/">SofaMate</a><small>COMMUNITY / 分享市场</small></header><h1>${escape(i.title)}</h1><p>${escape(i.author)} · ${i.info!.width} × ${i.info!.height}</p><img src="/v1/items/${i.id}/cover" alt="视频九宫格预览"><p>${escape(i.description)}</p><a href="/v1/items/${i.id}/video" download="wallpaper.mp4">下载视频 ↓</a><p>${publicMode ? '下载后在 SofaMate 中导入，即可设为桌面壁纸。' : '此链接仅可在运行市场服务的这台电脑访问。'}</p></html>`,
        );
        return;
      }
      respond(res, 404, { error: '接口不存在' });
    } catch (e) {
      if (!res.destroyed)
        respond(res, e instanceof MarketError ? e.status : 400, {
          error: e instanceof Error && !('code' in e) ? e.message : '文件不存在或操作未完成',
        });
    }
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 15000;
  const cleanupTimer = publicMode ? setInterval(() => {
    void mutate(async () => {
      for (const item of catalog.values()) {
        if (item.state !== 'draft' || Date.parse(item.createdAt) > Date.now() - 86400000 || busy.has(item.id)) continue;
        busy.add(item.id);
        try { await erase(item); } finally { busy.delete(item.id); }
      }
    }).catch(() => console.error('Expired draft cleanup failed'));
  }, 60000) : null;
  cleanupTimer?.unref();
  server.on('close', () => { if (cleanupTimer) clearInterval(cleanupTimer); auth?.close(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
