import { CAPABILITIES, trimFingerprint, type LoadedPack, type AssetFile, type EdgeClip } from './types';

export function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(v) && v !== '__entry__';
export const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function safeRelative(v: unknown): asserts v is string {
  ensure(typeof v === 'string' && v.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(v), 'Invalid relative path');
  ensure(
    !v.startsWith('/') &&
      v
        .split('/')
        .every(
          (p) =>
            p &&
            p !== '.' &&
            p !== '..' &&
            !p.endsWith('.') &&
            !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
        ),
    'Path escape or reserved path',
  );
}
export function asset(v: any): asserts v is AssetFile {
  ensure(v && typeof v === 'object', 'Missing asset descriptor');
  safeRelative(v.path);
  ensure(
    hash(v.sha256) && Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= 512 * 1024 * 1024,
    'Invalid asset hash/size',
  );
}
const num = (n: unknown, min = 0) => typeof n === 'number' && Number.isFinite(n) && n >= min;
const int = (n: unknown, min = 1) => Number.isSafeInteger(n) && (n as number) >= min;
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1000;
function capabilities(v: any) {
  ensure(Array.isArray(v) && v.every((c) => CAPABILITIES.includes(c)), 'Unsupported capability');
}
function unique(values: string[], name: string) {
  ensure(new Set(values).size === values.length, `Duplicate ${name}`);
}
export function validateRelease(input: unknown): LoadedPack {
  const p = input as LoadedPack;
  const m = p?.manifest;
  const g = p?.graph;
  const js = p?.joins;
  ensure(
    m?.schemaVersion === '1.0' && js?.schemaVersion === '1.0',
    'Unknown schema or authoring plan used as release',
  );
  ensure(
    id(m.packId) && /^\d+\.\d+\.\d+$/.test(m.packVersion) && m.minRuntimeVersion === '0.1.0' && text(m.label),
    'Invalid manifest identity/version',
  );
  ensure(
    m.fit === 'contain' && ['overlay-stage', 'scene-preview'].includes(m.displayMode),
    'Unsupported display contract',
  );
  ensure(['opaque-video', 'packed-rgb-alpha'].includes(m.mediaProfile), 'Unknown media profile');
  ensure(
    m.displayMode !== 'overlay-stage' || m.mediaProfile === 'packed-rgb-alpha',
    'Opaque video cannot be a transparent overlay',
  );
  ensure(
    m.canvas &&
      int(m.canvas.width) &&
      int(m.canvas.height) &&
      m.canvas.width <= 4096 &&
      m.canvas.height <= 4096 &&
      int(m.canvas.fpsNumerator) &&
      int(m.canvas.fpsDenominator) &&
      m.canvas.fpsNumerator / m.canvas.fpsDenominator <= 120,
    'Invalid canvas',
  );
  [m.entryPoster, m.graph, m.joins, m.provenance].forEach(asset);
  if (m.ambientAudio) asset(m.ambientAudio);
  capabilities(m.requiredCapabilities);
  ensure(
    Array.isArray(g?.nodes) &&
      g.nodes.length > 0 &&
      g.nodes.length <= 256 &&
      Array.isArray(g.edges) &&
      g.edges.length > 0 &&
      g.edges.length <= 2048 &&
      Array.isArray(js.joins) &&
      js.joins.length <= 16384,
    'Invalid graph size',
  );
  for (const n of g.nodes)
    ensure(
      id(n.id) &&
        text(n.label) &&
        id(n.anchorVersion) &&
        hash(n.anchorImageHash) &&
        n.snapshot &&
        typeof n.snapshot === 'object' &&
        !Array.isArray(n.snapshot),
      'Invalid node',
    );
  unique(
    g.nodes.map((n) => n.id),
    'node',
  );
  unique(
    g.edges.map((e) => e.id),
    'edge',
  );
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const edges = new Map(g.edges.map((e) => [e.id, e]));
  ensure(nodes.has(m.entryNode), 'Unknown entry node');
  ensure(
    nodes.get(m.entryNode)!.anchorImageHash === m.entryPoster.sha256,
    'Entry poster differs from frozen anchor',
  );
  for (const e of g.edges) {
    ensure(id(e.id) && nodes.has(e.from) && nodes.has(e.to), 'Unknown edge endpoint');
    asset(e.video);
    capabilities(e.requiredCapabilities);
    ensure(
      e.video.path.endsWith('.mp4') && e.profile === m.mediaProfile,
      'Unsupported video or mixed profile',
    );
    ensure(
      e.decodedWidth === m.canvas.width * (e.profile === 'packed-rgb-alpha' ? 2 : 1) &&
        e.decodedHeight === m.canvas.height,
      'Profile dimensions mismatch',
    );
    ensure(
      e.fpsNumerator === m.canvas.fpsNumerator &&
        e.fpsDenominator === m.canvas.fpsDenominator &&
        int(e.frameCount) &&
        e.frameCount <= 216000 &&
        int(e.inFrame, 0) &&
        int(e.outFrameExclusive) &&
        e.outFrameExclusive > e.inFrame &&
        e.outFrameExclusive <= e.frameCount,
      'Invalid frame bounds/fps',
    );
    ensure(
      num(e.actualDurationSec, 0.001) &&
        Math.abs(
          e.actualDurationSec - ((e.outFrameExclusive - e.inFrame) * e.fpsDenominator) / e.fpsNumerator,
        ) < 0.00001,
      'Duration does not match frame range',
    );
    ensure(
      e.sourceAnchorVersion === nodes.get(e.from)!.anchorVersion &&
        e.targetAnchorVersion === nodes.get(e.to)!.anchorVersion,
      'Stale anchor version',
    );
    ensure(
      text(e.tag) &&
        num(e.weight, 0.00001) &&
        num(e.cooldownSec) &&
        num(e.initialDelaySec) &&
        (e.cooldownGroup === null || id(e.cooldownGroup)),
      'Invalid scheduling policy',
    );
  }
  if (m.startPoints !== undefined) {
    ensure(
      Array.isArray(m.startPoints) &&
        m.startPoints.length > 0 &&
        m.startPoints.length <= g.edges.length &&
        m.requiredCapabilities.includes('random-start'),
      'Invalid random start policy',
    );
    unique(
      m.startPoints.map((s) => s.edgeId),
      'start point',
    );
    for (const s of m.startPoints) {
      const e = edges.get(s.edgeId);
      asset(s.poster);
      ensure(
        e &&
          s.poster.path.endsWith('.png') &&
          s.mediaHash === e.video.sha256 &&
          s.trimFingerprint === trimFingerprint(e) &&
          text(s.approvedBy) &&
          text(s.approvedAt) &&
          Number.isFinite(Date.parse(s.approvedAt)) &&
          e.initialDelaySec === 0,
        'Unapproved or stale start point',
      );
    }
  } else ensure(!m.requiredCapabilities.includes('random-start'), 'Missing random start points');
  unique(
    js.joins.map((j) => `${j.incomingEdgeId}/${j.outgoingEdgeId}`),
    'join',
  );
  for (const j of js.joins) {
    const b = edges.get(j.outgoingEdgeId),
      a = edges.get(j.incomingEdgeId);
    const n = nodes.get(j.nodeId);
    ensure(
      b && n && b.from === n.id && (j.incomingEdgeId === '__entry__' ? n.id === m.entryNode : a?.to === n.id),
      'Invalid join endpoints',
    );
    ensure(
      j.status === 'approved' && (
        (j.method === 'cut' && j.blendFrames === 0) ||
        (j.method === 'smooth-crossfade' && a && m.mediaProfile === 'opaque-video' &&
          m.requiredCapabilities.includes('smooth-crossfade') && int(j.blendFrames) &&
          j.blendFrames * m.canvas.fpsDenominator / m.canvas.fpsNumerator <= 0.5 &&
          j.blendFrames * 2 <= a.outFrameExclusive - a.inFrame &&
          j.blendFrames * 2 <= b.outFrameExclusive - b.inFrame)
      ),
      'Unapproved or unsupported join',
    );
    ensure(
      j.anchorVersion === n.anchorVersion &&
        j.outgoingMediaHash === b.video.sha256 &&
        j.outgoingTrimFingerprint === trimFingerprint(b),
      'Stale outgoing approval',
    );
    ensure(
      j.incomingMediaOrPosterHash === (a ? a.video.sha256 : m.entryPoster.sha256) &&
        j.incomingTrimFingerprint === (a ? trimFingerprint(a) : 'poster'),
      'Stale incoming approval',
    );
    ensure(
      text(j.approvedBy) && text(j.approvedAt) && Number.isFinite(Date.parse(j.approvedAt)),
      'Missing human approval',
    );
    safeRelative(j.evidencePath);
  }
  // Reachability is on the expanded (node,incoming) graph, never on node labels alone.
  const seen = new Set<string>();
  const reachedNodes = new Set([m.entryNode]);
  const queue = ['__entry__'];
  while (queue.length) {
    const incoming = queue.shift()!;
    if (seen.has(incoming)) continue;
    seen.add(incoming);
    const next = js.joins
      .filter((j) => j.incomingEdgeId === incoming)
      .map((j) => edges.get(j.outgoingEdgeId)!);
    ensure(
      next.some((e) => e.cooldownSec === 0 && e.initialDelaySec === 0 && e.cooldownGroup === null),
      `Cooldown dead end after ${incoming}`,
    );
    for (const e of next) {
      reachedNodes.add(e.to);
      queue.push(e.id);
    }
  }
  ensure(
    g.edges.every((e) => seen.has(e.id)) && g.nodes.every((n) => reachedNodes.has(n.id)),
    'Unreachable published node/edge under join whitelist',
  );
  // Every incoming state must have a path back to the entry node.
  let returning = new Set(g.edges.filter((e) => e.to === m.entryNode).map((e) => e.id));
  for (let i = 0; i <= g.edges.length; i++)
    for (const j of js.joins) if (returning.has(j.outgoingEdgeId)) returning.add(j.incomingEdgeId);
  ensure(
    g.edges.every((e) => returning.has(e.id)),
    'Published state cannot return to entry',
  );
  return p;
}
