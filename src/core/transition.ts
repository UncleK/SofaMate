/** Scheme B: one fixed, short smoothstep blend. No shaders supplied by packs. */
export function blendWeight(elapsedFrames: number, blendFrames: number) {
  if (!Number.isFinite(elapsedFrames) || !Number.isInteger(blendFrames) || blendFrames <= 0)
    throw new Error('Invalid transition timing');
  const t = Math.min(1, Math.max(0, elapsedFrames / blendFrames));
  return t * t * (3 - 2 * t);
}
