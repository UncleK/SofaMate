import { build } from 'vite';
import fs from 'node:fs/promises';
await build({ root: '.', base: './', build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' } });
await fs.cp('../../assets/brand/screenmate-128.png', 'dist/logo.png');
