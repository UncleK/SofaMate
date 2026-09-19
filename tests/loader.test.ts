import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadPack, installPack } from '../src/main/pack-loader';
import { hashFile, readJson, writeJson, safeFile } from '../src/main/files';
import { mp4Info } from '../src/main/mp4';
const root = path.resolve('test-results/loader');
await fs.mkdir(root, { recursive: true });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(root, 'case-'));
  await fs.cp(path.resolve('content/engineering-second/0.1.0'), dir, { recursive: true });
  return dir;
}
async function withFixture(body: (dir: string) => Promise<void>) {
  const dir = await fixture();
  try {
    await body(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test('missing file and modified media never load', async () => {
  await withFixture(async (dir) => {
    await fs.unlink(path.join(dir, 'media/video/quiet_read.mp4'));
    await assert.rejects(loadPack(dir));
  });
  await withFixture(async (dir) => {
    await fs.appendFile(path.join(dir, 'media/video/quiet_read.mp4'), 'tampered');
    await assert.rejects(loadPack(dir), /Hash mismatch/);
  });
});
test('even matching checksums cannot lie about decoded dimensions', async () => {
  await withFixture(async (dir) => {
    const graph = await readJson(path.join(dir, 'graph.json'));
    graph.edges[0].decodedWidth += 2;
    await writeJson(path.join(dir, 'graph.json'), graph);
    const m = await readJson(path.join(dir, 'manifest.json'));
    m.graph.sha256 = await hashFile(path.join(dir, 'graph.json'));
    m.graph.bytes = (await fs.stat(path.join(dir, 'graph.json'))).size;
    await writeJson(path.join(dir, 'manifest.json'), m);
    const checks = await readJson(path.join(dir, 'checksums.json'));
    checks['graph.json'] = m.graph.sha256;
    checks['manifest.json'] = await hashFile(path.join(dir, 'manifest.json'));
    await writeJson(path.join(dir, 'checksums.json'), checks);
    await assert.rejects(loadPack(dir), /dimensions/);
  });
});
test('extra code and archives are rejected without extraction', async () => {
  await withFixture(async (dir) => {
    await fs.writeFile(path.join(dir, 'inject.js'), 'throw Error()');
    await assert.rejects(loadPack(dir), /Unsupported/);
  });
  const file = path.join(root, 'bomb.zip');
  await fs.writeFile(file, 'fake zip');
  try {
    await assert.rejects(installPack(file, path.join(root, 'library')), /unpacked/);
  } finally {
    await fs.unlink(file);
  }
});
test('Windows directory junctions and hardlinks are rejected', async () => {
  await withFixture(async (dir) => {
    const junction = path.join(dir, 'escape');
    await fs.symlink(root, junction, 'junction');
    await assert.rejects(safeFile(dir, 'escape/bogus'), /Symbolic/);
    await fs.unlink(junction);
    const a = path.join(dir, 'media/video/quiet_read.mp4'),
      b = path.join(dir, 'media/video/link.mp4');
    await fs.link(a, b);
    await assert.rejects(safeFile(dir, 'media/video/link.mp4'), /Hardlink/);
  });
});
test('review evidence edits fail even when outer checksums are regenerated', async () => {
  await withFixture(async (dir) => {
    const joins = await readJson(path.join(dir, 'joins.json'));
    const file = joins.joins[0].evidencePath;
    const evidence = await readJson(path.join(dir, file));
    evidence.join.approvedBy = 'someone else';
    await writeJson(path.join(dir, file), evidence);
    const checks = await readJson(path.join(dir, 'checksums.json'));
    checks[file] = await hashFile(path.join(dir, file));
    await writeJson(path.join(dir, 'checksums.json'), checks);
    await assert.rejects(loadPack(dir), /evidence/);
  });
});
test('install makes an independent immutable version and refuses collisions', async () => {
  const library = await fs.mkdtemp(path.join(root, 'library-'));
  try {
    const installed = await installPack(path.resolve('content/engineering-second/0.1.0'), library);
    assert(installed.root.startsWith(library));
    await assert.rejects(
      installPack(path.resolve('content/engineering-second/0.1.0'), library),
      /already exists/,
    );
  } finally {
    await fs.rm(library, { recursive: true, force: true });
  }
});
test('bounded MP4 reader rejects truncated/corrupt atom lengths', async () => {
  const source = await fs.readFile('content/engineering-second/0.1.0/media/video/quiet_read.mp4');
  assert.equal(mp4Info(source).frameCount, 30);
  assert.throws(() => mp4Info(source.subarray(0, 30)));
  const bad = Buffer.from(source);
  bad.writeUInt32BE(0xffffffff, 0);
  assert.throws(() => mp4Info(bad), /length/);
});
