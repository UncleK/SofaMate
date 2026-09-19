import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import { createMarket } from '../src/platform/market';
import { inspectVideo, inspectJpeg } from '../src/platform/video';
const video = await readFile('content/engineering-second/0.1.0/media/video/quiet_read.mp4');
const cover = await readFile('tests/fixtures/platform-preview.jpg');
const sha256 = createHash('sha256').update(video).digest('hex');
const results = path.resolve('test-results/platform-api');
await mkdir(results, { recursive: true });
test('real local market: publication, independent downloader, ownership and persistence', async (t) => {
  const root = await mkdtemp(path.join(results, 'run-'));
  let server = await createMarket(root, 0);
  let base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = async (route: string, method = 'GET', body?: unknown, token?: string) =>
    fetch(base + route, {
      method,
      headers: {
        ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body:
        body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
    });
  const a = (await (await request('/v1/sessions', 'POST', { name: 'Author A' })).json()) as any;
  const b = (await (await request('/v1/sessions', 'POST', { name: 'Reader B' })).json()) as any;
  const create = async (digest = sha256) =>
    (
      (await (
        await request(
          '/v1/items',
          'POST',
          { title: '<script>wallpaper</script>', description: 'A & B', bytes: video.length, sha256: digest },
          a.token,
        )
      ).json()) as any
    ).id as string;
  let id = '';
  try {
    await t.test('unpublished and incomplete uploads never enter the market', async () => {
      id = await create();
      assert.equal(((await (await request('/v1/items')).json()) as any).items.length, 0);
      assert.equal((await request(`/v1/items/${id}/publish`, 'POST', undefined, a.token)).status, 400);
      assert.equal((await request(`/v1/items/${id}/video`, 'PUT', video, a.token)).status, 200);
      assert.equal((await request(`/v1/items/${id}/publish`, 'POST', undefined, a.token)).status, 400);
      assert.equal((await request(`/v1/items/${id}/cover`, 'PUT', cover, a.token)).status, 200);
      assert.equal((await request(`/v1/items/${id}/publish`, 'POST', undefined, a.token)).status, 200);
    });
    await t.test('a separate identity downloads identical video and cover with Range support', async () => {
      const listing = (await (await request('/v1/items')).json()) as any;
      assert.equal(listing.items.length, 1);
      assert.equal(listing.items[0].owner, a.id);
      const bytes = Buffer.from(
        await (await request(`/v1/items/${id}/video`, 'GET', undefined, b.token)).arrayBuffer(),
      );
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
      const image = Buffer.from(await (await request(`/v1/items/${id}/cover`)).arrayBuffer());
      assert.deepEqual(image, cover);
      const range = await fetch(base + `/v1/items/${id}/video`, { headers: { Range: 'bytes=7-35' } });
      assert.equal(range.status, 206);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), video.subarray(7, 36));
      assert.equal(
        (await fetch(base + `/v1/items/${id}/video`, { headers: { Range: 'bytes=999999999-' } })).status,
        416,
      );
    });
    await t.test('owner-only withdrawal, immutable published data and escaped sharing page', async () => {
      assert.equal((await request(`/v1/items/${id}`, 'DELETE', undefined, b.token)).status, 400);
      assert.equal((await request(`/v1/items/${id}/video`, 'PUT', video, a.token)).status, 400);
      const html = await (await request(`/wallpaper/${id}`)).text();
      assert(html.includes('&lt;script&gt;wallpaper&lt;/script&gt;'));
      assert(!html.includes('<script>wallpaper'));
    });
    await t.test('bad hash and invalid cover are rejected without publication', async () => {
      const bad = await create('0'.repeat(64));
      assert.equal((await request(`/v1/items/${bad}/video`, 'PUT', video, a.token)).status, 400);
      assert(!(await readdir(path.join(root, 'items', bad))).includes('video.mp4.upload'));
      assert.equal((await request(`/v1/items/${bad}/cover`, 'PUT', Buffer.alloc(64), a.token)).status, 400);
      assert.equal(((await (await request('/v1/items')).json()) as any).items.length, 1);
    });
    await t.test('cross-site writes and DNS rebinding hosts are rejected', async () => {
      assert.equal(
        (
          await fetch(base + '/v1/sessions', {
            method: 'POST',
            headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' },
            body: '{"name":"bad"}',
          })
        ).status,
        403,
      );
      const code = await new Promise<number | undefined>((resolve, reject) => {
        const r = http.get(base + '/health', { headers: { Host: 'other.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        r.on('error', reject);
      });
      assert.equal(code, 403);
      assert.equal(
        (await fetch(base + `/v1/items/${id}/cover`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
        200,
      );
    });
    await t.test('market and ownership survive restart; withdrawal removes public access', async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      server = await createMarket(root, 0);
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      assert.equal(((await (await request('/v1/items')).json()) as any).items[0].id, id);
      assert.equal((await request(`/v1/items/${id}`, 'DELETE', undefined, a.token)).status, 200);
      assert.equal(((await (await request('/v1/items')).json()) as any).items.length, 0);
      assert.equal((await request(`/v1/items/${id}/video`)).status, 404);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test('bounded media checks reject forged extensions, codec and truncation', async () => {
  const root = await mkdtemp(path.join(results, 'media-'));
  const good = await inspectVideo('content/engineering-second/0.1.0/media/video/quiet_read.mp4');
  assert.equal(good.width, 320);
  assert.equal(good.height, 180);
  inspectJpeg(cover);
  for (const [name, bytes] of [
    ['not-video', Buffer.from('not an mp4'.repeat(10))],
    ['truncated', video.subarray(0, 120)],
    ['hevc', Buffer.from(video)],
  ] as const) {
    if (name === 'hevc') {
      const i = bytes.indexOf('avc1', bytes.indexOf('moov'));
      assert(i > 0);
      bytes.write('hvc1', i);
    }
    const file = path.join(root, name + '.mp4');
    await writeFile(file, bytes);
    await assert.rejects(inspectVideo(file));
  }
  assert.throws(() => inspectJpeg(Buffer.alloc(64)));
  assert.throws(() => inspectJpeg(cover.subarray(0, 100)));
});
