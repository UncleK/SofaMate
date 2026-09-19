import { parseArgs } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AuthoringWorkspace, initWorkspace } from './workspace';
import { ensure, id } from '../core/validate';
import { loadPack } from '../main/pack-loader';
import { writeJson } from '../main/files';
import { packAlpha } from './media';
const stringOptions = [
  'workspace',
  'plan',
  'edge',
  'file',
  'profile',
  'frame',
  'start',
  'end',
  'node',
  'proposal',
  'reviewer',
  'reason',
  'new-version',
  'id',
  'role',
  'a',
  'b',
  'version',
  'out',
  'count',
  'rgb',
  'matte',
];
const args = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries([
    ...stringOptions.map((k) => [k, { type: 'string' as const }]),
    ['help', { type: 'boolean' as const }],
  ]),
});
const command = args.positionals.join('-'),
  v = args.values as Record<string, string | boolean | undefined>;
const str = (key: string) => {
  const value = v[key];
  ensure(typeof value === 'string' && value.length > 0, `Missing --${key}`);
  return value;
};
const num = (key: string, defaultValue?: number) => {
  const n = v[key] === undefined ? defaultValue : Number(v[key]);
  ensure(Number.isSafeInteger(n) && n! >= 0, `Invalid --${key}`);
  return n!;
};
const help = `ScreenMate authoring (offline, manual approval only)
  init --plan <directory> --workspace <new-directory>
  pack new --id <id> --out <new-plan-directory>
  asset register --workspace <dir> --id <asset-id> --file <png>
  asset approve --workspace <dir> --id <asset-id> --reviewer <name> --reason <text>
  edge import --workspace <dir> --edge <id> --file <video> --profile opaque-video|packed-rgb-alpha
  edge candidates --workspace <dir> --edge <id> [--count 6]
  edge frame --workspace <dir> --edge <id> --frame <zero-based-K>
  edge trim --workspace <dir> --edge <id> --start <N> --end <exclusive-M>
  anchor propose --workspace <dir> --edge <id> --frame <zero-based-K> [--start 0]
  anchor approve --workspace <dir> --node <id> --proposal <id> --reviewer <name> --reason <text> [--new-version v002]
  edge approve --workspace <dir> --edge <id> --reviewer <name> --reason <text>
  edge prepare --workspace <dir> --edge <id>
  join preview --workspace <dir> --a <id|__entry__> --b <id>
  join approve|reject --workspace <dir> --a <id|__entry__> --b <id> --reviewer <name> --reason <text>
  pack build --workspace <dir> --version <x.y.z> --out <new-release-directory>
  pack validate --out <release-directory>
  status --workspace <dir>
  media pack-alpha --rgb <video> --matte <grayscale-video> --out <new-packed.mp4>
No command generates Seedance video or approves content automatically.`;
async function run() {
  if (v.help || !command) {
    console.log(help);
    return;
  }
  if (command === 'pack-new') {
    const packId = str('id'),
      out = path.resolve(str('out'));
    ensure(id(packId), 'Invalid pack ID');
    await fs.mkdir(out);
    await fs.mkdir(path.join(out, 'prompts'));
    await writeJson(path.join(out, 'scene.plan.json'), {
      schemaVersion: '1.0',
      planVersion: '1.0.0',
      packId,
      label: packId,
      entryNode: 'entry',
      canvas: { width: 1920, height: 1080, fpsNumerator: 30, fpsDenominator: 1 },
      display: { mode: 'overlay-stage' },
      roles: { identityAssetId: 'IDENTITY', stageAssetId: 'STAGE' },
      nodes: [{ id: 'entry', label: 'Entry', anchorId: 'H_ENTRY', designAssetId: 'STAGE', snapshot: {} }],
      edges: [
        {
          id: 'idle',
          fromNode: 'entry',
          toNode: 'entry',
          label: 'Idle',
          plannedSeconds: 12,
          prompt: 'prompts/idle.md',
          tag: 'ambient',
          weight: 1,
          cooldownSec: 0,
          status: 'planned',
          media: null,
        },
      ],
    });
    await writeJson(path.join(out, 'assets.registry.json'), {
      schemaVersion: '1.0',
      assets: [
        { id: 'IDENTITY', parents: [], prompt: 'prompts/identity.md' },
        { id: 'STAGE', parents: [], prompt: 'prompts/stage.md' },
      ],
    });
    for (const name of ['idle', 'identity', 'stage'])
      await fs.writeFile(
        path.join(out, 'prompts', name + '.md'),
        '# 请填写完整制作 brief 和提示词后再生产\n',
      );
    return { directory: out };
  }
  if (command === 'init') return initWorkspace(path.resolve(str('plan')), path.resolve(str('workspace')));
  if (command === 'media-pack-alpha')
    return packAlpha(path.resolve(str('rgb')), path.resolve(str('matte')), path.resolve(str('out')));
  if (command === 'pack-validate') {
    const p = await loadPack(path.resolve(str('out')));
    return { valid: true, packId: p.data.manifest.packId };
  }
  const w = await AuthoringWorkspace.open(path.resolve(str('workspace')));
  switch (command) {
    case 'status':
      return { plan: w.plan, state: w.state };
    case 'asset-register':
      return w.registerAsset(
        str('id'),
        path.resolve(str('file')),
        typeof v.role === 'string' ? v.role : undefined,
      );
    case 'asset-approve':
      return w.approveAsset(str('id'), str('reviewer'), str('reason'));
    case 'edge-import': {
      const p = str('profile');
      ensure(p === 'opaque-video' || p === 'packed-rgb-alpha', 'Invalid profile');
      return w.importVideo(str('edge'), path.resolve(str('file')), p);
    }
    case 'edge-candidates':
      return w.candidates(str('edge'), num('count', 6));
    case 'edge-frame':
      return w.inspectFrame(str('edge'), num('frame'));
    case 'edge-trim':
      return w.trim(str('edge'), num('start'), num('end'));
    case 'anchor-propose':
      return w.proposeAnchor(str('edge'), num('frame'), num('start', 0));
    case 'anchor-approve':
      return w.approveAnchor(
        str('node'),
        str('proposal'),
        str('reviewer'),
        str('reason'),
        typeof v['new-version'] === 'string' ? v['new-version'] : undefined,
      );
    case 'edge-approve':
      return w.approveEdge(str('edge'), str('reviewer'), str('reason'));
    case 'edge-prepare':
      return w.prepare(str('edge'));
    case 'join-preview':
      return w.previewJoin(str('a'), str('b'));
    case 'join-approve':
    case 'join-reject':
      return w.reviewJoin(str('a'), str('b'), command === 'join-approve', str('reviewer'), str('reason'));
    case 'pack-build':
      return w.build(str('version'), path.resolve(str('out')));
    default:
      throw new Error(help);
  }
}
run()
  .then((result) => {
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  })
  .catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
  });
