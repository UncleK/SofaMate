import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensure, validateRelease, hash } from '../core/validate';
import type { LoadedPack, AssetFile } from '../core/types';
import { descriptor, hashFile, inventory, readJson, safeFile } from './files';
import { mp4Info } from './mp4';
export interface DiskPack {
  root: string;
  data: LoadedPack;
  files: Map<string, AssetFile>;
}
export async function loadPack(root: string): Promise<DiskPack> {
  root = await fs.realpath(root);
  const names = await inventory(root);
  ensure(names.includes('manifest.json'), 'No release manifest; authoring plans are not playable');
  const checks = await readJson(await safeFile(root, 'checksums.json'));
  ensure(checks && typeof checks === 'object' && !Array.isArray(checks), 'Invalid checksums');
  const files = new Map<string, AssetFile>();
  ensure(Object.keys(checks).length === names.length - 1, 'Checksums must cover every pack file');
  for (const name of names) {
    if (name === 'checksums.json') continue;
    ensure(hash(checks[name]), `Missing checksum: ${name}`);
    const d = await descriptor(root, name);
    ensure(d.sha256 === checks[name], `Hash mismatch: ${name}`);
    files.set(name, d);
  }
  const verified = async (a: AssetFile) => {
    ensure(a && files.has(a.path), `Missing file ${a?.path}`);
    const actual = files.get(a.path)!;
    ensure(actual.sha256 === a.sha256 && actual.bytes === a.bytes, `Descriptor mismatch: ${a.path}`);
    return safeFile(root, a.path);
  };
  const manifest = await readJson(await safeFile(root, 'manifest.json'));
  const graph = await readJson(await verified(manifest.graph)),
    joins = await readJson(await verified(manifest.joins));
  const data = validateRelease({ manifest, graph, joins });
  for (const asset of [manifest.entryPoster, ...(manifest.startPoints ?? []).map((s: any) => s.poster)]) {
    const poster = await fs.readFile(await verified(asset));
    ensure(
      poster.length >= 24 &&
        poster.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
        poster.readUInt32BE(16) === manifest.canvas.width &&
        poster.readUInt32BE(20) === manifest.canvas.height,
      'Invalid entry PNG or canvas dimensions',
    );
  }
  await verified(manifest.provenance);
  if (manifest.ambientAudio) {
    const b = await fs.readFile(await verified(manifest.ambientAudio));
    ensure(
      (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') ||
        b.toString('ascii', 0, 4) === 'OggS',
      'Invalid ambient audio',
    );
  }
  const probed = new Map<string, ReturnType<typeof mp4Info>>();
  for (const e of data.graph.edges) {
    const file = await verified(e.video);
    let info = probed.get(e.video.path);
    if (!info) {
      info = mp4Info(await fs.readFile(file));
      probed.set(e.video.path, info);
    }
    ensure(
      info.width === e.decodedWidth &&
        info.height === e.decodedHeight &&
        info.frameCount === e.frameCount &&
        info.fpsNumerator / e.fpsNumerator === info.fpsDenominator / e.fpsDenominator,
      `Actual media differs from release: ${e.id}`,
    );
  }
  for (const j of data.joins.joins) {
    ensure(files.has(j.evidencePath), 'Missing review evidence');
    const review = await readJson(await safeFile(root, j.evidencePath));
    ensure(JSON.stringify(review.join) === JSON.stringify(j), 'Review evidence does not match approved join');
  }
  return { root, data, files };
}
// Directory-only import deliberately rejects archives before any extraction.
export async function installPack(source: string, library: string) {
  ensure(
    (await fs.lstat(source)).isDirectory() && !(await fs.lstat(source)).isSymbolicLink(),
    'Select an unpacked release directory; archives are not supported',
  );
  const original = await loadPack(source);
  await fs.mkdir(library, { recursive: true });
  const dest = path.join(library, original.data.manifest.packId, original.data.manifest.packVersion);
  try {
    await fs.access(dest);
    throw new Error('This immutable pack version already exists');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  const stage = path.join(library, '.import-' + crypto.randomUUID());
  await fs.mkdir(stage);
  try {
    for (const rel of await inventory(original.root)) {
      const target = path.join(stage, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(await safeFile(original.root, rel), target, 1);
    }
    await loadPack(stage);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(stage, dest);
    return loadPack(dest);
  } catch (e) {
    await fs.rm(stage, { recursive: true, force: true });
    throw e;
  }
}
export async function verifiedMedia(pack: DiskPack, rel: string) {
  const asset = pack.files.get(rel);
  ensure(asset && /\.(mp4|png|wav|ogg)$/.test(rel), 'Media not in validated pack');
  const file = await safeFile(pack.root, rel);
  ensure((await hashFile(file)) === asset.sha256, 'Media changed since validation');
  return file;
}
