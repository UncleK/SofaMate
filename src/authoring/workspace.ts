import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensure, id, safeRelative, validateRelease } from '../core/validate';
import {
  trimFingerprint,
  type EdgeClip,
  type JoinApproval,
  type LoadedPack,
  type AssetFile,
  type MediaProfile,
} from '../core/types';
import { descriptor, hashFile, readJson, safeFile, sha, writeJson } from '../main/files';
import { loadPack } from '../main/pack-loader';
import { command, decodeCheck, extractFrame, probe, requireRegular, trimVideo } from './media';

export interface PlanNode {
  id: string;
  label: string;
  anchorId: string;
  designAssetId: string;
  snapshot: Record<string, any>;
}
export interface PlanEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label: string;
  prompt: string;
  plannedSeconds: number;
  tag: string;
  weight: number;
  cooldownSec: number;
  referenceAssetIds?: string[];
}
export interface Plan {
  schemaVersion: string;
  planVersion: string;
  packId: string;
  label: string;
  entryNode: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  canvas: LoadedPack['manifest']['canvas'];
  roles: Record<string, string>;
  policy?: any;
  display: any;
}
interface VersionedAsset {
  id: string;
  role: string;
  path: string;
  sha256: string;
  status: 'generated' | 'approved';
  parents: Record<string, string>;
  review?: Review;
}
interface Review {
  by: string;
  reason: string;
  at: string;
}
interface Take {
  id: string;
  path: string;
  sha256: string;
  info: Awaited<ReturnType<typeof probe>>;
  profile: MediaProfile;
}
interface Edit {
  id: string;
  path: string;
  sha256: string;
  info: Awaited<ReturnType<typeof probe>>;
  inFrame: number;
  outFrameExclusive: number;
  takeId: string;
  profile: MediaProfile;
}
interface EdgeState {
  takes: Take[];
  currentTake: string;
  edit?: Edit;
  approval?: { fingerprint: string; review: Review };
}
interface Anchor {
  nodeId: string;
  version: string;
  path: string;
  sha256: string;
  motionPath: string;
  motionHash: string;
  edgeId: string;
  editHash: string;
  frame: number;
  source: any;
  review: Review;
}
interface Proposal {
  id: string;
  nodeId: string;
  edgeId: string;
  editHash: string;
  path: string;
  sha256: string;
  frame: number;
  source: any;
  motionPath: string;
  motionHash: string;
}
interface Seam {
  a: string;
  b: string;
  status: 'pending' | 'approved' | 'rejected' | 'invalidated';
  fingerprint: string;
  preview: string;
  previewHash: string;
  review?: Review;
}
export interface WorkState {
  schemaVersion: '1.0';
  revision: number;
  assets: Record<string, VersionedAsset>;
  edges: Record<string, EdgeState>;
  anchors: Record<string, Anchor>;
  proposals: Record<string, Proposal>;
  seams: Record<string, Seam>;
}
const uid = () => new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + crypto.randomUUID().slice(0, 8);
const review = (by: string, reason: string): Review => {
  ensure(
    by.trim().length > 0 && by.length < 200 && reason.trim().length > 0 && reason.length < 2000,
    'Reviewer and reason are required',
  );
  return { by, reason, at: new Date().toISOString() };
};
function validPlan(p: any): asserts p is Plan {
  ensure(
    p?.schemaVersion === '1.0' &&
      id(p.packId) &&
      Array.isArray(p.nodes) &&
      Array.isArray(p.edges) &&
      p.nodes.length > 0 &&
      p.nodes.length <= 256 &&
      p.edges.length <= 2048,
    'Invalid authoring plan',
  );
  const ns = new Set(p.nodes.map((n: any) => n.id));
  ensure(ns.has(p.entryNode) && ns.size === p.nodes.length, 'Unknown/duplicate entry or node');
  ensure(new Set(p.edges.map((e: any) => e.id)).size === p.edges.length, 'Duplicate planned edge');
  for (const n of p.nodes)
    ensure(
      id(n.id) && id(n.anchorId) && id(n.designAssetId) && typeof n.label === 'string' && n.snapshot,
      'Invalid planned node',
    );
  for (const e of p.edges) {
    ensure(
      id(e.id) && ns.has(e.fromNode) && ns.has(e.toNode) && e.plannedSeconds > 0,
      'Invalid planned edge',
    );
    safeRelative(e.prompt);
    if (e.referenceAssetIds !== undefined)
      ensure(Array.isArray(e.referenceAssetIds) && e.referenceAssetIds.length <= 16 &&
        e.referenceAssetIds.every(id) && new Set(e.referenceAssetIds).size === e.referenceAssetIds.length,
      'Invalid additional reference asset IDs');
  }
}
export async function initWorkspace(planRoot: string, root: string) {
  const plan = await readJson(await safeFile(planRoot, 'scene.plan.json'));
  validPlan(plan);
  ensure(path.resolve(root) !== path.resolve(planRoot), 'Workspace must be separate from source plan');
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root);
  const copy = async (rel: string) => {
    const source = await safeFile(planRoot, rel);
    await fs.mkdir(path.dirname(path.join(root, 'plan', rel)), { recursive: true });
    await fs.copyFile(source, path.join(root, 'plan', rel), 1);
  };
  await copy('scene.plan.json');
  await copy('assets.registry.json');
  const assets = await readJson(await safeFile(planRoot, 'assets.registry.json'));
  const prompts = new Set<string>([
    ...plan.edges.map((e: PlanEdge) => e.prompt),
    ...assets.assets.map((a: any) => a.prompt).filter(Boolean),
  ]);
  try {
    const boot = await readJson(await safeFile(planRoot, 'bootstrap.json'));
    ensure(id(boot.id) && plan.nodes.some((n: PlanNode) => n.id === boot.nodeId), 'Invalid bootstrap');
    await copy('bootstrap.json');
    prompts.add(boot.prompt);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const p of prompts) await copy(p);
  for (const optional of ['props.plan.json', 'PROPS_AND_BEATS.md']) {
    try { await copy(optional); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const state: WorkState = {
    schemaVersion: '1.0',
    revision: 0,
    assets: {},
    edges: {},
    anchors: {},
    proposals: {},
    seams: {},
  };
  await writeJson(path.join(root, 'state.json'), state);
  return root;
}
export class AuthoringWorkspace {
  private constructor(
    readonly root: string,
    readonly plan: Plan,
    public state: WorkState,
    readonly bootstrap: any,
  ) {}
  static async open(root: string) {
    root = await fs.realpath(root);
    const plan = await readJson(await safeFile(root, 'plan/scene.plan.json'));
    validPlan(plan);
    const state = await readJson(await safeFile(root, 'state.json'));
    ensure(state.schemaVersion === '1.0', 'Unknown workspace version');
    let boot = null;
    try {
      boot = await readJson(await safeFile(root, 'plan/bootstrap.json'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    return new AuthoringWorkspace(root, plan, state, boot);
  }
  async mutate<T>(operation: string, body: () => Promise<T>): Promise<T> {
    const lock = await fs.open(path.join(this.root, '.authoring.lock'), 'wx').catch(() => {
      throw new Error('Workspace busy; another authoring operation holds the lock');
    });
    try {
      this.state = await readJson(await safeFile(this.root, 'state.json'));
      const result = await body();
      this.state.revision++;
      await writeJson(path.join(this.root, 'state.json'), this.state);
      await fs.appendFile(
        path.join(this.root, 'audit.jsonl'),
        JSON.stringify({ operation, revision: this.state.revision, at: new Date().toISOString(), result }) +
          '\n',
      );
      return result;
    } finally {
      await lock.close();
      await fs.unlink(path.join(this.root, '.authoring.lock'));
    }
  }
  edge(edgeId: string): PlanEdge {
    const e = this.plan.edges.find((x) => x.id === edgeId);
    if (e) return e;
    ensure(this.bootstrap?.id === edgeId, 'Unknown edge');
    return {
      id: edgeId,
      fromNode: this.bootstrap.nodeId,
      toNode: this.bootstrap.nodeId,
      label: 'Bootstrap',
      prompt: this.bootstrap.prompt,
      plannedSeconds: 12,
      tag: 'bootstrap',
      weight: 1,
      cooldownSec: 0,
    };
  }
  private async checked(relative: string, expected: string) {
    const full = await safeFile(this.root, relative);
    ensure((await hashFile(full)) === expected, `Changed authoring file: ${relative}`);
    return full;
  }
  private invalidate(edgeIds: string[]) {
    for (const e of edgeIds) if (this.state.edges[e]) delete this.state.edges[e].approval;
    for (const s of Object.values(this.state.seams))
      if (edgeIds.includes(s.a) || edgeIds.includes(s.b)) s.status = 'invalidated';
  }
  private async dir(relative: string) {
    safeRelative(relative);
    await fs.mkdir(path.join(this.root, relative), { recursive: true });
    return path.join(this.root, relative);
  }
  private current(edgeId: string) {
    this.edge(edgeId);
    const e = this.state.edges[edgeId];
    ensure(e, 'Import a video first');
    const take = e.takes.find((t) => t.id === e.currentTake);
    ensure(take, 'Missing current take');
    return { state: e, take };
  }
  private final(edgeId: string) {
    const { state } = this.current(edgeId);
    ensure(state.edit, 'Trim/select the official media first');
    return state.edit;
  }
  private dependencies() {
    return Object.fromEntries(
      Object.values(this.state.assets)
        .filter((a) => a.status === 'approved')
        .map((a) => [a.id, a.sha256]),
    );
  }
  private async approvedAsset(assetId: string, visiting = new Set<string>()): Promise<VersionedAsset> {
    ensure(!visiting.has(assetId), 'Cyclic asset ancestry');
    visiting.add(assetId);
    const a = this.state.assets[assetId];
    ensure(a?.status === 'approved', `Asset needs approval: ${assetId}`);
    await this.checked(a.path, a.sha256);
    const registry = await readJson(await safeFile(this.root, 'plan/assets.registry.json'));
    const spec = registry.assets.find((v: any) => v.id === assetId);
    ensure(spec, 'Asset is not in the production registry');
    const parents: string[] = spec.parents ?? [];
    ensure(Object.keys(a.parents).length === parents.length, `Stale asset requirements: ${assetId}`);
    for (const parent of parents) {
      const p = await this.approvedAsset(parent, visiting);
      ensure(a.parents[parent] === p.sha256, `Stale derived asset: ${assetId}`);
    }
    visiting.delete(assetId);
    return a;
  }
  private edgeFingerprint(edgeId: string) {
    const e = this.edge(edgeId),
      edit = this.final(edgeId);
    return sha(
      JSON.stringify({
        plan: this.plan,
        edge: e,
        editHash: edit.sha256,
        trim: [edit.inFrame, edit.outFrameExclusive],
        source: this.state.anchors[e.fromNode],
        target: this.state.anchors[e.toNode],
        assets: this.dependencies(),
      }),
    );
  }
  private seamFingerprint(a: string, b: string) {
    return sha(
      JSON.stringify({
        a: a === '__entry__' ? this.state.anchors[this.plan.entryNode] : this.edgeFingerprint(a),
        b: this.edgeFingerprint(b),
      }),
    );
  }
  async registerAsset(assetId: string, file: string, role = assetId) {
    ensure(id(assetId) && id(role), 'Invalid asset ID');
    await requireRegular(file);
    ensure(path.extname(file).toLowerCase() === '.png', 'Static references must be PNG');
    const bytes = await fs.readFile(file);
    ensure(
      bytes.length >= 33 &&
        bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
        bytes.toString('ascii', 12, 16) === 'IHDR',
      'Invalid PNG',
    );
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    ensure(
      width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 33554432,
      'Reference image dimensions exceed the safe limit',
    );
    await decodeCheck(file);
    return this.mutate('asset-register', async () => {
      const registry = await readJson(await safeFile(this.root, 'plan/assets.registry.json'));
      const spec = registry.assets.find((a: any) => a.id === assetId);
      ensure(spec, 'Asset is not in the production registry');
      const parents: Record<string, string> = {};
      for (const parent of spec.parents ?? []) {
        const a = await this.approvedAsset(parent);
        parents[parent] = a.sha256;
      }
      const rel = `stills/${assetId}/${uid()}/master.png`;
      await this.dir(path.dirname(rel).replaceAll('\\', '/'));
      await fs.copyFile(file, path.join(this.root, rel), 1);
      this.state.assets[assetId] = {
        id: assetId,
        role,
        path: rel,
        sha256: sha(bytes),
        status: 'generated',
        parents,
      };
      this.invalidate(this.plan.edges.map((e) => e.id));
      return this.state.assets[assetId];
    });
  }
  async approveAsset(assetId: string, by: string, reason: string) {
    return this.mutate('asset-approve', async () => {
      const a = this.state.assets[assetId];
      ensure(a, 'Unknown asset');
      await this.checked(a.path, a.sha256);
      const registry = await readJson(await safeFile(this.root, 'plan/assets.registry.json'));
      const spec = registry.assets.find((v: any) => v.id === assetId);
      ensure(spec && Object.keys(a.parents).length === (spec.parents ?? []).length, 'Stale asset requirements');
      for (const parent of spec.parents ?? []) {
        const p = await this.approvedAsset(parent);
        ensure(a.parents[parent] === p.sha256, 'Stale derived asset');
      }
      a.status = 'approved';
      a.review = review(by, reason);
      this.invalidate(this.plan.edges.map((e) => e.id));
      return a;
    });
  }
  async importVideo(edgeId: string, file: string, profile: MediaProfile) {
    this.edge(edgeId);
    await requireRegular(file);
    ensure(
      ['.mp4', '.mov', '.mkv', '.webm'].includes(path.extname(file).toLowerCase()),
      'Unsupported video container',
    );
    ensure(['opaque-video', 'packed-rgb-alpha'].includes(profile), 'Invalid profile');
    return this.mutate('edge-import', async () => {
      const info = await probe(file);
      const c = this.plan.canvas;
      ensure(
        info.width === c.width * (profile === 'packed-rgb-alpha' ? 2 : 1) && info.height === c.height,
        'Video dimensions do not match the plan/profile',
      );
      ensure(
        Math.abs(info.fpsNumerator / info.fpsDenominator - c.fpsNumerator / c.fpsDenominator) < 1e-6,
        'Normalize fps to the plan before import',
      );
      const takeId = uid(),
        rel = `videos/raw/${edgeId}/${takeId}/source${path.extname(file).toLowerCase()}`;
      await this.dir(path.dirname(rel).replaceAll('\\', '/'));
      await fs.copyFile(file, path.join(this.root, rel), 1);
      const take: Take = {
        id: takeId,
        path: rel,
        sha256: await hashFile(path.join(this.root, rel)),
        info,
        profile,
      };
      const existing = this.state.edges[edgeId];
      this.state.edges[edgeId] = { takes: [...(existing?.takes ?? []), take], currentTake: takeId };
      this.invalidate([edgeId]);
      await writeJson(path.join(this.root, rel + '.probe.json'), take);
      return take;
    });
  }
  async candidates(edgeId: string, count = 6) {
    ensure(Number.isInteger(count) && count >= 1 && count <= 12, 'Candidate count must be 1..12');
    return this.mutate('edge-candidates', async () => {
      const { take } = this.current(edgeId),
        file = await this.checked(take.path, take.sha256);
      const folder = `candidates/${edgeId}/${uid()}`;
      await this.dir(folder);
      const end = take.info.frameCount - 1,
        span = Math.min(end, Math.ceil((2 * take.info.fpsNumerator) / take.info.fpsDenominator));
      const frames = [
        ...new Set(
          Array.from({ length: count }, (_, i) =>
            Math.round(end - span + (i * span) / Math.max(1, count - 1)),
          ),
        ),
      ];
      const results = [];
      for (const frame of frames) {
        const rel = `${folder}/frame-${frame}.png`;
        const source = await extractFrame(file, frame, path.join(this.root, rel));
        results.push({ frame, path: rel, ...source });
      }
      await writeJson(path.join(this.root, folder, 'candidates.json'), results);
      return results;
    });
  }
  async inspectFrame(edgeId: string, frame: number) {
    return this.mutate('edge-frame', async () => {
      const { take } = this.current(edgeId),
        file = await this.checked(take.path, take.sha256),
        folder = `candidates/${edgeId}/${uid()}`;
      await this.dir(folder);
      const relative = `${folder}/frame-${frame}.png`;
      const source = await extractFrame(file, frame, path.join(this.root, relative));
      return { frame, path: relative, ...source };
    });
  }
  private async trimInternal(edgeId: string, start: number, end: number) {
    const { state, take } = this.current(edgeId);
    const input = await this.checked(take.path, take.sha256),
      editId = uid(),
      rel = `videos/work/${edgeId}/${editId}/final.mp4`;
    await this.dir(path.dirname(rel).replaceAll('\\', '/'));
    const c = this.plan.canvas;
    const info = await trimVideo(
      input,
      start,
      end,
      path.join(this.root, rel),
      `${c.fpsNumerator}/${c.fpsDenominator}`,
    );
    await decodeCheck(path.join(this.root, rel));
    const edit: Edit = {
      id: editId,
      path: rel,
      sha256: await hashFile(path.join(this.root, rel)),
      info,
      inFrame: start,
      outFrameExclusive: end,
      takeId: take.id,
      profile: take.profile,
    };
    state.edit = edit;
    this.invalidate([edgeId]);
    await writeJson(path.join(this.root, path.dirname(rel), 'edit.json'), edit);
    return edit;
  }
  async trim(edgeId: string, start: number, end: number) {
    return this.mutate('edge-trim', () => this.trimInternal(edgeId, start, end));
  }
  async proposeAnchor(edgeId: string, frame: number, start = 0) {
    return this.mutate('anchor-propose', async () => {
      const e = this.edge(edgeId),
        edit = await this.trimInternal(edgeId, start, frame + 1);
      const proposalId = uid(),
        folder = `proposals/${e.toNode}/${proposalId}`;
      await this.dir(folder);
      const rel = folder + '/anchor.png';
      const source = await extractFrame(
        await this.checked(edit.path, edit.sha256),
        edit.info.frameCount - 1,
        path.join(this.root, rel),
      );
      const take = this.current(edgeId).take;
      const rawSourceFrame = await extractFrame(
        await this.checked(take.path, take.sha256),
        frame,
        path.join(this.root, folder, 'raw-selected-frame.png'),
      );
      // Packed frames are de-packed without repainting; the display anchor preserves real alpha.
      if (edit.profile === 'packed-rgb-alpha') {
        await fs.rename(path.join(this.root, rel), path.join(this.root, folder, 'packed-source.png'));
        await command('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-i',
          path.join(this.root, folder, 'packed-source.png'),
          '-filter_complex',
          `[0:v]split[c][a];[c]crop=iw/2:ih:0:0[rgb];[a]crop=iw/2:ih:iw/2:0,format=gray[alpha];[rgb][alpha]alphamerge[out]`,
          '-map',
          '[out]',
          '-frames:v',
          '1',
          path.join(this.root, rel),
        ]);
      }
      const motion = folder + '/motion.mp4';
      const length = Math.min(
        edit.info.frameCount,
        Math.ceil(edit.info.fpsNumerator / edit.info.fpsDenominator),
      );
      await trimVideo(
        path.join(this.root, edit.path),
        edit.info.frameCount - length,
        edit.info.frameCount,
        path.join(this.root, motion),
        `${this.plan.canvas.fpsNumerator}/${this.plan.canvas.fpsDenominator}`,
      );
      const proposal: Proposal = {
        id: proposalId,
        nodeId: e.toNode,
        edgeId,
        editHash: edit.sha256,
        path: rel,
        sha256: await hashFile(path.join(this.root, rel)),
        frame: edit.info.frameCount - 1,
        source: {
          ...source,
          rawSourceFrame,
          rawInFrame: start,
          rawOutFrameExclusive: frame + 1,
          rawSourceHash: take.sha256,
          profile: edit.profile,
        },
        motionPath: motion,
        motionHash: await hashFile(path.join(this.root, motion)),
      };
      this.state.proposals[proposalId] = proposal;
      await writeJson(path.join(this.root, folder, 'proposal.json'), proposal);
      return proposal;
    });
  }
  async approveAnchor(nodeId: string, proposalId: string, by: string, reason: string, newVersion?: string) {
    return this.mutate('anchor-approve', async () => {
      const p = this.state.proposals[proposalId];
      ensure(p && p.nodeId === nodeId, 'Proposal/node mismatch');
      const old = this.state.anchors[nodeId];
      ensure(!old || newVersion, 'Anchor is frozen; explicit new version required');
      const version = newVersion ?? 'v001';
      ensure(id(version) && version !== old?.version, 'Use a distinct immutable anchor version');
      ensure(this.final(p.edgeId).sha256 === p.editHash, 'Proposal is stale after trim/import');
      await this.checked(p.path, p.sha256);
      await this.checked(p.motionPath, p.motionHash);
      const folder = `anchors/${nodeId}/${version}`;
      await fs.mkdir(path.join(this.root, folder), { recursive: false }).catch(async (e: any) => {
        if (e.code === 'ENOENT') {
          await fs.mkdir(path.join(this.root, 'anchors', nodeId), { recursive: true });
          await fs.mkdir(path.join(this.root, folder));
        } else throw e;
      });
      const affected = this.plan.edges
        .filter((e) => e.fromNode === nodeId || e.toNode === nodeId)
        .map((e) => e.id);
      this.invalidate(affected);
      await fs.copyFile(path.join(this.root, p.path), path.join(this.root, folder, 'anchor.png'), 1);
      await fs.copyFile(path.join(this.root, p.motionPath), path.join(this.root, folder, 'motion.mp4'), 1);
      const anchor: Anchor = {
        ...p,
        version,
        path: folder + '/anchor.png',
        motionPath: folder + '/motion.mp4',
        review: review(by, reason),
      };
      this.state.anchors[nodeId] = anchor;
      await writeJson(path.join(this.root, folder, 'anchor.json'), anchor);
      return { anchor, invalidatedEdges: affected };
    });
  }
  private async verifiedAnchors(edgeId: string) {
    const e = this.edge(edgeId);
    for (const nodeId of [e.fromNode, e.toNode]) {
      const a = this.state.anchors[nodeId];
      ensure(a, `Missing frozen anchor ${nodeId}`);
      await this.checked(a.path, a.sha256);
      await this.checked(a.motionPath, a.motionHash);
    }
  }
  async approveEdge(edgeId: string, by: string, reason: string) {
    return this.mutate('edge-approve', async () => {
      await this.verifiedAnchors(edgeId);
      for (const role of ['identityAssetId', 'stageAssetId']) await this.approvedAsset(this.plan.roles[role]);
      for (const assetId of this.edge(edgeId).referenceAssetIds ?? []) await this.approvedAsset(assetId);
      const edit = this.final(edgeId);
      await this.checked(edit.path, edit.sha256);
      await decodeCheck(path.join(this.root, edit.path));
      for (const a of Object.values(this.state.assets).filter((a) => a.status === 'approved'))
        await this.checked(a.path, a.sha256);
      const approved = { fingerprint: this.edgeFingerprint(edgeId), review: review(by, reason) };
      this.state.edges[edgeId].approval = approved;
      return approved;
    });
  }
  private approvedEdge(edgeId: string) {
    ensure(
      this.state.edges[edgeId]?.approval?.fingerprint === this.edgeFingerprint(edgeId),
      `Edge ${edgeId} is unapproved/stale`,
    );
    return this.final(edgeId);
  }
  async prepare(edgeId: string) {
    return this.mutate('edge-prepare', async () => {
      const e = this.edge(edgeId),
        boot = this.bootstrap?.id === edgeId;
      const refs: { name: string; path: string; hash: string; role: string }[] = [];
      let mode = 'bootstrap';
      const addAsset = async (assetId: string, name: string) => {
        const a = await this.approvedAsset(assetId);
        refs.push({ name, path: a.path, hash: a.sha256, role: assetId });
      };
      if (boot) {
        for (const [i, assetId] of (this.bootstrap.assetIds as string[]).entries())
          await addAsset(assetId, `0${i + 1}_${assetId}.png`);
      } else {
        const source = this.state.anchors[e.fromNode];
        ensure(source, 'Freeze the source anchor before preparing this edge');
        await this.checked(source.path, source.sha256);
        refs.push({
          name: '01_start.png',
          path: source.path,
          hash: source.sha256,
          role: `${e.fromNode}/${source.version}`,
        });
        const target = this.state.anchors[e.toNode];
        mode = target ? 'convergence' : 'discovery';
        if (target) {
          await this.checked(target.path, target.sha256);
          refs.push({
            name: '02_target.png',
            path: target.path,
            hash: target.sha256,
            role: `${e.toNode}/${target.version}`,
          });
        } else
          await addAsset(
            this.plan.nodes.find((n) => n.id === e.toNode)!.designAssetId,
            '02_target-design.png',
          );
        await addAsset(this.plan.roles.identityAssetId, '03_identity.png');
        await addAsset(this.plan.roles.stageAssetId, '04_stage.png');
        for (const assetId of e.referenceAssetIds ?? []) {
          ensure(!refs.some((r) => r.role === assetId), 'Duplicate additional reference');
          await addAsset(assetId, `${String(refs.length + 1).padStart(2, '0')}_${assetId}.png`);
        }
        await this.checked(source.motionPath, source.motionHash);
        refs.push({
          name: `${String(refs.length + 1).padStart(2, '0')}_motion.mp4`,
          path: source.motionPath,
          hash: source.motionHash,
          role: 'entry-motion-only',
        });
      }
      const sourceText = await fs.readFile(await safeFile(this.root, 'plan/' + e.prompt), 'utf8'),
        blocks = [...sourceText.matchAll(/```text\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
      ensure(blocks.length > 0, 'Missing complete Chinese prompt');
      const imageBindings = refs.filter((r) => r.name.endsWith('.png')).map((r, i) => ({
        tag: `@图片${i + 1}`, file: r.name, role: r.role, hash: r.hash,
      }));
      const extra = imageBindings.slice(4);
      const propText = extra.length ? '\n\n独立道具参考：' + extra.map((r) => `${r.tag}固定${r.role}的外观、材质与比例`).join('；') +
        '。近景只参考道具，不改变本段全景机位，不照搬近景背景；实际起终点的持有、数量、开口、褶皱与归位状态仍以真实交接图为准。' : '';
      const prompt = blocks[0] + propText + (!boot && blocks[1] ? '\n\n' + blocks[1] : '');
      const folder = `jobs/${edgeId}/${uid()}`;
      await this.dir(folder);
      for (const r of refs)
        await fs.copyFile(path.join(this.root, r.path), path.join(this.root, folder, r.name), 1);
      const meta = {
        packId: this.plan.packId,
        planVersion: this.plan.planVersion,
        edgeId,
        mode,
        sourceAnchorVersion: this.state.anchors[e.fromNode]?.version ?? null,
        targetAnchorVersion: this.state.anchors[e.toNode]?.version ?? null,
        promptSha256: sha(prompt),
        references: refs,
        imageBindings,
        tool: 'manual Seedance',
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(this.root, folder, 'PROMPT.txt'), prompt);
      await writeJson(path.join(this.root, folder, 'job.json'), meta);
      await fs.writeFile(
        path.join(this.root, folder, 'JOB.md'),
        `# ${edgeId} 手工上传包\n\n${mode === 'convergence' ? '目标已冻结，不可覆盖；需要重新验收汇合/回环。' : mode === 'discovery' ? '目标是设计图，首次真实尾帧待你选择后冻结。' : '引导片段只建立入口真实锚点，不进入运行图。'}\n\n按文件序号上传并手动绑定引用；粘贴 PROMPT.txt。计划 ${e.plannedSeconds} 秒，以你当前 Seedance 界面可用能力为准。没有调用 Seedance、没有硬首尾帧保证。\n\n${refs.map((r) => `- ${r.name}：${r.role}`).join('\n')}\n`,
      );
      return { folder, ...meta };
    });
  }
  async previewJoin(a: string, b: string) {
    return this.mutate('join-preview', async () => {
      const eb = this.edge(b);
      ensure(
        a === '__entry__' ? eb.fromNode === this.plan.entryNode : this.edge(a).toNode === eb.fromNode,
        'Edges do not meet',
      );
      const next = this.final(b),
        previous = a === '__entry__' ? null : this.final(a);
      ensure(!previous || previous.profile === next.profile, 'Preview profiles differ');
      await this.checked(next.path, next.sha256);
      if (previous) await this.checked(previous.path, previous.sha256);
      const folder = `reviews/${uid()}`;
      await this.dir(folder);
      const out = folder + '/preview.mp4';
      if (previous) {
        await command('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-i',
          path.join(this.root, previous.path),
          '-i',
          path.join(this.root, next.path),
          '-filter_complex',
          `[0:v]trim=start=${Math.max(0, previous.info.duration - 2)},setpts=PTS-STARTPTS[a];[1:v]trim=end=2,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]`,
          '-map',
          '[v]',
          '-an',
          '-c:v',
          'libx264',
          '-crf',
          '12',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          path.join(this.root, out),
        ]);
      } else {
        const anchor = this.state.anchors[this.plan.entryNode];
        ensure(anchor, 'Missing entry anchor');
        await this.checked(anchor.path, anchor.sha256);
        let poster = path.join(this.root, anchor.path);
        if (next.profile === 'packed-rgb-alpha') {
          const packed = path.join(this.root, folder, 'poster-packed.png');
          await command('ffmpeg', [
            '-v',
            'error',
            '-nostdin',
            '-n',
            '-i',
            poster,
            '-filter_complex',
            '[0:v]split[a][b];[a]format=rgb24[c];[b]alphaextract,format=rgb24[d];[c][d]hstack[v]',
            '-map',
            '[v]',
            '-frames:v',
            '1',
            packed,
          ]);
          poster = packed;
        }
        await command('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-loop',
          '1',
          '-framerate',
          `${this.plan.canvas.fpsNumerator}/${this.plan.canvas.fpsDenominator}`,
          '-i',
          poster,
          '-i',
          path.join(this.root, next.path),
          '-filter_complex',
          '[0:v]trim=duration=0.5,setpts=PTS-STARTPTS,format=yuv420p[a];[1:v]trim=end=2,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]',
          '-map',
          '[v]',
          '-an',
          '-c:v',
          'libx264',
          '-crf',
          '12',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          path.join(this.root, out),
        ]);
      }
      const seam: Seam = {
        a,
        b,
        status: 'pending',
        fingerprint: this.seamFingerprint(a, b),
        preview: out,
        previewHash: await hashFile(path.join(this.root, out)),
      };
      this.state.seams[a + '/' + b] = seam;
      await writeJson(path.join(this.root, folder, 'preview.json'), seam);
      return seam;
    });
  }
  async reviewJoin(a: string, b: string, approve: boolean, by: string, reason: string) {
    return this.mutate('join-review', async () => {
      const s = this.state.seams[a + '/' + b];
      ensure(s && s.fingerprint === this.seamFingerprint(a, b), 'Create a preview of current exports first');
      await this.checked(s.preview, s.previewHash);
      if (approve) {
        this.approvedEdge(b);
        if (a !== '__entry__') this.approvedEdge(a);
      }
      s.status = approve ? 'approved' : 'rejected';
      s.review = review(by, reason);
      await writeJson(path.join(this.root, path.dirname(s.preview), `decision-${uid()}.json`), s);
      return s;
    });
  }
  async build(version: string, destination: string) {
    ensure(/^\d+\.\d+\.\d+$/.test(version), 'Pack version must be x.y.z');
    return this.mutate('pack-build', async () => {
      const selected = this.plan.edges.filter((e) => this.state.edges[e.id]?.approval);
      ensure(selected.length > 0, 'No approved media to publish');
      const nodeIds = new Set(selected.flatMap((e) => [e.fromNode, e.toNode]));
      ensure(nodeIds.has(this.plan.entryNode), 'Approved subgraph must include entry');
      const profiles = new Set(selected.map((e) => this.approvedEdge(e.id).profile));
      ensure(profiles.size === 1, 'Release must use one media profile');
      const profile = [...profiles][0];
      for (const e of selected) {
        await this.verifiedAnchors(e.id);
        await this.checked(this.final(e.id).path, this.final(e.id).sha256);
      }
      const out = path.resolve(destination);
      ensure(
        !out.startsWith(path.resolve(this.root) + path.sep) ||
          out.startsWith(path.resolve(this.root, 'exports') + path.sep),
        'Only exports/ may contain releases inside a workspace',
      );
      await fs.mkdir(path.dirname(out), { recursive: true });
      const stage = out + '.building-' + uid();
      await fs.mkdir(stage);
      const copy = async (source: string, relative: string) => {
        safeRelative(relative);
        await fs.mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
        await fs.copyFile(source, path.join(stage, relative), 1);
        return descriptor(stage, relative);
      };
      try {
        const entry = this.state.anchors[this.plan.entryNode],
          poster = await copy(await this.checked(entry.path, entry.sha256), 'media/posters/entry.png');
        const nodes = [...nodeIds].map((nodeId) => {
          const n = this.plan.nodes.find((n) => n.id === nodeId)!,
            a = this.state.anchors[nodeId];
          return {
            id: n.id,
            label: n.label,
            anchorVersion: a.version,
            anchorImageHash: a.sha256,
            snapshot: n.snapshot,
          };
        });
        const edges: EdgeClip[] = [];
        for (const e of selected) {
          const edit = this.approvedEdge(e.id),
            policy = this.plan.policy?.tagPolicies?.[e.tag];
          await decodeCheck(path.join(this.root, edit.path));
          edges.push({
            id: e.id,
            from: e.fromNode,
            to: e.toNode,
            video: await copy(path.join(this.root, edit.path), `media/video/${e.id}.mp4`),
            profile,
            decodedWidth: edit.info.width,
            decodedHeight: edit.info.height,
            fpsNumerator: this.plan.canvas.fpsNumerator,
            fpsDenominator: this.plan.canvas.fpsDenominator,
            frameCount: edit.info.frameCount,
            inFrame: 0,
            outFrameExclusive: edit.info.frameCount,
            actualDurationSec:
              (edit.info.frameCount * this.plan.canvas.fpsDenominator) / this.plan.canvas.fpsNumerator,
            sourceAnchorVersion: this.state.anchors[e.fromNode].version,
            targetAnchorVersion: this.state.anchors[e.toNode].version,
            tag: e.tag,
            weight: e.weight,
            cooldownGroup: policy?.cooldownGroup ?? null,
            cooldownSec: e.cooldownSec,
            initialDelaySec: policy?.initialDelaySec ?? 0,
            requiredCapabilities: [profile, 'cut'],
          });
        }
        const joins: JoinApproval[] = [];
        for (const s of Object.values(this.state.seams).filter((s) => s.status === 'approved')) {
          const b = edges.find((e) => e.id === s.b),
            a = edges.find((e) => e.id === s.a);
          if (!b || (s.a !== '__entry__' && !a)) continue;
          ensure(s.fingerprint === this.seamFingerprint(s.a, s.b), 'Stale seam approval');
          await this.checked(s.preview, s.previewHash);
          const j: JoinApproval = {
            incomingEdgeId: s.a,
            outgoingEdgeId: s.b,
            nodeId: b.from,
            status: 'approved',
            method: 'cut',
            blendFrames: 0,
            incomingMediaOrPosterHash: a?.video.sha256 ?? poster.sha256,
            outgoingMediaHash: b.video.sha256,
            incomingTrimFingerprint: a ? trimFingerprint(a) : 'poster',
            outgoingTrimFingerprint: trimFingerprint(b),
            anchorVersion: b.sourceAnchorVersion,
            evidencePath: `reviews/${s.a}-${s.b}.json`,
            approvedAt: s.review!.at,
            approvedBy: s.review!.by,
          };
          joins.push(j);
          await writeJson(path.join(stage, j.evidencePath), {
            join: j,
            review: s.review,
            authoringPreviewSha256: s.previewHash,
            authoringFingerprint: s.fingerprint,
          });
        }
        await writeJson(path.join(stage, 'graph.json'), { nodes, edges });
        await writeJson(path.join(stage, 'joins.json'), { schemaVersion: '1.0', joins });
        await writeJson(path.join(stage, 'provenance.json'), {
          packId: this.plan.packId,
          planVersion: this.plan.planVersion,
          assets: this.state.assets,
          anchors: this.state.anchors,
          edgeApprovals: Object.fromEntries(selected.map((e) => [e.id, this.state.edges[e.id].approval])),
          createdAt: new Date().toISOString(),
          license: null,
        });
        const manifest: LoadedPack['manifest'] = {
          schemaVersion: '1.0',
          packId: this.plan.packId,
          packVersion: version,
          minRuntimeVersion: '0.1.0',
          label: this.plan.label,
          entryNode: this.plan.entryNode,
          entryPoster: poster,
          canvas: this.plan.canvas,
          displayMode: profile === 'packed-rgb-alpha' ? 'overlay-stage' : 'scene-preview',
          fit: 'contain',
          mediaProfile: profile,
          graph: await descriptor(stage, 'graph.json'),
          joins: await descriptor(stage, 'joins.json'),
          ambientAudio: null,
          requiredCapabilities: [profile, 'cut'],
          provenance: await descriptor(stage, 'provenance.json'),
        };
        validateRelease({ manifest, graph: { nodes, edges }, joins: { schemaVersion: '1.0', joins } });
        await writeJson(path.join(stage, 'manifest.json'), manifest);
        const checks: Record<string, string> = {};
        async function walk(dir: string, rel = '') {
          for (const d of await fs.readdir(dir, { withFileTypes: true })) {
            const r = rel ? rel + '/' + d.name : d.name;
            if (d.isDirectory()) await walk(path.join(dir, d.name), r);
            else checks[r] = await hashFile(path.join(dir, d.name));
          }
        }
        await walk(stage);
        await writeJson(path.join(stage, 'checksums.json'), checks);
        await loadPack(stage);
        try {
          await fs.access(out);
          throw new Error('Release version already exists');
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
        await fs.rename(stage, out);
        return { directory: out, nodes: nodes.length, edges: edges.length, joins: joins.length };
      } catch (e) {
        await fs.rm(stage, { recursive: true, force: true });
        throw e;
      }
    });
  }
}
