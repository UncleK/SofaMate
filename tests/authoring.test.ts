import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AuthoringWorkspace, initWorkspace } from '../src/authoring/workspace';
import { hashFile, readJson, writeJson } from '../src/main/files';
import { loadPack } from '../src/main/pack-loader';
import { probe } from '../src/authoring/media';
const parent = path.resolve('test-results/authoring');
await fs.mkdir(parent, { recursive: true });

test('prop jobs carry approved references and reject missing or stale ancestor versions', async () => {
  const root = await fs.mkdtemp(path.join(parent, 'props-')), source = path.join(root, 'source'), out = path.join(root, 'work');
  const by = 'synthetic prop test', reason = 'Fixture only';
  try {
    await fs.cp(path.resolve('ScenePack_Codex_Kit/fixtures/second_scene_minimal'), source, { recursive: true });
    const p = await readJson(path.join(source, 'scene.plan.json'));
    p.canvas = { width: 320, height: 180, fpsNumerator: 30, fpsDenominator: 1 };
    p.edges.find((e: any) => e.id === 'quiet_read').referenceAssetIds = ['TEST_PROP'];
    await writeJson(path.join(source, 'scene.plan.json'), p);
    const registry = await readJson(path.join(source, 'assets.registry.json'));
    registry.assets.push({ ...registry.assets[0], id: 'TEST_PROP', parents: ['TEST_ACTOR'] });
    await writeJson(path.join(source, 'assets.registry.json'), registry);
    await writeJson(path.join(source, 'bootstrap.json'), {
      id: 'bootstrap', nodeId: 'desk_read', prompt: 'prompts/video/quiet_read.md', assetIds: ['TEST_STAGE','TEST_ACTOR'],
    });
    await initWorkspace(source, out);
    const w = await AuthoringWorkspace.open(out), media = path.resolve('content/engineering-second/0.1.0/media');
    for (const id of ['TEST_ACTOR','TEST_STAGE']) {
      await w.registerAsset(id, path.join(media,'posters/desk_read.png')); await w.approveAsset(id, by, reason);
    }
    await w.importVideo('bootstrap',path.join(media,'video/quiet_read.mp4'),'opaque-video');
    const proposal = await w.proposeAnchor('bootstrap',29);
    await w.approveAnchor('desk_read', proposal.id, by, reason);
    await assert.rejects(w.prepare('quiet_read'),/Asset needs approval: TEST_PROP/);
    await w.registerAsset('TEST_PROP',path.join(media,'posters/desk_read.png'));
    await assert.rejects(w.prepare('quiet_read'),/Asset needs approval: TEST_PROP/);
    await w.approveAsset('TEST_PROP',by,reason);
    const job = await w.prepare('quiet_read');
    assert.equal(job.references.length,6);
    assert.equal(job.imageBindings[4].tag,'@图片5');
    assert.equal(job.imageBindings[4].role,'TEST_PROP');
    assert.equal(job.references[5].name,'06_motion.mp4');
    assert.equal(await hashFile(path.join(out,job.folder,'05_TEST_PROP.png')),w.state.assets.TEST_PROP.sha256);
    assert.match(await fs.readFile(path.join(out,job.folder,'PROMPT.txt'),'utf8'),/@图片5固定TEST_PROP/);
    await w.registerAsset('TEST_ACTOR',path.join(media,'posters/window_pause.png'));
    await assert.rejects(w.prepare('quiet_read'),/Asset needs approval: TEST_ACTOR/);
    await w.approveAsset('TEST_ACTOR',by,reason);
    await assert.rejects(w.prepare('quiet_read'),/Stale derived asset: TEST_PROP/);
    await assert.rejects(w.approveAsset('TEST_PROP',by,reason),/Stale derived asset/);
    await w.registerAsset('TEST_PROP',path.join(media,'posters/desk_read.png')); await w.approveAsset('TEST_PROP',by,reason);
    await w.prepare('quiet_read');
    const changed = await readJson(path.join(out,'plan/scene.plan.json'));
    changed.edges[0].referenceAssetIds = ['TEST_PROP','TEST_PROP'];
    await writeJson(path.join(out,'plan/scene.plan.json'),changed);
    await assert.rejects(AuthoringWorkspace.open(out),/Invalid additional reference asset IDs/);
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(parent)+path.sep));
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('real FFmpeg authoring round trip: import → trim → frozen anchors → manual reviews → release', async () => {
  const root = await fs.mkdtemp(path.join(parent, 'case-')),
    source = path.join(root, 'source'),
    workRoot = path.join(root, 'work');
  try {
    await fs.cp(path.resolve('ScenePack_Codex_Kit/fixtures/second_scene_minimal'), source, {
      recursive: true,
    });
    const p = await readJson(path.join(source, 'scene.plan.json'));
    p.canvas = { width: 320, height: 180, fpsNumerator: 30, fpsDenominator: 1 };
    await writeJson(path.join(source, 'scene.plan.json'), p);
    await writeJson(path.join(source, 'bootstrap.json'), {
      id: 'bootstrap',
      nodeId: 'desk_read',
      prompt: 'prompts/video/quiet_read.md',
      assetIds: ['TEST_STAGE', 'TEST_ACTOR'],
    });
    await initWorkspace(source, workRoot);
    const w = await AuthoringWorkspace.open(workRoot),
      media = path.resolve('content/engineering-second/0.1.0/media'),
      by = 'synthetic test harness',
      reason = 'Engineering pattern only; not approval of real content';
    await assert.rejects(w.prepare('look_out'), /source anchor/);
    await w.importVideo('bootstrap', path.join(media, 'video/quiet_read.mp4'), 'opaque-video');
    const stale = await w.proposeAnchor('bootstrap', 20);
    await w.trim('bootstrap', 0, 25);
    await assert.rejects(w.approveAnchor('desk_read', stale.id, by, reason), /stale/);
    const first = await w.proposeAnchor('bootstrap', 29);
    const anchor = await w.approveAnchor('desk_read', first.id, by, reason);
    assert.equal(anchor.anchor.frame, 29);
    await assert.rejects(w.approveAnchor('desk_read', first.id, by, reason), /frozen/);
    await w.importVideo('look_out', path.join(media, 'video/look_out.mp4'), 'opaque-video');
    const candidates = await w.candidates('look_out', 3);
    assert.equal(candidates.length, 3);
    assert.equal(candidates.at(-1)!.frame, 29);
    const second = await w.proposeAnchor('look_out', 24);
    await w.approveAnchor('window_pause', second.id, by, reason);
    const final = await probe(path.join(workRoot, w.state.edges.look_out.edit!.path));
    assert.equal(final.frameCount, 25);
    assert.equal(w.state.proposals[second.id].source.rawOutFrameExclusive, 25);
    for (const e of ['quiet_read', 'return_desk']) {
      await w.importVideo(e, path.join(media, 'video', e + '.mp4'), 'opaque-video');
      await w.trim(e, 0, 30);
    }
    for (const asset of ['TEST_ACTOR', 'TEST_STAGE']) {
      await w.registerAsset(asset, path.join(media, 'posters/desk_read.png'));
      await w.approveAsset(asset, by, reason);
    }
    const job = await w.prepare('look_out');
    assert.equal(job.mode, 'convergence');
    assert.equal(job.references.length, 5);
    assert.equal(
      await hashFile(path.join(workRoot, job.folder, '01_start.png')),
      w.state.anchors.desk_read.sha256,
    );
    for (const e of p.edges) await w.approveEdge(e.id, by, reason);
    const pairs = [
      ['__entry__', 'quiet_read'],
      ['__entry__', 'look_out'],
      ['quiet_read', 'quiet_read'],
      ['quiet_read', 'look_out'],
      ['look_out', 'return_desk'],
      ['return_desk', 'quiet_read'],
      ['return_desk', 'look_out'],
    ];
    await assert.rejects(w.reviewJoin('look_out', 'return_desk', true, by, reason), /preview/);
    for (const [a, b] of pairs) {
      const preview = await w.previewJoin(a, b);
      assert((await probe(path.join(workRoot, preview.preview))).frameCount > 0);
      await w.reviewJoin(a, b, true, by, reason);
    }
    const release = await w.build('0.1.0', path.join(root, 'release'));
    assert.equal(release.edges, 3);
    const loaded = await loadPack(release.directory);
    assert.equal(loaded.data.joins.joins.length, 7);
    assert.equal(loaded.data.graph.edges.find((e) => e.id === 'look_out')!.frameCount, 25);
    await assert.rejects(w.build('0.1.0', path.join(root, 'release')), /already exists/);
    await w.trim('look_out', 0, 28);
    assert(!w.state.edges.look_out.approval);
    assert.equal(w.state.seams['look_out/return_desk'].status, 'invalidated');
    await assert.rejects(w.reviewJoin('look_out', 'return_desk', true, by, reason), /preview/);
    assert.equal(
      (await loadPack(release.directory)).data.graph.edges.find((e) => e.id === 'look_out')!.frameCount,
      25,
      'Old release remains immutable',
    );
    await fs.writeFile(path.join(workRoot, '.authoring.lock'), 'locked');
    await assert.rejects(w.trim('quiet_read', 0, 30), /busy/);
    await fs.unlink(path.join(workRoot, '.authoring.lock'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
