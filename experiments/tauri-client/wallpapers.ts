export type LocalVideo = {
  id: string;
  title: string;
  bytes: number;
  ready: boolean;
  sha256: string;
  info: { width: number; height: number; duration: number };
  createdAt: number;
};
export type Preset = {
  id: string;
  label: string;
  scope: string;
  baseUrl: string;
  presentation: {
    themeId: string;
    label: string;
    description: string;
    previewPath: string;
    variantLabel: string;
    variants: { label: string; local: boolean; state: string }[];
  };
};
export type Wallpaper = {
  id: string;
  title: string;
  description: string;
  cover: string;
  ready: boolean;
  playbackIds: string[];
  presets: Preset[];
  video?: LocalVideo;
};
export const media = (e: LocalVideo, name: string) => `http://scene.localhost/local/${e.id}/${name}`;
export function themeWallpapers(presets: Preset[]): Wallpaper[] {
  const groups = new Map<string, Wallpaper>();
  for (const p of presets) {
    const id = 'theme:' + p.presentation.themeId;
    if (!groups.has(id))
      groups.set(id, {
        id,
        title: p.presentation.label,
        description: p.presentation.description,
        cover: p.baseUrl + p.presentation.previewPath,
        ready: true,
        presets: [],
        playbackIds: [],
      });
    const item = groups.get(id)!;
    item.presets.push(p);
    item.playbackIds.push(p.id);
  }
  return [...groups.values()];
}
export function libraryWallpapers(presets: Preset[], videos: LocalVideo[]): Wallpaper[] {
  return [
    ...themeWallpapers(presets),
    ...[...videos]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((video) => ({
        id: 'local:' + video.id,
        title: video.title,
        description: '',
        cover: video.ready ? media(video, 'cover.jpg') + '?v=' + video.createdAt : '',
        ready: video.ready,
        playbackIds: ['local:' + video.id],
        presets: [],
        video,
      })),
  ];
}
export function isActive(item: Wallpaper, metrics: any): boolean {
  return (
    !!metrics &&
    !metrics.stopped &&
    !metrics.fault &&
    !metrics.loading &&
    item.playbackIds.includes(metrics.selectionId)
  );
}
