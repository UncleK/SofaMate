import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensure, hash, id, safeRelative } from '../core/validate';
import { hashFile, inventory, readJson, safeFile } from './files';
import { installPack, loadPack } from './pack-loader';
import type { DownloadStatus, Theme, Variant } from '../shared/store';
import { MAX_ASSET_BYTES, MAX_PACK_BYTES } from '../core/limits';

export interface ArtifactRef {
  path: string;
  sha256: string;
  bytes: number;
}
export interface CatalogVariant extends Variant {
  artifact?: ArtifactRef;
}
export interface CatalogTheme extends Omit<Theme, 'variants'> {
  variants: CatalogVariant[];
}
export interface CatalogProvider {
  list(): Promise<CatalogTheme[]>;
}
export interface DownloadGrant {
  descriptorUrl: string;
  descriptorSha256: string;
  descriptorBytes: number;
}
export interface Entitlement {
  offerId: string;
  state: 'free' | 'owned' | 'purchase-required' | 'unavailable';
}
// Implementations run in the main process. A paid provider must verify ownership on
// its server and return a short-lived grant; renderer/local purchase flags are never authority.
export interface CommerceProvider {
  readonly checkoutAvailable: boolean;
  entitlement(variant: CatalogVariant): Promise<Entitlement>;
  checkout(variant: CatalogVariant): Promise<{ checkoutId: string; checkoutUrl: string }>;
  authorizeDownload(variant: CatalogVariant): Promise<DownloadGrant>;
}
export class FreeDemoCommerce implements CommerceProvider {
  readonly checkoutAvailable = false;
  constructor(private baseUrl: string) {}
  async entitlement(v: CatalogVariant): Promise<Entitlement> {
    return {
      offerId: v.offerId,
      state: v.access === 'free' ? 'free' : v.access === 'paid' ? 'purchase-required' : 'unavailable',
    };
  }
  async checkout(_v: CatalogVariant): Promise<never> {
    throw new Error('付费服务尚未开通');
  }
  async authorizeDownload(v: CatalogVariant): Promise<DownloadGrant> {
    ensure(v.access === 'free', '此内容需要由服务端确认购买权益');
    ensure(v.availability === 'ready' && v.artifact, '此规格尚未发布');
    return {
      descriptorUrl: new URL(v.artifact.path, this.baseUrl).href,
      descriptorSha256: v.artifact.sha256,
      descriptorBytes: v.artifact.bytes,
    };
  }
}
export async function readCatalog(file: string): Promise<CatalogTheme[]> {
  const c = await readJson(file);
  ensure(c?.schemaVersion === '1.0' && Array.isArray(c.themes) && c.themes.length <= 100, 'Invalid catalog');
  const ids = new Set<string>();
  for (const t of c.themes) {
    ensure(
      id(t.id) &&
        typeof t.label === 'string' &&
        t.label.length <= 100 &&
        typeof t.description === 'string' &&
        t.description.length <= 1000 &&
        Array.isArray(t.variants),
      'Invalid theme',
    );
    if (t.previews !== undefined) {
      ensure(Array.isArray(t.previews) && t.previews.length <= 12, 'Invalid previews');
      for (const p of t.previews) {
        ensure(
          typeof p.label === 'string' &&
            p.label.length <= 100 &&
            hash(p.sha256) &&
            Number.isSafeInteger(p.bytes) &&
            p.bytes > 0 &&
            p.bytes <= 4 * 1024 * 1024,
          'Invalid preview',
        );
        safeRelative(p.path);
        ensure(/\.(png|jpg|jpeg|webp)$/.test(p.path), 'Invalid preview format');
        const image = await safeFile(path.dirname(file), p.path);
        ensure(
          (await fs.stat(image)).size === p.bytes && (await hashFile(image)) === p.sha256,
          'Preview integrity mismatch',
        );
      }
    }
    for (const v of t.variants) {
      ensure(
        id(v.id) &&
          !ids.has(v.id) &&
          id(v.packId) &&
          id(v.offerId) &&
          /^\d+\.\d+\.\d+$/.test(v.version) &&
          typeof v.label === 'string' &&
          v.label.length <= 100 &&
          ['ready', 'planned'].includes(v.availability) &&
          ['free', 'paid', 'undecided'].includes(v.access) &&
          [v.width, v.height, v.fps].every((n) => Number.isSafeInteger(n) && n > 0),
        'Invalid variant',
      );
      ids.add(v.id);
      if (v.availability === 'ready') {
        ensure(v.access !== 'undecided', 'Published offer needs an access policy');
        ensure(
          v.artifact &&
            hash(v.artifact.sha256) &&
            Number.isSafeInteger(v.artifact.bytes) &&
            v.artifact.bytes > 0 &&
            v.artifact.bytes <= 2 * 1024 * 1024,
          'Invalid artifact',
        );
        safeRelative(v.artifact.path);
      }
    }
  }
  return c.themes;
}
// UI receives product information only, never signed grants or transport URLs.
export function publicThemes(themes: CatalogTheme[]): Theme[] {
  return themes.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    previews: t.previews,
    variants: t.variants.map(({ artifact: _, ...v }) => v),
  }));
}
function transportUrl(input: string, allowLoopback: boolean) {
  const u = new URL(input);
  ensure(
    !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === 'https:' || (allowLoopback && u.protocol === 'http:' && u.hostname === '127.0.0.1')),
    'Download transport denied',
  );
  return u;
}
async function response(url: string, signal: AbortSignal) {
  const r = await fetch(url, { signal, redirect: 'error' });
  ensure(r.ok && r.body, `下载服务返回 ${r.status}`);
  return r;
}
// Only removes the private stage created by this download, with every path checked.
async function clearStage(root: string, stage: string) {
  ensure(
    path.dirname(stage) === path.resolve(root) && path.basename(stage).startsWith('.download-'),
    'Invalid stage',
  );
  async function walk(dir: string) {
    ensure(!(await fs.lstat(dir)).isSymbolicLink(), 'Unsafe staging directory');
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name),
        s = await fs.lstat(f);
      ensure(!s.isSymbolicLink(), 'Unsafe staging file');
      if (s.isDirectory()) await walk(f);
      else {
        ensure(s.isFile() && s.nlink === 1, 'Unsafe staging entry');
        await fs.unlink(f);
      }
    }
    await fs.rmdir(dir);
  }
  await walk(stage);
}
export class DownloadManager {
  status: DownloadStatus = { id: null, state: 'idle', received: 0, total: 0, message: '' };
  private controller: AbortController | null = null;
  constructor(
    private library: string,
    private commerce: CommerceProvider,
    private notify: (s: DownloadStatus) => void,
    private allowLoopback = false,
  ) {}
  private update(p: Partial<DownloadStatus>) {
    this.status = { ...this.status, ...p };
    this.notify({ ...this.status });
  }
  cancel() {
    if (this.status.state === 'downloading') this.controller?.abort();
  }
  async install(v: CatalogVariant) {
    ensure(!this.controller, '已有下载任务正在进行');
    ensure(v.availability === 'ready', '此规格尚未发布');
    const controller = (this.controller = new AbortController());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
    let stage: string | null = null;
    this.update({ id: v.id, state: 'downloading', received: 0, total: 0, message: '正在获取下载授权…' });
    try {
      const grant = await this.commerce.authorizeDownload(v);
      signal.throwIfAborted();
      const url = transportUrl(grant.descriptorUrl, this.allowLoopback);
      ensure(
        hash(grant.descriptorSha256) &&
          Number.isSafeInteger(grant.descriptorBytes) &&
          grant.descriptorBytes > 0 &&
          grant.descriptorBytes <= 2 * 1024 * 1024,
        'Invalid download grant',
      );
      const r = await response(url.href, signal),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        ensure(bytes <= grant.descriptorBytes, 'Descriptor exceeds limit');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      ensure(
        bytes === grant.descriptorBytes &&
          createHash('sha256').update(raw).digest('hex') === grant.descriptorSha256,
        'Download descriptor hash mismatch',
      );
      const d = JSON.parse(raw.toString('utf8'));
      ensure(
        d?.schemaVersion === '1.0' &&
          d.packId === v.packId &&
          d.version === v.version &&
          Array.isArray(d.files) &&
          d.files.length > 0 &&
          d.files.length <= 4096,
        'Invalid download descriptor',
      );
      const names = new Set<string>();
      let total = 0;
      for (const a of d.files) {
        safeRelative(a.path);
        ensure(
          /\.(json|png|mp4|wav|ogg)$/.test(a.path) &&
            !names.has(a.path.toLowerCase()) &&
            hash(a.sha256) &&
            Number.isSafeInteger(a.bytes) &&
            a.bytes > 0 &&
            a.bytes <= MAX_ASSET_BYTES,
          'Invalid download file',
        );
        names.add(a.path.toLowerCase());
        total += a.bytes;
      }
      ensure(
        total <= MAX_PACK_BYTES && names.has('manifest.json') && names.has('checksums.json'),
        'Download size or manifest invalid',
      );
      await fs.mkdir(this.library, { recursive: true });
      stage = path.join(path.resolve(this.library), '.download-' + randomUUID());
      await fs.mkdir(stage);
      this.update({ total, message: '正在下载…' });
      for (const a of d.files) {
        signal.throwIfAborted();
        const fileUrl = new URL(`files/${a.path}`, url);
        ensure(fileUrl.origin === url.origin, 'Download origin mismatch');
        const res = await response(fileUrl.href, signal);
        const output = path.join(stage, a.path);
        await fs.mkdir(path.dirname(output), { recursive: true });
        const handle = await fs.open(output, 'wx');
        const h = createHash('sha256');
        let count = 0;
        try {
          for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
            signal.throwIfAborted();
            count += chunk.length;
            ensure(count <= a.bytes, 'Downloaded file exceeds expected size');
            h.update(chunk);
            await handle.writeFile(chunk);
            this.update({ received: this.status.received + chunk.length });
          }
        } finally {
          await handle.close();
        }
        ensure(count === a.bytes && h.digest('hex') === a.sha256, `下载校验失败：${a.path}`);
      }
      signal.throwIfAborted();
      this.update({ state: 'verifying', message: '正在校验并安装…' });
      const checked = await loadPack(stage);
      ensure(
        checked.data.manifest.packId === v.packId &&
          checked.data.manifest.packVersion === v.version &&
          checked.data.manifest.canvas.width === v.width &&
          checked.data.manifest.canvas.height === v.height &&
          checked.data.manifest.canvas.fpsNumerator / checked.data.manifest.canvas.fpsDenominator === v.fps,
        'Downloaded product identity differs from catalog',
      );
      signal.throwIfAborted();
      // Atomic commit begins here; cancel is disabled during verification/commit in the UI.
      const installed = await installPack(stage, this.library);
      this.update({ state: 'installed', message: '已下载，可离线播放' });
      return installed;
    } catch (e) {
      this.update({
        state: controller.signal.aborted ? 'cancelled' : 'failed',
        message: controller.signal.aborted ? '下载已取消' : String(e),
      });
      throw e;
    } finally {
      this.controller = null;
      if (stage) await clearStage(this.library, stage);
    }
  }
}
