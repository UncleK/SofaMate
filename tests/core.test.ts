import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { GraphCore, PlaybackMachine, Scheduler } from '../src/core/graph';
import { safeRelative, validateRelease } from '../src/core/validate';
import { loadPack } from '../src/main/pack-loader';
const original = (await loadPack('content/engineering-graph/0.1.0')).data;
const copy = () => structuredClone(original);
test('both unrelated content graphs load through the same core', async () => {
  new GraphCore(copy());
  const p = (await loadPack('content/engineering-second/0.1.0')).data;
  new GraphCore(p);
  assert(!p.graph.nodes[0].id.startsWith('P'));
});
test('unknown endpoints, duplicate IDs and unreachable published edges are rejected', () => {
  let p = copy();
  p.graph.edges[0].to = 'missing';
  assert.throws(() => validateRelease(p), /endpoint/);
  p = copy();
  p.graph.nodes.push(p.graph.nodes[0]);
  assert.throws(() => validateRelease(p), /Duplicate/);
  p = copy();
  p.joins.joins = p.joins.joins.filter((j) => j.outgoingEdgeId !== 'E12');
  assert.throws(() => validateRelease(p), /Unreachable/);
});
test('join validation binds review to media, trim and both anchor versions', () => {
  for (const mutate of [
    (p: any) => (p.joins.joins[0].status = 'pending'),
    (p: any) => (p.joins.joins[0].outgoingMediaHash = '0'.repeat(64)),
    (p: any) => (p.joins.joins[0].incomingTrimFingerprint = 'wrong'),
    (p: any) => (p.graph.edges[0].sourceAnchorVersion = 'v002'),
  ]) {
    const p = copy();
    mutate(p);
    assert.throws(() => validateRelease(p));
  }
});
test('long blends, opaque overlays and authoring plan masquerades fail closed', () => {
  let p = copy();
  (p.joins.joins[0] as any).method = 'micro-blend';
  p.joins.joins[0].blendFrames = 10;
  assert.throws(() => validateRelease(p));
  p = copy();
  p.manifest.mediaProfile = 'opaque-video';
  assert.throws(() => validateRelease(p), /Opaque/);
  assert.throws(() => validateRelease({ schemaVersion: '1.0', nodes: [], edges: [] }));
});
test('expanded-state path search cannot bypass a rejected convergence', () => {
  const p = copy();
  p.graph.edges.find((e) => e.id === 'E12')!.cooldownSec = 0;
  p.joins.joins = p.joins.joins.filter((j) => !(j.incomingEdgeId === 'E03' && j.outgoingEdgeId === 'E04'));
  const graph = new GraphCore(p);
  const cursor = { nodeId: 'P2', incomingEdgeId: 'E03' };
  assert(!graph.next(cursor).some((e) => e.id === 'E04'));
  assert.equal(graph.path(cursor, 'P0')?.[0].id, 'E12');
});
test('cooldown-safe successors are required at every reachable incoming edge', () => {
  const p = copy();
  for (const e of p.graph.edges.filter((e) => e.from === 'P3')) e.cooldownSec = 10;
  assert.throws(() => validateRelease(p), /Cooldown dead end/);
});
test('seeded scheduling is repeatable, cooldown blocks immediate snack loop', () => {
  const p = copy(),
    a = new Scheduler(new GraphCore(p), 10),
    b = new Scheduler(new GraphCore(p), 10),
    cursor = { nodeId: 'P0', incomingEdgeId: null };
  assert.deepEqual(
    Array.from({ length: 100 }, () => a.choose(cursor, 1000).id),
    Array.from({ length: 100 }, () => b.choose(cursor, 1000).id),
  );
  const snack = p.graph.edges.find((e) => e.id === 'E09')!;
  a.complete(snack, 100);
  assert(!a.eligible({ nodeId: 'P4', incomingEdgeId: 'E09' }, 110).some((e) => e.id === 'E09'));
  assert(a.eligible({ nodeId: 'P4', incomingEdgeId: 'E09' }, 110).length);
});
test('snapshot commits only after the approved last frame and never twice', () => {
  const m = new PlaybackMachine(copy());
  const e = m.begin('E03');
  assert.equal(m.cursor.nodeId, 'P0');
  assert.throws(() => m.presentedLastFrame(e.id, e.outFrameExclusive - 2));
  m.paused = true;
  assert.throws(() => m.presentedLastFrame(e.id, e.outFrameExclusive - 1));
  m.paused = false;
  assert.equal(m.presentedLastFrame(e.id, e.outFrameExclusive - 1).pose, 'forward_seated');
  assert.equal(m.cursor.nodeId, 'P2');
  assert.throws(() => m.presentedLastFrame(e.id, e.outFrameExclusive - 1));
  m.fault = 'decode';
  m.reset();
  assert.equal(m.cursor.nodeId, pickEntry());
  assert.equal(m.completed, 0);
  assert.equal(m.fault, null);
});
function pickEntry() {
  return original.manifest.entryNode;
}
test('10,000 legal transitions preserve a single active edge and return safely', () => {
  const m = new PlaybackMachine(copy(), 97);
  for (let i = 0; i < 10000; i++) {
    const e = m.begin();
    assert.equal(e.from, m.cursor.nodeId);
    m.presentedLastFrame(e.id, e.outFrameExclusive - 1);
  }
  assert.equal(m.completed, 10000);
});
test('paths reject Windows, encoded and portable escape forms', () => {
  for (const s of [
    '../x',
    '/x',
    'C:/x',
    'a\\..\\x',
    '//server/share',
    'https://x',
    'a/%2e%2e/x',
    'a//x',
    'NUL.mp4',
    'a/../b',
    'a/x.',
  ])
    assert.throws(() => safeRelative(s), s);
  safeRelative('media/video/sample_01.mp4');
});
test('core has no content imports or example constants', async () => {
  for (const name of await fs.readdir('src/core')) {
    const text = await fs.readFile('src/core/' + name, 'utf8');
    assert(!/living.room|客厅|P[0-5]\b|snack|eatSnack|node:fs|electron/.test(text), name);
  }
});
