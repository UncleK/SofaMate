import { PlaybackMachine } from '../core/graph';
import type { LoadedPack, EdgeClip } from '../core/types';
import { Compositor } from './compositor';
import { blendWeight } from '../core/transition';
export interface Metrics {
  frames: number;
  transitions: number;
  stalls: number;
  droppedFrames: number;
  maxTransitionGapMs: number;
  maxFrameGapMs: number;
  gapsMs: number[];
  fault: string | null;
  edgeId: string | null;
  frame: number;
  completed: number;
  paused: boolean;
  videoSlots: number;
  sampledBlankFrames: number;
  stopped: boolean;
  finalFrameRecoveries: number;
  lastRecovery: {
    edgeId: string;
    priorFrame: number;
    mediaTime: number;
    elapsedMs: number;
    result: 'decoding' | 'decoded' | 'failed';
    method?: 'decoded-snapshot' | 'reload';
    decodedMediaTime?: number;
  } | null;
}
function once(target: HTMLMediaElement, event: string, timeout = 10000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Media timeout: ${event}`)), timeout);
    const ok = () => finish(),
      bad = () => finish(new Error(target.error?.message ?? 'Decode failure'));
    function finish(e?: Error) {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener('error', bad);
      e ? reject(e) : resolve();
    }
    target.addEventListener(event, ok, { once: true });
    target.addEventListener('error', bad, { once: true });
  });
}
export class VideoPlayer {
  machine: PlaybackMachine;
  readonly compositor: Compositor;
  private slots: HTMLVideoElement[];
  private slotDropped = [0, 0];
  private activeSlot = 0;
  private prepared: { slot: number; edge: EdgeClip } | null = null;
  private preparing: Promise<void> | null = null;
  private generation = 0;
  private stopped = true;
  private endedFrame = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryFinalFrame: (() => void) | null = null;
  private waitStarted = 0;
  private callbackIds = [0, 0];
  private lastDraw = 0;
  private volume = 0;
  private activePrefixFrames = 0;
  private blend: { slot: number; frames: number; edge: EdgeClip; weight: number } | null = null;
  private blendAnimation = 0;
  private ambient: HTMLAudioElement | null = null;
  private target: string | null = null;
  private queued: string | null = null;
  metrics: Metrics = {
    frames: 0,
    transitions: 0,
    stalls: 0,
    droppedFrames: 0,
    maxTransitionGapMs: 0,
    maxFrameGapMs: 0,
    gapsMs: [],
    fault: null,
    edgeId: null,
    frame: -1,
    completed: 0,
    paused: false,
    videoSlots: 2,
    sampledBlankFrames: 0,
    stopped: true,
    finalFrameRecoveries: 0,
    lastRecovery: null,
  };
  constructor(
    readonly pack: LoadedPack,
    readonly canvas: HTMLCanvasElement,
    readonly url: (relative: string) => string,
    readonly update: (m: Metrics) => void,
    readonly auditFrames = false,
  ) {
    this.machine = new PlaybackMachine(pack);
    canvas.width = pack.manifest.canvas.width;
    canvas.height = pack.manifest.canvas.height;
    this.compositor = new Compositor(canvas);
    this.slots = [document.createElement('video'), document.createElement('video')];
    for (const v of this.slots) {
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.playsInline = true;
      v.style.display = 'none';
      if (pack.manifest.mediaProfile === 'opaque-video') {
        Object.assign(v.style, {
          position: 'absolute',
          inset: '0',
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          pointerEvents: 'none',
        });
        canvas.parentElement!.insertBefore(v, canvas);
      } else document.body.append(v);
      v.addEventListener('error', () => {
        if (!this.stopped) this.fail(v.error?.message ?? 'Media decode failed');
      });
    }
    if (pack.manifest.ambientAudio) {
      this.ambient = new Audio(url(pack.manifest.ambientAudio.path));
      this.ambient.loop = true;
      this.ambient.volume = 0;
    }
  }
  private recordDropped(slot: number) {
    const current = this.slots[slot].getVideoPlaybackQuality().droppedVideoFrames;
    this.metrics.droppedFrames += Math.max(0, current - this.slotDropped[slot]);
    this.slotDropped[slot] = current;
  }
  private audit() {
    if (!this.auditFrames) return;
    const g = this.compositor.gl,
      values = new Uint8Array(4);
    let blank = 0;
    for (const ratio of [0.35, 0.5, 0.65]) {
      g.readPixels(
        Math.floor(this.canvas.width * ratio),
        Math.floor(this.canvas.height / 2),
        1,
        1,
        g.RGBA,
        g.UNSIGNED_BYTE,
        values,
      );
      if (values[0] + values[1] + values[2] < 4) blank++;
    }
    if (blank === 3) this.metrics.sampledBlankFrames++;
  }
  private publish() {
    this.metrics.stopped = this.stopped;
    this.metrics.paused = this.machine.paused;
    this.metrics.completed = this.machine.completed;
    this.update({ ...this.metrics, gapsMs: [...this.metrics.gapsMs] });
  }
  async poster(edgeId?: string) {
    this.canvas.style.visibility = 'visible';
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = this.url(
      (
        this.pack.manifest.startPoints?.find((s) => s.edgeId === edgeId)?.poster ??
        this.pack.manifest.entryPoster
      ).path,
    );
    await image.decode();
    this.compositor.draw(image, 'opaque-video');
  }
  private async prepare(slot: number, edge: EdgeClip, gen: number) {
    const v = this.slots[slot];
    this.recordDropped(slot);
    this.slotDropped[slot] = 0;
    v.pause();
    v.src = this.url(edge.video.path);
    const loaded = once(v, 'loadeddata');
    v.load();
    await loaded;
    if (gen !== this.generation) return;
    if (
      v.videoWidth !== edge.decodedWidth ||
      v.videoHeight !== edge.decodedHeight ||
      !Number.isFinite(v.duration) ||
      v.duration <= ((edge.outFrameExclusive - 1) * edge.fpsDenominator) / edge.fpsNumerator
    )
      throw new Error('Decoded dimensions or available media duration differ from release');
    // HTMLMediaElement.duration includes audio. The loader already verifies the
    // MP4 video track's exact frame count and CFR; a small AAC tail must not reject
    // a valid clip. Presentation/transition still stops on its verified last frame.
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timeout = setTimeout(() => finish(new Error('First decoded frame timeout')), 10000);
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      v.requestVideoFrameCallback((_now, meta) => {
        const frame = Math.round((meta.mediaTime * edge.fpsNumerator) / edge.fpsDenominator);
        if (frame !== edge.inFrame) return finish(new Error('Preloaded first frame is not approved inFrame'));
        finish();
      });
      v.currentTime = (edge.inFrame * edge.fpsDenominator) / edge.fpsNumerator;
    });
    if (gen !== this.generation) return;
    this.prepared = { slot, edge };
  }
  async start() {
    this.stop();
    this.machine.reset();
    this.metrics = {
      frames: 0,
      transitions: 0,
      stalls: 0,
      droppedFrames: 0,
      maxTransitionGapMs: 0,
      maxFrameGapMs: 0,
      gapsMs: [],
      fault: null,
      edgeId: null,
      frame: -1,
      completed: 0,
      paused: false,
      videoSlots: 2,
      sampledBlankFrames: 0,
      stopped: false,
      finalFrameRecoveries: 0,
      lastRecovery: null,
    };
    this.slotDropped = [0, 0];
    this.lastDraw = 0;
    this.stopped = false;
    this.publish();
    this.canvas.style.opacity = '1';
    const gen = this.generation;
    try {
      const edge = this.machine.begin();
      await this.poster(edge.id);
      await this.prepare(0, edge, gen);
      if (gen !== this.generation) return;
      this.prepared = null;
      this.activate(0, edge, gen);
    } catch (e) {
      if (gen === this.generation) this.fail(String(e));
    }
  }
  private nextChoice(edge: EdgeClip) {
    const projected = { nodeId: edge.to, incomingEdgeId: edge.id };
    const elapsed = this.machine.elapsed + edge.actualDurationSec -
      this.activePrefixFrames * edge.fpsDenominator / edge.fpsNumerator;
    let wanted = this.queued;
    if (this.target) {
      const path = this.machine.graph.path(projected, this.target);
      wanted = path?.[0]?.id ?? null;
      if (projected.nodeId === this.target) this.target = null;
    }
    // Include the current edge's upcoming cooldown when choosing its successor.
    const candidates = this.machine.scheduler.eligible(projected, elapsed, edge);
    if (wanted) {
      const selected = candidates.find((e) => e.id === wanted);
      if (selected) {
        this.queued = null;
        return selected;
      }
    }
    return this.machine.scheduler.choose(projected, elapsed, undefined, edge);
  }
  private activate(slot: number, edge: EdgeClip, gen: number, consumedPrefixFrames = 0) {
    if (this.stopped || gen !== this.generation) return;
    this.activeSlot = slot;
    this.activePrefixFrames = consumedPrefixFrames;
    this.endedFrame = false;
    this.metrics.edgeId = edge.id;
    this.metrics.frame = edge.inFrame + consumedPrefixFrames;
    const v = this.slots[slot];
    if (edge.profile === 'opaque-video') {
      this.slots.forEach((video, index) => {
        video.style.display = index === slot ? 'block' : 'none';
        video.style.opacity = '1';
        video.style.zIndex = '0';
      });
      this.canvas.style.visibility = 'hidden';
    }
    const isCurrent = () =>
      gen === this.generation &&
      !this.stopped &&
      !this.machine.fault &&
      this.activeSlot === slot &&
      this.machine.active?.id === edge.id;
    let recoveryAttempt = 0;
    let recoveryStarted = 0;
    if (edge.profile !== 'opaque-video' || this.auditFrames) {
      this.compositor.draw(v, edge.profile);
      this.audit();
    }
    this.metrics.frames++;
    const activatedAt = performance.now();
    if (this.lastDraw)
      this.metrics.maxFrameGapMs = Math.max(this.metrics.maxFrameGapMs, activatedAt - this.lastDraw);
    this.lastDraw = activatedAt;
    v.volume = this.volume;
    v.muted = this.volume === 0;
    const other = 1 - slot,
      next = this.nextChoice(edge);
    if (!next) {
      this.fail('No approved successor available');
      return;
    }
    const join = this.pack.joins.joins.find(j => j.incomingEdgeId === edge.id && j.outgoingEdgeId === next.id);
    this.prepared = null;
    this.preparing = this.prepare(other, next, gen)
      .then(() => {
        if (gen === this.generation && this.endedFrame && !this.machine.paused)
          this.finishBoundary(edge, gen);
      })
      .catch((e) => {
        if (gen === this.generation) this.fail(String(e));
      });
    const present = (mediaTime: number) => {
      if (!isCurrent() || this.endedFrame) return;
      const f = Math.round((mediaTime * edge.fpsNumerator) / edge.fpsDenominator);
      if (this.retryFinalFrame && f !== edge.outFrameExclusive - 1) {
        this.callbackIds[slot] = v.requestVideoFrameCallback(frame);
        return;
      }
      if (!this.machine.paused) {
        if (join?.method === 'smooth-crossfade' && !this.blend && this.prepared &&
          f >= edge.outFrameExclusive - join.blendFrames && f < edge.outFrameExclusive - 1) {
          this.beginBlend(this.prepared.slot, next, join.blendFrames, gen);
        }
        if (f > edge.outFrameExclusive - 1) {
          this.fail('Missed approved last frame');
          return;
        }
        if (f >= edge.inFrame) {
          if (edge.profile !== 'opaque-video' || this.auditFrames) {
            this.compositor.draw(v, edge.profile);
            this.audit();
          }
          this.metrics.frame = f;
          this.metrics.frames++;
          const drawnAt = performance.now();
          if (this.lastDraw)
            this.metrics.maxFrameGapMs = Math.max(this.metrics.maxFrameGapMs, drawnAt - this.lastDraw);
          this.lastDraw = drawnAt;
          this.recordDropped(slot);
        }
        if (f === edge.outFrameExclusive - 1) {
          if (this.retryFinalFrame && this.metrics.lastRecovery) {
            this.metrics.lastRecovery.result = 'decoded';
            this.metrics.lastRecovery.elapsedMs = performance.now() - recoveryStarted;
          }
          if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
          this.recoveryTimer = null;
          this.retryFinalFrame = null;
          v.pause();
          this.endedFrame = true;
          this.waitStarted = performance.now();
          this.timer = setTimeout(
            () => {
              this.timer = null;
              this.finishBoundary(edge, gen);
            },
            (1000 * edge.fpsDenominator) / edge.fpsNumerator,
          );
          this.publish();
          return;
        }
      }
      this.callbackIds[slot] = v.requestVideoFrameCallback(frame);
      if (this.metrics.frames % 15 === 0) this.publish();
    };
    const frame = (_now: number, meta: VideoFrameCallbackMetadata) => present(meta.mediaTime);
    this.callbackIds[slot] = v.requestVideoFrameCallback(frame);
    v.onended = () => {
      if (!isCurrent() || this.endedFrame || this.recoveryTimer) return;
      // Chromium may skip the last rVFC under contention, or dispatch ended first.
      // Decode that exact media frame again; never commit from ended alone.
      this.metrics.finalFrameRecoveries++;
      this.metrics.lastRecovery = {
        edgeId: edge.id,
        priorFrame: this.metrics.frame,
        mediaTime: v.currentTime,
        elapsedMs: 0,
        result: 'decoding',
      };
      v.pause();
      // rVFC is best-effort. At EOS the decoder may already hold the exact final
      // frame even if its compositor callback was omitted. VideoFrame(video)
      // retains that decoded frame's native PTS; never override the timestamp
      // or substitute currentTime/duration as proof of the approved endpoint.
      recoveryStarted=performance.now();
      if(typeof VideoFrame!=='undefined'&&v.readyState>=2){
        let decoded:VideoFrame|null=null;
        try{
          decoded=new VideoFrame(v);
          const pts=decoded.timestamp/1e6;
          if(Math.round(pts*edge.fpsNumerator/edge.fpsDenominator)===edge.outFrameExclusive-1){
            this.metrics.lastRecovery!.method='decoded-snapshot';
            this.metrics.lastRecovery!.decodedMediaTime=pts;
            this.metrics.lastRecovery!.result='decoded';
            this.metrics.lastRecovery!.elapsedMs=performance.now()-recoveryStarted;
            v.cancelVideoFrameCallback(this.callbackIds[slot]);
            present(pts);
            return;
          }
        }catch{ /* An unavailable decoded surface falls back to explicit decode. */ }
        finally{decoded?.close();}
      }
      this.metrics.lastRecovery!.method='reload';
      this.retryFinalFrame = () => {
        if (!isCurrent() || this.machine.paused) return;
        const attempt = ++recoveryAttempt;
        recoveryStarted = performance.now();
        v.cancelVideoFrameCallback(this.callbackIds[slot]);
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          if (isCurrent() && !this.endedFrame)
            this.fail('Approved final frame could not be decoded within 500ms');
        }, 500);
        const seek = () => {
          if (!isCurrent() || this.machine.paused || attempt !== recoveryAttempt) return;
          this.callbackIds[slot] = v.requestVideoFrameCallback(frame);
          v.currentTime = ((edge.outFrameExclusive - 1 + 0.1) * edge.fpsDenominator) / edge.fpsNumerator;
          // A paused, nearly covered video can finish seeking without submitting
          // another compositor callback. Play this exact final frame; `frame`
          // still verifies its decoded PTS and pauses it before committing.
          void v.play().catch((e)=>{
            if(isCurrent()&&!this.machine.paused&&attempt===recoveryAttempt)this.fail(String(e));
          });
        };
        // Seeking within the cached final frame need not submit a new rVFC.
        // Reload even on the first recovery to require a new decode submission.
        this.recordDropped(slot);
        this.slotDropped[slot] = 0;
        const loaded = once(v, 'loadeddata', 500);
        v.load();
        void loaded.then(seek).catch((e) => {
          if (isCurrent() && !this.machine.paused && attempt === recoveryAttempt) this.fail(String(e));
        });
      };
      this.retryFinalFrame();
      this.publish();
    };
    if (!this.machine.paused) {
      void v.play().catch((e) => this.fail(String(e)));
      if (this.ambient) {
        this.ambient.volume = this.volume;
        void this.ambient.play().catch(() => {});
      }
    }
    this.publish();
  }
  private finishBoundary(edge: EdgeClip, gen: number) {
    if (this.stopped || gen !== this.generation || this.machine.paused || !this.endedFrame || this.timer)
      return;
    const elapsed = performance.now() - this.waitStarted,
      frameMs = (1000 * edge.fpsDenominator) / edge.fpsNumerator;
    if (elapsed < frameMs - 1) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.finishBoundary(edge, gen);
      }, frameMs - elapsed);
      return;
    }
    if (!this.prepared) {
      if (elapsed > 500) {
        this.fail('Transition stall > 500ms; overlay hidden and playback paused');
        return;
      }
      if (this.metrics.stalls === 0 || elapsed < frameMs * 2) this.metrics.stalls++;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.finishBoundary(edge, gen);
      }, 16);
      return;
    }
    const join = this.pack.joins.joins.find(j => j.incomingEdgeId === edge.id && j.outgoingEdgeId === this.prepared!.edge.id);
    if (join?.method === 'smooth-crossfade') {
      // A late preload must not silently turn an approved blend into a hard cut.
      if (!this.blend) {
        this.fail('Successor was not ready for the approved crossfade');
        return;
      }
      const consumed = (this.slots[this.blend.slot].currentTime * edge.fpsNumerator / edge.fpsDenominator) - this.blend.edge.inFrame;
      if (consumed < this.blend.frames - 0.1) {
        if (elapsed > 500) { this.fail('Crossfade successor stalled > 500ms'); return; }
        this.timer = setTimeout(() => { this.timer = null; this.finishBoundary(edge, gen); }, 8);
        return;
      }
    }
    const next = this.prepared;
    this.prepared = null;
    const consumedPrefix = this.blend?.frames ?? 0;
    cancelAnimationFrame(this.blendAnimation);
    this.blend = null;
    this.machine.presentedLastFrame(edge.id, edge.outFrameExclusive - 1, this.activePrefixFrames);
    this.machine.begin(next.edge.id);
    const gap = performance.now() - this.lastDraw;
    this.metrics.maxTransitionGapMs = Math.max(this.metrics.maxTransitionGapMs, gap);
    this.metrics.gapsMs.push(gap);
    if (this.metrics.gapsMs.length > 1000) this.metrics.gapsMs.shift();
    this.metrics.transitions++;
    this.activate(next.slot, next.edge, gen, consumedPrefix);
  }
  private beginBlend(slot: number, edge: EdgeClip, frames: number, gen: number) {
    const v = this.slots[slot];
    this.blend = { slot, frames, edge, weight: 0 };
    v.style.display = 'block';
    v.style.zIndex = '1';
    v.style.opacity = '0';
    v.volume = 0;
    v.muted = this.volume === 0;
    const animate = () => {
      if (!this.blend || gen !== this.generation || this.stopped) return;
      if (!this.machine.paused) {
        const elapsedFrames = v.currentTime * edge.fpsNumerator / edge.fpsDenominator - edge.inFrame;
        this.blend.weight = blendWeight(elapsedFrames, frames);
        this.applyBlend();
      }
      this.blendAnimation = requestAnimationFrame(animate);
    };
    this.blendAnimation = requestAnimationFrame(animate);
    void v.play().catch(e => { if (gen === this.generation && !this.stopped) this.fail(String(e)); });
  }
  private applyBlend() {
    if (!this.blend) return;
    const incoming = this.slots[this.blend.slot], outgoing = this.slots[this.activeSlot];
    // Keep the outgoing surface composited until its final rVFC arrives.
    // A fully opaque incoming layer can make WebView2 cull that last callback,
    // even though the decoder reached EOS (especially with 4K overlays).
    incoming.style.opacity = String(this.endedFrame ? this.blend.weight : Math.min(this.blend.weight, 0.99));
    incoming.volume = this.volume * this.blend.weight;
    outgoing.volume = this.volume * (1 - this.blend.weight);
  }
  pause() {
    if (this.stopped) return;
    this.machine.paused = true;
    for (const v of this.slots) v.pause();
    this.ambient?.pause();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.publish();
  }
  resume() {
    if (this.stopped || this.machine.fault) return;
    this.machine.paused = false;
    // User pause time is not a decode/presentation stall.
    this.lastDraw = performance.now();
    if (this.endedFrame && this.machine.active) {
      this.waitStarted = performance.now();
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.finishBoundary(this.machine.active!, this.generation);
        },
        (1000 * this.machine.active.fpsDenominator) / this.machine.active.fpsNumerator,
      );
    } else if (this.retryFinalFrame) this.retryFinalFrame();
    else void this.slots[this.activeSlot].play().catch((e) => this.fail(String(e)));
    if (this.blend) void this.slots[this.blend.slot].play().catch(e => this.fail(String(e)));
    if (this.ambient) void this.ambient.play().catch(() => {});
    this.publish();
  }
  hide() {
    this.pause();
    this.canvas.style.opacity = '0';
    for (const v of this.slots) v.style.opacity = '0';
  }
  show() {
    this.canvas.style.opacity = '1';
    for (const v of this.slots) v.style.opacity = '1';
    this.applyBlend();
  }
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    for (const slot of this.slots) {
      slot.volume = this.volume;
      slot.muted = this.volume === 0;
    }
    if (this.ambient) this.ambient.volume = this.volume;
    this.applyBlend();
  }
  requestNode(node: string) {
    this.machine.graph.path(this.machine.cursor, node);
    this.target = node;
  }
  queueEdge(edgeId: string) {
    const active = this.machine.active,
      cursor = active ? { nodeId: active.to, incomingEdgeId: active.id } : this.machine.cursor;
    if (!this.machine.graph.next(cursor).some((e) => e.id === edgeId))
      throw new Error('Edge is not an approved successor');
    this.queued = edgeId;
  }
  private fail(reason: string) {
    if (this.stopped) return;
    if (this.metrics.lastRecovery?.result === 'decoding') this.metrics.lastRecovery.result = 'failed';
    this.pause();
    this.machine.fault = reason;
    this.metrics.fault = reason;
    this.canvas.style.transition = 'opacity 120ms';
    this.canvas.style.opacity = '0';
    for (const v of this.slots) v.style.opacity = '0';
    this.publish();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    cancelAnimationFrame(this.blendAnimation);
    this.blend = null;
    this.activePrefixFrames = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.retryFinalFrame = null;
    this.prepared = null;
    this.preparing = null;
    this.endedFrame = false;
    this.queued = null;
    this.target = null;
    this.slots.forEach((v, i) => {
      v.style.display = 'none';
      v.cancelVideoFrameCallback(this.callbackIds[i]);
      v.onended = null;
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
    this.ambient?.pause();
    if (this.ambient) this.ambient.currentTime = 0;
    this.machine.active = null;
    this.metrics.edgeId = null;
    this.publish();
  }
  dispose() {
    this.stop();
    for (const v of this.slots) v.remove();
    this.compositor.clear();
    this.compositor.dispose();
  }
}
