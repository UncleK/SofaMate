/// <reference types="vite/client" />
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { VideoPlayer } from '../../src/renderer/player';
import { LoopPlayer } from './loop-player';
import { validateRelease } from '../../src/core/validate';
import '../../src/renderer/client.css';
import './ui.css';
const call = (action: string, value?: unknown) => invoke<any>('call', { action, value: value ?? null });
const root = document.getElementById('app')!;
const wallpaper = new URLSearchParams(location.search).has('wallpaper');
if (wallpaper) {
  document.body.className = 'wallpaper';
  root.innerHTML = '<canvas></canvas><div id="scope"></div>';
  let canvas = root.querySelector('canvas')!;
  let player: VideoPlayer | LoopPlayer | null = null;
  let volume = 0;
  let chain = Promise.resolve();
  let currentScope = '';
  let lastPublish = 0;
  let lastTransitions = -1;
  let lastPaused: boolean | undefined;
  let lastStopped: boolean | undefined;
  let epoch = 0;
  let identity: any = {};
  function publish(metrics: any) {
    const value = { ...metrics, ...identity, volume, loading: false };
    (window as any).screenmateMetrics = value;
    void call('playback-state', value);
  }
  async function load(p: any) {
    const generation = ++epoch;
    identity = { selectionId: p.selectionId, playbackId: p.playbackId, monitorId:p.monitorId };
    volume = p.volume ?? 0;
    document.body.dataset.fit = p.fit === 'contain' ? 'contain' : 'cover';
    player?.dispose();
    player = null;
    currentScope = p.scope;
    const fresh = document.createElement('canvas');
    canvas.replaceWith(fresh);
    canvas = fresh;
    if (p.kind === 'empty') {
      root.querySelector('#scope')!.textContent = '';
      publish({ paused: true, stopped: true, fault: null });
      return;
    }
    root.querySelector('#scope')!.textContent =
      p.scope === 'technical-fixture' ? '4K 双路转场技术试验 · 非正式接缝' : '';
    if (p.kind === 'video') {
      player = new LoopPlayer(canvas, p.url, p.label, (m) => {
        if (generation === epoch) publish(m);
      });
      player.setVolume(volume);
      await player.start();
      return;
    }
    validateRelease(p.data);
    player = new VideoPlayer(
      p.data,
      canvas,
      (rel) => p.baseUrl + rel,
      (metrics) => {
        if (generation !== epoch) return;
        (window as any).screenmateMetrics = { ...metrics, ...identity, volume };
        if (
          performance.now() - lastPublish > 900 ||
          metrics.paused !== lastPaused || metrics.stopped !== lastStopped ||
          metrics.transitions !== lastTransitions ||
          metrics.fault
        ) {
          lastPublish = performance.now();
          lastTransitions = metrics.transitions;
          lastPaused = metrics.paused;
          lastStopped = metrics.stopped;
          publish({
            ...metrics,
            scope: currentScope,
            visibility: document.visibilityState,
            userAgent: navigator.userAgent,
            videos: Array.from(document.querySelectorAll('video')).map((v) => {
              const q = v.getVideoPlaybackQuality();
              return {
                width: v.videoWidth,
                height: v.videoHeight,
                time: v.currentTime,
                paused: v.paused,
                muted: v.muted,
                volume: v.volume,
                opacity: v.style.opacity,
                display: v.style.display,
                quality: { totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames },
              };
            }),
          });
        }
      },
    );
    player.setVolume(volume);
    await player.start();
  }
  await getCurrentWebviewWindow().listen<any>('trial-command', ({ payload: c }) => {
    chain = chain
      .then(async () => {
        if (c.action === 'load') await load(c.payload);
        else if(c.action === 'fit') document.body.dataset.fit = c.payload === 'contain' ? 'contain' : 'cover';
        else if (c.action === 'start') {
          player?.show();
          await player?.start();
        } else if (c.action === 'pause') player?.pause();
        else if (c.action === 'resume') {
          player?.show();
          player?.resume();
        } else if (c.action === 'hide') player?.hide();
        else if (c.action === 'stop') {
          ++epoch;
          player?.dispose();
          player = null;
        } else if (c.action === 'volume') {
          volume = c.payload;
          player?.setVolume(volume);
          publish((window as any).screenmateMetrics ?? {});
        }
      })
      .catch((e) => publish({ fault: String(e), paused: true }));
  });
  try {
    await load(await call('current'));
  } catch (e) {
    root.querySelector('#scope')!.textContent = String(e);
    publish({ fault: String(e), paused: true });
  }
  // Dev probe uses the same controls as tray/UI; no additional native privilege.
  (window as any).trial = {
    call,
    sample: () => ({
      metrics: (window as any).screenmateMetrics,
      videos: Array.from(document.querySelectorAll('video')).map((v) => ({
        time: v.currentTime,
        width: v.videoWidth,
        height: v.videoHeight,
        paused: v.paused,
        muted: v.muted,
        opacity: v.style.opacity,
        display: v.style.display,
      })),
    }),
  };
} else {
  const { mountPlatform } = await import('./platform-controls');
  await mountPlatform(root, call);
}
