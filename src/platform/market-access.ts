import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthOptions } from './auth';
export type MarketOptions = {
  publicOrigin?: string;
  auth?: AuthOptions;
  adminTokenHash?: string;
  maxTotalBytes?: number;
  maxOwnerBytes?: number;
  maxOwnerItems?: number;
  maxItems?: number;
};
export class MarketError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const matches = (value: string, hash?: string) => !!hash && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));
export function serial() {
  let tail = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.then(() => {}, () => {});
    return result;
  };
}
