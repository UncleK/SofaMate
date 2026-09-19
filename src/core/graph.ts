import { ensure, validateRelease } from './validate';
import type { Cursor, EdgeClip, LoadedPack } from './types';
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

export class GraphCore {
  constructor(readonly pack: LoadedPack) {
    validateRelease(pack);
  }
  next(cursor: Cursor): EdgeClip[] {
    const approved = new Set(
      this.pack.joins.joins
        .filter(
          (j) => j.incomingEdgeId === (cursor.incomingEdgeId ?? '__entry__') && j.nodeId === cursor.nodeId,
        )
        .map((j) => j.outgoingEdgeId),
    );
    return this.pack.graph.edges.filter((e) => e.from === cursor.nodeId && approved.has(e.id));
  }
  path(cursor: Cursor, target: string): EdgeClip[] | null {
    ensure(
      this.pack.graph.nodes.some((n) => n.id === target),
      'Unknown requested node',
    );
    const seen = new Set<string>(),
      queue = [{ cursor, path: [] as EdgeClip[] }];
    while (queue.length) {
      const state = queue.shift()!,
        key = JSON.stringify(state.cursor);
      if (seen.has(key)) continue;
      seen.add(key);
      if (state.cursor.nodeId === target) return state.path;
      for (const e of this.next(state.cursor))
        queue.push({ cursor: { nodeId: e.to, incomingEdgeId: e.id }, path: [...state.path, e] });
    }
    return null;
  }
}
export class Scheduler {
  private randomState: number;
  private completedAt = new Map<string, number>();
  constructor(
    readonly graph: GraphCore,
    seed = randomSeed(),
  ) {
    this.randomState = seed >>> 0;
  }
  reset(seed = randomSeed()) {
    this.completedAt.clear();
    this.randomState = seed >>> 0;
  }
  eligible(cursor: Cursor, elapsed: number, completing?: EdgeClip) {
    return this.graph
      .next(cursor)
      .filter(
        (e) =>
          elapsed >= e.initialDelaySec &&
          elapsed - (this.completedAt.get(e.cooldownGroup ?? e.id) ?? -Infinity) >= e.cooldownSec &&
          !(
            completing &&
            (e.cooldownGroup ?? e.id) === (completing.cooldownGroup ?? completing.id) &&
            e.cooldownSec > 0
          ),
      );
  }
  choose(cursor: Cursor, elapsed: number, preferred?: string, completing?: EdgeClip): EdgeClip {
    const candidates = this.eligible(cursor, elapsed, completing);
    ensure(candidates.length, 'No approved successor');
    if (preferred) {
      const e = candidates.find((e) => e.id === preferred);
      ensure(e, 'Requested edge is illegal or cooling down');
      return e;
    }
    return this.pick(candidates);
  }
  pick(candidates: EdgeClip[]): EdgeClip {
    ensure(candidates.length > 0, 'No eligible clips');
    this.randomState = (Math.imul(1664525, this.randomState) + 1013904223) >>> 0;
    let v = (this.randomState / 4294967296) * candidates.reduce((s, e) => s + e.weight, 0);
    for (const e of candidates) {
      v -= e.weight;
      if (v < 0) return e;
    }
    return candidates.at(-1)!;
  }
  complete(e: EdgeClip, elapsed: number) {
    this.completedAt.set(e.cooldownGroup ?? e.id, elapsed);
  }
}
export class PlaybackMachine {
  readonly graph: GraphCore;
  readonly scheduler: Scheduler;
  cursor: Cursor;
  active: EdgeClip | null = null;
  paused = false;
  elapsed = 0;
  completed = 0;
  fault: string | null = null;
  constructor(
    readonly pack: LoadedPack,
    private readonly seed?: number,
  ) {
    this.graph = new GraphCore(pack);
    this.scheduler = new Scheduler(this.graph, seed);
    this.cursor = { nodeId: pack.manifest.entryNode, incomingEdgeId: null };
  }
  begin(id?: string) {
    ensure(!this.active && !this.fault && !this.paused, 'Cannot begin in current state');
    if (this.completed === 0 && this.cursor.incomingEdgeId === null && this.pack.manifest.startPoints) {
      const starts = new Set(this.pack.manifest.startPoints.map((s) => s.edgeId));
      const candidates = this.pack.graph.edges.filter((e) => starts.has(e.id));
      ensure(!id || starts.has(id), 'Requested startup clip is not approved');
      this.active = id ? candidates.find((e) => e.id === id)! : this.scheduler.pick(candidates);
      this.cursor = { nodeId: this.active.from, incomingEdgeId: null };
      return this.active;
    }
    this.active = this.scheduler.choose(this.cursor, this.elapsed, id);
    return this.active;
  }
  presentedLastFrame(edgeId: string, frame: number, consumedPrefixFrames = 0) {
    ensure(
      this.active?.id === edgeId && frame === this.active.outFrameExclusive - 1 && !this.paused,
      'Invalid or duplicate completion',
    );
    const e = this.active;
    ensure(Number.isInteger(consumedPrefixFrames) && consumedPrefixFrames >= 0 &&
      consumedPrefixFrames < e.outFrameExclusive - e.inFrame, 'Invalid consumed overlap');
    this.elapsed += e.actualDurationSec - consumedPrefixFrames * e.fpsDenominator / e.fpsNumerator;
    this.scheduler.complete(e, this.elapsed);
    this.cursor = { nodeId: e.to, incomingEdgeId: e.id };
    this.active = null;
    this.completed++;
    return this.pack.graph.nodes.find((n) => n.id === e.to)!.snapshot;
  }
  reset() {
    this.active = null;
    this.paused = false;
    this.fault = null;
    this.elapsed = 0;
    this.completed = 0;
    this.cursor = { nodeId: this.pack.manifest.entryNode, incomingEdgeId: null };
    this.scheduler.reset(this.seed);
  }
}
