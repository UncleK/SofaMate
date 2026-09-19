export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type MediaProfile = 'opaque-video' | 'packed-rgb-alpha';
export interface AssetFile {
  path: string;
  sha256: string;
  bytes: number;
}
export interface Manifest {
  schemaVersion: '1.0';
  packId: string;
  packVersion: string;
  minRuntimeVersion: string;
  label: string;
  entryNode: string;
  entryPoster: AssetFile;
  canvas: { width: number; height: number; fpsNumerator: number; fpsDenominator: number };
  displayMode: 'overlay-stage' | 'scene-preview';
  fit: 'contain';
  mediaProfile: MediaProfile;
  graph: AssetFile;
  joins: AssetFile;
  provenance: AssetFile;
  ambientAudio: AssetFile | null;
  requiredCapabilities: string[];
  startPoints?: StartPoint[];
}
export interface StartPoint {
  edgeId: string;
  poster: AssetFile;
  mediaHash: string;
  trimFingerprint: string;
  approvedBy: string;
  approvedAt: string;
}
export interface DockNode {
  id: string;
  label: string;
  anchorVersion: string;
  anchorImageHash: string;
  snapshot: Record<string, JsonValue>;
}
export interface EdgeClip {
  id: string;
  from: string;
  to: string;
  video: AssetFile;
  profile: MediaProfile;
  decodedWidth: number;
  decodedHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
  frameCount: number;
  inFrame: number;
  outFrameExclusive: number;
  actualDurationSec: number;
  sourceAnchorVersion: string;
  targetAnchorVersion: string;
  tag: string;
  weight: number;
  cooldownGroup: string | null;
  cooldownSec: number;
  initialDelaySec: number;
  requiredCapabilities: string[];
}
export interface JoinApproval {
  incomingEdgeId: string;
  outgoingEdgeId: string;
  nodeId: string;
  status: 'approved';
  method: 'cut' | 'smooth-crossfade';
  blendFrames: number;
  incomingMediaOrPosterHash: string;
  outgoingMediaHash: string;
  incomingTrimFingerprint: string;
  outgoingTrimFingerprint: string;
  anchorVersion: string;
  evidencePath: string;
  approvedAt: string;
  approvedBy: string;
}
export interface ReleaseGraph {
  nodes: DockNode[];
  edges: EdgeClip[];
}
export interface ReleaseJoins {
  schemaVersion: '1.0';
  joins: JoinApproval[];
}
export interface LoadedPack {
  manifest: Manifest;
  graph: ReleaseGraph;
  joins: ReleaseJoins;
}
export interface Cursor {
  nodeId: string;
  incomingEdgeId: string | null;
}
export const RUNTIME_VERSION = '0.1.0';
export const CAPABILITIES = ['opaque-video', 'packed-rgb-alpha', 'cut', 'random-start', 'smooth-crossfade'] as const;
export const trimFingerprint = (e: EdgeClip) =>
  `${e.inFrame}:${e.outFrameExclusive}:${e.fpsNumerator}/${e.fpsDenominator}`;
