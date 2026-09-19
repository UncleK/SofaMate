import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topology } from './fixtures/topology';
import { PlaybackMachine } from '../src/core/graph';
import { validateRelease } from '../src/core/validate';
const p = topology;
test('random starts cover the 28 approved clips and every continuation obeys its explicit whitelist', () => {
  const starts = new Set<string>(),
    branches = new Map<string, Set<string>>();
  for (let seed = 1; seed <= 500; seed++) {
    const m = new PlaybackMachine(p, Math.imul(seed, 15485863));
    let last: string | null = null;
    for (let turn = 0; turn < 30; turn++) {
      const e = m.begin();
      if (last === null) starts.add(e.id);
      else {
        assert(
          p.joins.joins.some((j) => j.incomingEdgeId === last && j.outgoingEdgeId === e.id),
          `${last} -> ${e.id}`,
        );
        if (!branches.has(last)) branches.set(last, new Set());
        branches.get(last)!.add(e.id);
      }
      m.presentedLastFrame(e.id, e.outFrameExclusive - 1);
      last = e.id;
    }
  }
  assert.equal(starts.size, 28);
  assert.equal(branches.get('E00')!.size, 6);
});
test('startup permission does not bypass an invalid join after playback, and binds media hash/trim', () => {
  const m = new PlaybackMachine(p, 12),
    e = m.begin('E24');
  m.presentedLastFrame(e.id, e.outFrameExclusive - 1);
  assert.throws(() => m.begin('E00'), /illegal/);
  const bad = structuredClone(p);
  bad.manifest.startPoints![0].mediaHash = '0'.repeat(64);
  assert.throws(() => validateRelease(bad), /stale start point/);
});
