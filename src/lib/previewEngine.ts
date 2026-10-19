import { audioGainAt, type Flat, flatten, videoOpacityAt } from '../../shared/flatten.ts';
import { type Project, projectDuration, US_PER_S, type Us } from '../../shared/model.ts';
import type { Placement } from '../../shared/transform.ts';
import { mediaUrl } from './api.ts';
import { playhead } from './playhead.ts';

// Real-time preview with plain media elements, driven by the same flattened
// project the exporter uses (shared/flatten.ts):
// - one <video> per visible piece, stacked in layer order and placed by its
//   position / scale / crop; a Mix is a live opacity fade of the incoming piece
//   (the exporter fades alpha the same way);
// - the next piece is loaded and seeked shortly before it starts;
// - sounds play through the video element that decodes the same file range,
//   or through their own <audio> element;
// - Web Audio gain nodes apply volume (above 0 dB too) and every fade.

interface Voice {
  el: HTMLMediaElement;
  mediaId: string;
  gain: GainNode | null;
  lastUsed: number;
}

const MAX_IDLE = 6;
const PRELOAD_US = 1.5 * US_PER_S;

export class PreviewEngine {
  private videos = new Map<string, Voice & { el: HTMLVideoElement }>();
  private sounds = new Map<string, Voice>();
  private ctx: AudioContext | null = null;
  private project: Project | null = null;
  private flat: Flat = { video: [], audio: [] };
  private raf = 0;
  private startWall = 0;
  private startT = 0;
  playing = false;
  onPlayingChange: (playing: boolean) => void = () => {};

  constructor(private container: HTMLElement) {}

  destroy() {
    cancelAnimationFrame(this.raf);
    for (const v of [...this.videos.values(), ...this.sounds.values()]) {
      v.el.pause();
      v.el.removeAttribute('src');
      v.el.remove();
    }
    this.videos.clear();
    this.sounds.clear();
    void this.ctx?.close();
  }

  setProject(p: Project) {
    this.project = p;
    this.flat = flatten(p);
    if (!this.playing) this.sync(playhead.get(), false);
  }

