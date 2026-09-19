export class LoopPlayer {
  private video: HTMLVideoElement;
  private stopped = true;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private frames = 0;
  private callback = 0;
  private fault: string | null = null;
  constructor(
    canvas: HTMLCanvasElement,
    private url: string,
    private label: string,
    private update: (m: any) => void,
  ) {
    const v = (this.video = document.createElement('video'));
    v.loop = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.muted = true;
    v.volume = 0;
    Object.assign(v.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      pointerEvents: 'none',
    });
    canvas.parentElement!.insertBefore(v, canvas);
    canvas.hidden = true;
    v.addEventListener('error', () => this.publish(v.error?.message ?? '视频解码失败'));
    this.timer = setInterval(() => this.publish(), 900);
    const frame = () => {
      if (this.disposed) return;
      this.frames++;
      this.callback = v.requestVideoFrameCallback(frame);
    };
    this.callback = v.requestVideoFrameCallback(frame);
    v.src = url;
  }
  private publish(fault?: string | null) {
    if (this.disposed) return;
    if (fault !== undefined) this.fault = fault;
    this.update({
      kind: 'video',
      scope: 'local-video',
      label: this.label,
      fault: this.fault,
      paused: this.video.paused,
      stopped: this.stopped,
      frames: this.frames,
      transitions: 0,
      edgeId: null,
      frame: -1,
      videoSlots: 1,
      droppedFrames: this.video.getVideoPlaybackQuality().droppedVideoFrames,
    });
  }
  async start() {
    this.stopped = false;
    await this.video.play();
    this.publish();
  }
  pause() {
    this.video.pause();
    this.publish();
  }
  resume() {
    void this.start().catch((e) => this.publish(String(e)));
  }
  stop() {
    this.stopped = true;
    this.video.pause();
    this.video.currentTime = 0;
    this.publish();
  }
  async poster() {}
  hide() {
    this.pause();
  }
  show() {}
  setVolume(volume: number) {
    this.video.volume = volume;
    this.video.muted = volume === 0;
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.video.cancelVideoFrameCallback(this.callback);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}
