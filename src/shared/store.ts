export type Access = 'free' | 'paid' | 'undecided';
export interface Variant {
  id: string;
  label: string;
  packId: string;
  version: string;
  width: number;
  height: number;
  fps: number;
  availability: 'ready' | 'planned';
  access: Access;
  offerId: string;
}
export interface Theme {
  id: string;
  label: string;
  description: string;
  previews?: { path: string; label: string; sha256: string; bytes: number }[];
  variants: Variant[];
}
export interface DownloadStatus {
  id: string | null;
  state: 'idle' | 'downloading' | 'verifying' | 'installed' | 'cancelled' | 'failed';
  received: number;
  total: number;
  message: string;
}
export interface StoreView {
  themes: Theme[];
  checkoutAvailable: boolean;
  download: DownloadStatus;
}