  private ensureAudioGraph() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    for (const v of [...this.videos.values(), ...this.sounds.values()]) v.gain = this.connect(v.el);
  }

  private connect(el: HTMLMediaElement): GainNode | null {
    if (!this.ctx) return null;
    const node = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    node.connect(gain).connect(this.ctx.destination);
    el.volume = 1;
    return gain;
  }

  private setGain(v: Voice, value: number) {
    if (v.gain && this.ctx) v.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
    else v.el.volume = Math.min(1, Math.max(0, value));
  }

  play() {
    if (!this.project || this.playing) return;
    this.ensureAudioGraph();
    void this.ctx?.resume();
    const end = projectDuration(this.project);
    if (end <= 0) return;
    if (playhead.get() >= end - 10_000) playhead.set(0);
    this.playing = true;
    this.startT = playhead.get();
    this.startWall = performance.now();
    this.onPlayingChange(true);
    const tick = () => {
      if (!this.playing || !this.project) return;
      const t = this.startT + (performance.now() - this.startWall) * 1000;
      const stopAt = projectDuration(this.project);
      if (t >= stopAt) {
        playhead.set(stopAt);
        this.pause();
        return;
      }
      playhead.set(t);
      this.sync(t, true);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.sync(playhead.get(), false);
    this.onPlayingChange(false);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  private videoFor(key: string, mediaId: string, now: number) {
    let v = this.videos.get(key);
    if (!v || v.mediaId !== mediaId) {
      v?.el.remove();
      const el = document.createElement('video');
      el.playsInline = true;
      el.preload = 'auto';
      el.className = 'preview-slot';
      el.style.opacity = '0';
      el.src = mediaUrl(mediaId);
      this.container.appendChild(el);
      v = { el, mediaId, gain: this.connect(el), lastUsed: now };
      this.videos.set(key, v);
    }
    v.lastUsed = now;
    return v;
  }

  /** Bring every media element in line with timeline time t. */
  sync(t: Us, playing: boolean) {
    if (!this.project) return;
    const tolerance = playing ? 0.3 : 1 / 60;
    const now = performance.now();
    const keepVideo = new Set<string>();
    const activeVideo = new Set<string>();

    // ---- Picture: active pieces in layer order; upcoming pieces preloaded.
    this.flat.video.forEach((piece, z) => {
      const active = t >= piece.start_us && t < piece.start_us + piece.duration_us;
      const upcoming = playing && piece.start_us > t && piece.start_us - t < PRELOAD_US;
      if (!active && !upcoming) return;
      keepVideo.add(piece.key);
      const v = this.videoFor(piece.key, piece.media, now);
      place(v.el, piece.place);
      const target = (piece.src_start_us + Math.max(0, t - piece.start_us)) / US_PER_S;
      if (!active) {
        v.el.style.opacity = '0';
        if (!v.el.paused) v.el.pause();
        if (Math.abs(v.el.currentTime - target) > 0.05) v.el.currentTime = target;
        return;
      }
      activeVideo.add(piece.key);
      v.el.style.display = '';
      v.el.style.zIndex = String(z + 1);
      v.el.style.opacity = String(videoOpacityAt(piece, t));
      if (Math.abs(v.el.currentTime - target) > tolerance) v.el.currentTime = target;
      if (playing && v.el.paused) void v.el.play().catch(() => {});
      if (!playing && !v.el.paused) v.el.pause();
    });

    // ---- Sound: through the matching video element, or an <audio> of its own.
    const videoGain = new Map<string, number>();
    const keepSound = new Set<string>();
    for (const a of this.flat.audio) {
      if (t < a.start_us || t >= a.start_us + a.duration_us) continue;
      const g = audioGainAt(a, t);
      if (a.videoKey && activeVideo.has(a.videoKey)) {
        videoGain.set(a.videoKey, (videoGain.get(a.videoKey) ?? 0) + g);
        continue;
      }
      keepSound.add(a.key);
      let s = this.sounds.get(a.key);
      if (!s || s.mediaId !== a.media) {
        s?.el.pause();
        const el = new Audio(mediaUrl(a.media));
        el.preload = 'auto';
        s = { el, mediaId: a.media, gain: this.connect(el), lastUsed: now };
        this.sounds.set(a.key, s);
      }
      s.lastUsed = now;
      const target = (a.src_start_us + (t - a.start_us)) / US_PER_S;
      if (Math.abs(s.el.currentTime - target) > tolerance) s.el.currentTime = target;
      if (playing && s.el.paused) void s.el.play().catch(() => {});
      if (!playing && !s.el.paused) s.el.pause();
      this.setGain(s, g);
    }

    for (const [key, v] of this.videos) {
      this.setGain(v, videoGain.get(key) ?? 0);
      if (keepVideo.has(key)) continue;
      v.el.style.opacity = '0';
      v.el.style.display = 'none';
      if (!v.el.paused) v.el.pause();
    }
    for (const [key, s] of this.sounds) {
      if (keepSound.has(key)) continue;
      if (!s.el.paused) s.el.pause();
      this.setGain(s, 0);
    }
    this.prune(this.videos, keepVideo, true);
    this.prune(this.sounds, keepSound, false);
  }

  /** Drop the oldest idle elements. */
  private prune(map: Map<string, Voice>, keep: Set<string>, remove: boolean) {
    const idle = [...map.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (idle.length > MAX_IDLE) {
      const [key, v] = idle.shift()!;
      v.gain?.disconnect();
      v.el.removeAttribute('src');
      if (remove) v.el.remove();
      map.delete(key);
    }
  }
}

const pct = (n: number) => `${(n * 100).toFixed(4)}%`;

/** Frame box in stage percentages; the crop is a clip-path inside it. */
function place(el: HTMLElement, { frame, view }: Placement) {
  const key = `${frame.x},${frame.y},${frame.w},${frame.h},${view.x},${view.y},${view.w},${view.h}`;
  if (el.dataset.place === key) return;
  el.dataset.place = key;
  Object.assign(el.style, { left: pct(frame.x), top: pct(frame.y), right: 'auto', bottom: 'auto', width: pct(frame.w), height: pct(frame.h), objectFit: 'fill' });
  const t = (view.y - frame.y) / frame.h;
  const r = (frame.x + frame.w - view.x - view.w) / frame.w;
  const b = (frame.y + frame.h - view.y - view.h) / frame.h;
  const l = (view.x - frame.x) / frame.w;
  el.style.clipPath = t > 1e-6 || r > 1e-6 || b > 1e-6 || l > 1e-6 ? `inset(${pct(t)} ${pct(r)} ${pct(b)} ${pct(l)})` : '';
}
