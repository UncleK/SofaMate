import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safeFile } from './files';
import { ensure } from '../core/validate';

// Bundled demo distribution adapter. Replaced by an HTTPS CatalogProvider and
// CommerceProvider when the product has a hosted catalog; never exposes workspace.
export async function startDemoSource(root: string) {
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    try {
      ensure(req.method === 'GET' && req.url?.startsWith('/' + token + '/'), 'Denied');
      const relative = decodeURIComponent(req.url!.slice(token.length + 2));
      const file = await safeFile(root, relative);
      res.setHeader('Content-Type', 'application/octet-stream');
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  ensure(address && typeof address === 'object', 'Cannot start demo source');
  return { baseUrl: `http://127.0.0.1:${address.port}/${token}/`, close: () => server.close() };
}
