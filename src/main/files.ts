import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensure, safeRelative } from '../core/validate';
import { MAX_ASSET_BYTES, MAX_PACK_BYTES } from '../core/limits';
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export async function hashFile(file: string) {
  const h = createHash('sha256');
  const f = await fs.open(file, 'r');
  try {
    for await (const chunk of f.createReadStream({ autoClose: false })) h.update(chunk);
    return h.digest('hex');
  } finally {
    await f.close();
  }
}
export async function safeFile(root: string, relative: string) {
  safeRelative(relative);
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const s = await fs.lstat(current);
    ensure(!s.isSymbolicLink(), 'Symbolic link/junction is forbidden');
    ensure(!s.isFile() || s.nlink === 1, 'Hardlink is forbidden');
  }
  const real = await fs.realpath(current),
    rel = path.relative(realRoot, real);
  ensure(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'File escapes pack root');
  return real;
}
export async function readJson(file: string, max = 4 * 1024 * 1024) {
  const s = await fs.stat(file);
  ensure(s.size <= max, 'JSON size limit');
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''), (k, v) => {
    ensure(!['__proto__', 'constructor', 'prototype'].includes(k), 'Unsafe JSON key');
    return v;
  });
}
export async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(tmp, file);
}
export async function descriptor(root: string, relative: string) {
  const file = await safeFile(root, relative);
  return { path: relative, sha256: await hashFile(file), bytes: (await fs.stat(file)).size };
}
export async function inventory(root: string) {
  const result: string[] = [];
  let total = 0;
  async function scan(relative: string) {
    for (const ent of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const rel = relative ? relative + '/' + ent.name : ent.name;
      safeRelative(rel);
      const full = await safeFile(root, rel);
      if (ent.isDirectory()) {
        ensure(rel.split('/').length < 12, 'Directory nesting limit');
        await scan(rel);
      } else {
        ensure(ent.isFile() && /\.(json|png|mp4|wav|ogg)$/.test(rel), 'Unsupported file in pack');
        const size = (await fs.stat(full)).size;
        total += size;
        ensure(
          size <= MAX_ASSET_BYTES && total <= MAX_PACK_BYTES && result.length < 4096,
          'Pack size/file limit',
        );
        result.push(rel);
      }
    }
  }
  await scan('');
  return result;
}
