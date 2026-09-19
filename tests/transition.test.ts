import test from 'node:test';
import assert from 'node:assert/strict';
import { topology } from './fixtures/topology';
import { validateRelease } from '../src/core/validate';
import { PlaybackMachine } from '../src/core/graph';
import { blendWeight } from '../src/core/transition';

const original = topology;
function withBlend() {
  const pack = structuredClone(original);
  pack.manifest.requiredCapabilities.push('smooth-crossfade');
  for (const j of pack.joins.joins) if (j.incomingEdgeId !== '__entry__') {
    j.method = 'smooth-crossfade';
    j.blendFrames = 10;
  }
  return pack;
}
test('short B transitions preserve the exact approved adjacency list', () => {
  const p = validateRelease(withBlend());
  assert.deepEqual(p.joins.joins.map(j=>[j.incomingEdgeId,j.outgoingEdgeId]),
    original.joins.joins.map(j=>[j.incomingEdgeId,j.outgoingEdgeId]));
  for (const mutate of [
    (p: any) => p.manifest.requiredCapabilities.pop(),
    (p: any) => { p.joins.joins.find((j:any)=>j.method==='smooth-crossfade').blendFrames = 13; },
    (p: any) => { p.joins.joins.find((j:any)=>j.incomingEdgeId==='__entry__').method='smooth-crossfade'; },
  ]) { const broken = withBlend(); mutate(broken); assert.throws(()=>validateRelease(broken)); }
});
test('overlapped successor prefix is counted once, with strict endpoint commit', () => {
  const machine = new PlaybackMachine(withBlend(), 7);
  const a = machine.begin();
  machine.presentedLastFrame(a.id, a.outFrameExclusive - 1);
  const b = machine.begin();
  assert.throws(()=>machine.presentedLastFrame(b.id, b.outFrameExclusive - 2, 10));
  machine.presentedLastFrame(b.id, b.outFrameExclusive - 1, 10);
  assert(Math.abs(machine.elapsed - (a.actualDurationSec + b.actualDurationSec - 10/24)) < 1e-8);
  assert.equal(machine.completed, 2);
});
test('B opacity is bounded and monotonic with exact endpoints', () => {
  assert.equal(blendWeight(0,10),0);
  assert.equal(blendWeight(5,10),0.5);
  assert.equal(blendWeight(10,10),1);
  assert.equal(blendWeight(20,10),1);
  for(let n=0;n<100;n++) assert(blendWeight(n/10,10)<=blendWeight((n+1)/10,10));
  assert.throws(()=>blendWeight(Number.NaN,10));
});
