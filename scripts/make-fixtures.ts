import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { descriptor, hashFile, readJson, writeJson } from '../src/main/files';
import { command, extractFrame, probe } from '../src/authoring/media';
import { loadPack } from '../src/main/pack-loader';
import { trimFingerprint, type EdgeClip, type JoinApproval, type LoadedPack } from '../src/core/types';
const cwd = process.cwd();
const width = 320,
  height = 180,
  fps = 30,
  count = 30;
export async function syntheticVideo(output: string, from = 0, to = 1, packed = true) {
  const w = width * (packed ? 2 : 1);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const ff = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${w}x${height}`,
      '-r',
      String(fps),
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'libx264',
      '-crf',
      '10',
      '-preset',
      'fast',
      '-g',
      '30',
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      output,
    ],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let errors = '';
  ff.stderr.on('data', (b) => (errors += b.toString()));
  const done = once(ff, 'close');
  const colors = [
    [216, 126, 77],
    [96, 174, 186],
    [171, 149, 211],
    [133, 186, 131],
    [213, 176, 83],
    [207, 115, 161],
  ];
  for (let frame = 0; frame < count; frame++) {
    const t = frame / (count - 1),
      smooth = t * t * (3 - 2 * t),
      a = colors[from % colors.length],
      b = colors[to % colors.length],
      cx = 80 + ((from * 29) % 140) + (((to * 29) % 140) - ((from * 29) % 140)) * smooth;
    const buffer = Buffer.alloc(w * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < w; x++) {
        const xx = x % width,
          index = (y * w + x) * 3;
        const border = Math.min(xx, width - 1 - xx, y, height - 1 - y);
        const alpha = Math.max(0, Math.min(1, (border - 12) / 30));
        if (packed && x >= width) {
          const value = Math.round(alpha * 255);
          buffer[index] = buffer[index + 1] = buffer[index + 2] = value;
        } else {
          const disc = Math.hypot(xx - cx, y - 90) < 25;
          for (let k = 0; k < 3; k++)
            buffer[index + k] = Math.round(
              (a[k] + (b[k] - a[k]) * smooth) * (disc ? 1 : 0.52) + ((xx + 3 * y) % 24 < 2 ? 14 : 0),
            );
        }
      }
    if (!ff.stdin.write(buffer)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error(errors);
}
export async function makeFixture(
  planFile: string,
  packId: string,
  profile: 'opaque-video' | 'packed-rgb-alpha',
) {
  const p = await readJson(planFile),
    dir = path.join(cwd, 'content', packId, '0.1.0');
  try {
    const existing = await loadPack(dir);
    return { directory: dir, reused: true, edges: existing.data.graph.edges.length };
  } catch (e: any) {
    try {
      await fs.access(dir);
      throw new Error(`Existing fixture is invalid; preserve it and choose a new version: ${dir}: ${e}`);
    } catch (access: any) {
      if (access.code !== 'ENOENT') throw access;
    }
  }
  await fs.mkdir(path.join(dir, 'media/video'), { recursive: true });
  await fs.mkdir(path.join(dir, 'media/posters'), { recursive: true });
  const anchorHashes = new Map<string, string>();
  for (const [i, n] of p.nodes.entries()) {
    const tmp = path.join(dir, `media/video/anchor-${i}.mp4`);
    await syntheticVideo(tmp, i, i, profile === 'packed-rgb-alpha');
    const frame = path.join(dir, `media/posters/${n.id}.png`);
    await extractFrame(tmp, 0, frame);
    if (profile === 'packed-rgb-alpha') {
      const packed = frame + '.packed.png';
      await fs.rename(frame, packed);
      await command('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-i',
        packed,
        '-filter_complex',
        '[0:v]split[c][a];[c]crop=iw/2:ih:0:0[r];[a]crop=iw/2:ih:iw/2:0,format=gray[m];[r][m]alphamerge[v]',
        '-map',
        '[v]',
        '-frames:v',
        '1',
        frame,
      ]);
      await fs.unlink(packed);
    }
    await fs.unlink(frame.replace(/\.png$/, '.frame.json'));
    await fs.unlink(tmp);
    anchorHashes.set(n.id, await hashFile(frame));
  }
  const nodes = p.nodes.map((n: any) => ({
    id: n.id,
    label: n.label,
    anchorVersion: 'test-v001',
    anchorImageHash: anchorHashes.get(n.id),
    snapshot: n.snapshot,
  }));
  const edges: EdgeClip[] = [];
  for (const e of p.edges) {
    const relative = `media/video/${e.id}.mp4`;
    await syntheticVideo(
      path.join(dir, relative),
      p.nodes.findIndex((n: any) => n.id === e.fromNode),
      p.nodes.findIndex((n: any) => n.id === e.toNode),
      profile === 'packed-rgb-alpha',
    );
    const actual = await probe(path.join(dir, relative));
    edges.push({
      id: e.id,
      from: e.fromNode,
      to: e.toNode,
      video: await descriptor(dir, relative),
      profile,
      decodedWidth: actual.width,
      decodedHeight: actual.height,
      fpsNumerator: fps,
      fpsDenominator: 1,
      frameCount: count,
      inFrame: 0,
      outFrameExclusive: count,
      actualDurationSec: count / fps,
      sourceAnchorVersion: 'test-v001',
      targetAnchorVersion: 'test-v001',
      tag: e.tag,
      weight: e.weight,
      cooldownGroup: null,
      cooldownSec: e.cooldownSec,
      initialDelaySec: 0,
      requiredCapabilities: [profile, 'cut'],
    });
  }
  const poster = await descriptor(dir, `media/posters/${p.entryNode}.png`);
  const joins: JoinApproval[] = [];
  for (const b of edges)
    for (const a of [...edges.filter((a) => a.to === b.from), ...(b.from === p.entryNode ? [null] : [])]) {
      const j: JoinApproval = {
        incomingEdgeId: a?.id ?? '__entry__',
        outgoingEdgeId: b.id,
        nodeId: b.from,
        status: 'approved',
        method: 'cut',
        blendFrames: 0,
        incomingMediaOrPosterHash: a?.video.sha256 ?? poster.sha256,
        outgoingMediaHash: b.video.sha256,
        incomingTrimFingerprint: a ? trimFingerprint(a) : 'poster',
        outgoingTrimFingerprint: trimFingerprint(b),
        anchorVersion: 'test-v001',
        evidencePath: `reviews/${a?.id ?? 'entry'}-${b.id}.json`,
        approvedAt: new Date().toISOString(),
        approvedBy: 'synthetic-fixture-builder (engineering only)',
      };
      joins.push(j);
      await writeJson(path.join(dir, j.evidencePath), {
        join: j,
        synthetic: true,
        reason: 'Deterministic engineering pattern. Not a human/video visual approval.',
      });
    }
  await writeJson(path.join(dir, 'graph.json'), { nodes, edges });
  await writeJson(path.join(dir, 'joins.json'), { schemaVersion: '1.0', joins });
  await writeJson(path.join(dir, 'provenance.json'), {
    synthetic: true,
    sourcePlan: path.relative(cwd, planFile).replaceAll('\\', '/'),
    purpose: 'Engineering only; no person or final visual approval',
    generator: 'scripts/make-fixtures.ts',
    layout: profile === 'packed-rgb-alpha' ? 'RGB left, grayscale alpha right' : null,
  });
  const manifest: LoadedPack['manifest'] = {
    schemaVersion: '1.0',
    packId,
    packVersion: '0.1.0',
    minRuntimeVersion: '0.1.0',
    label: `工程测试 · ${p.nodes.length} 节点 / ${p.edges.length} 边 · ${profile === 'packed-rgb-alpha' ? '透明梯度' : '不透明'}（非真实素材）`,
    entryNode: p.entryNode,
    entryPoster: poster,
    canvas: { width, height, fpsNumerator: fps, fpsDenominator: 1 },
    displayMode: profile === 'packed-rgb-alpha' ? 'overlay-stage' : 'scene-preview',
    fit: 'contain',
    mediaProfile: profile,
    graph: await descriptor(dir, 'graph.json'),
    joins: await descriptor(dir, 'joins.json'),
    provenance: await descriptor(dir, 'provenance.json'),
    ambientAudio: null,
    requiredCapabilities: [profile, 'cut'],
  };
  await writeJson(path.join(dir, 'manifest.json'), manifest);
  const checks: Record<string, string> = {};
  async function walk(current: string, relative = '') {
    for (const e of await fs.readdir(current, { withFileTypes: true })) {
      const rel = relative ? relative + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(current, e.name), rel);
      else checks[rel] = await hashFile(path.join(current, e.name));
    }
  }
  await walk(dir);
  await writeJson(path.join(dir, 'checksums.json'), checks);
  await loadPack(dir);
  return { directory: dir, edges: edges.length, joins: joins.length };
}
if (process.argv[1]?.endsWith('make-fixtures.ts')) {
  console.log(
    await makeFixture(
      path.join(cwd, 'tests/fixtures/engineering.plan.json'),
      'engineering-graph',
      'packed-rgb-alpha',
    ),
  );
  console.log(
    await makeFixture(
      path.join(cwd, 'ScenePack_Codex_Kit/fixtures/second_scene_minimal/scene.plan.json'),
      'engineering-second',
      'opaque-video',
    ),
  );
}
