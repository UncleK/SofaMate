import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  DownloadManager,
  FreeDemoCommerce,
  publicThemes,
  readCatalog,
  type CatalogVariant,
} from '../src/main/downloads';
import { descriptor, inventory } from '../src/main/files';
import { loadPack } from '../src/main/pack-loader';
import { startDemoSource } from '../src/main/demo-source';
const root = process.cwd();
test('paid downloads require a real commerce provider; catalog transport stays private', async () => {
  const themes = await readCatalog(path.join(root, 'tests/fixtures/catalog.json'));
  const free = themes[0].variants[0],
    paid = { ...free, access: 'paid' } as CatalogVariant;
  const commerce = new FreeDemoCommerce('http://127.0.0.1:1234/');
  assert.equal((await commerce.entitlement(paid)).state, 'purchase-required');
  await assert.rejects(commerce.authorizeDownload(paid), /服务端/);
  await assert.rejects(commerce.checkout(paid), /尚未开通/);
  assert.equal((publicThemes(themes)[0].variants[0] as any).artifact, undefined);
});
test('download validates bytes and identity, cancels, retries, and never overwrites an installed version', async (t) => {
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'test-results/download-test-'));
  const source = path.join(root, 'content/engineering-second/0.1.0'),
    p = await loadPack(source),
    m = p.data.manifest;
  const files = await Promise.all((await inventory(source)).map((n) => descriptor(source, n)));
  const raw = Buffer.from(
    JSON.stringify({ schemaVersion: '1.0', packId: m.packId, version: m.packVersion, files }),
  );
  let mode = 'good';
  const server = createServer(async (req, res) => {
    if (req.url === '/download.json') {
      res.end(raw);
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/other' });
      res.end();
      return;
    }
    if (mode === 'slow') {
      res.write(Buffer.alloc(1));
      return;
    }
    const name = req.url?.slice('/files/'.length) ?? '';
    const found = files.find((f) => f.path === name);
    if (!found) {
      res.writeHead(404);
      res.end();
      return;
    }
    const buffer = await fs.readFile(path.join(source, name));
    if (mode === 'corrupt') buffer[0] ^= 1;
    res.end(buffer);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as any,
    url = `http://127.0.0.1:${address.port}/`;
  const v: CatalogVariant = {
    id: 'test',
    label: 'Test',
    offerId: 'test',
    packId: m.packId,
    version: m.packVersion,
    width: m.canvas.width,
    height: m.canvas.height,
    fps: 30,
    availability: 'ready',
    access: 'free',
    artifact: {
      path: 'download.json',
      sha256: createHash('sha256').update(raw).digest('hex'),
      bytes: raw.length,
    },
  };
  const manager = new DownloadManager(path.join(base, 'library'), new FreeDemoCommerce(url), () => {}, true);
  try {
    mode = 'corrupt';
    await assert.rejects(manager.install(v), /校验失败/);
    assert.equal(manager.status.state, 'failed');
    assert.deepEqual(await fs.readdir(path.join(base, 'library')), []);
    mode = 'redirect';
    await assert.rejects(manager.install(v));
    mode = 'slow';
    const pending = manager.install(v);
    setTimeout(() => manager.cancel(), 100);
    await assert.rejects(pending);
    assert.equal(manager.status.state, 'cancelled');
    mode = 'good';
    const installed = await manager.install(v);
    assert.equal(installed.data.manifest.packId, m.packId);
    await assert.rejects(manager.install(v), /already exists/);
    assert.equal((await loadPack(installed.root)).data.manifest.packVersion, m.packVersion);
    assert((await fs.readdir(path.join(base, 'library'))).every((n) => !n.startsWith('.download-')));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    // Individually inspect/remove only this test's freshly created ordinary files.
    async function clean(dir: string): Promise<void> {
      assert(path.resolve(dir).startsWith(base));
      assert(!(await fs.lstat(dir)).isSymbolicLink());
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name),
          s = await fs.lstat(f);
        assert(!s.isSymbolicLink());
        if (s.isDirectory()) await clean(f);
        else {
          assert(s.isFile() && s.nlink === 1);
          await fs.unlink(f);
        }
      }
      await fs.rmdir(dir);
    }
    await clean(base);
  }
});
