import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
await mkdir('dist/market', { recursive: true });
await build({ entryPoints: ['scripts/market.ts'], outfile: 'dist/market/market.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', sourcemap: false });
await cp('site', 'dist/market/site', { recursive: true });
console.log('Built standalone Node.js 24 market and static site.');
