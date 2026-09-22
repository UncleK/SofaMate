export async function makePreview(
  url: string,
  report: (n: number) => void,
  signal: AbortSignal,
): Promise<number[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  const wait = (event: string, run: () => void) =>
    new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        video.removeEventListener(event, ok);
        video.removeEventListener('error', bad);
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const ok = () => finish(),
        bad = () => finish(Error('视频解码失败，请使用 H.264 / AAC MP4')),
        abort = () => finish(Error('预览生成已取消'));
      const timer = setTimeout(() => finish(Error('读取视频超时，请重试')), 20000);
      video.addEventListener(event, ok, { once: true });
      video.addEventListener('error', bad, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else run();
    });
  try {
    await wait('loadeddata', () => {
      video.src = url;
      video.load();
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight)
      throw Error('无法读取视频画面');
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#151918';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 9; i++) {
      if (signal.aborted) throw Error('预览生成已取消');
      const t = (video.duration * (i + 0.5)) / 9;
      await wait('seeked', () => {
        video.currentTime = t;
      });
      if (video.readyState < 2) throw Error('视频未能解码到预览位置');
      const cellW = 640,
        cellH = 360,
        scale = Math.min(cellW / video.videoWidth, cellH / video.videoHeight);
      const width = video.videoWidth * scale,
        height = video.videoHeight * scale;
      ctx.drawImage(
        video,
        (i % 3) * cellW + (cellW - width) / 2,
        Math.floor(i / 3) * cellH + (cellH - height) / 2,
        width,
        height,
      );
      report(i + 1);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    // Same layout as the official scene: no outside padding, 4px interior rules.
    ctx.fillStyle='#151918';
    for(const x of [640,1280])ctx.fillRect(x-2,0,4,1080);
    for(const y of [360,720])ctx.fillRect(0,y-2,1920,4);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(Error('预览图生成失败'))), 'image/jpeg', 0.85),
    );
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}
