import { readFile } from 'node:fs/promises';
import { validateRelease } from '../../src/core/validate';
// Graph-only regression fixture. No artwork, source videos or production paths are required.
export const topology = validateRelease(JSON.parse(await readFile(new URL('./topology.json', import.meta.url), 'utf8')));
