// Flatten a project (or the inside of a compound clip) into what is actually
// seen and heard: a stack of video layers and a list of sounds, all in
// absolute timeline time. The preview and the exporter both read this, so
// they always agree.
//
// - Main track first (bottom), then secondary video tracks upwards; within a
//   track, later clips sit above earlier ones (a Mix fades the later one in).
// - Compound clips are expanded recursively and cut to the part of their
//   content the outer clip shows.
// - Hidden tracks add no video; muted tracks add no sound.

import { type Clip, clipEnd, dbToGain, type Project, type Track, type Us } from './model.ts';
import { composePlacement, fitSize, type Placement, placement, type Transform } from './transform.ts';

/** Gain ramp: rises over `fin` from `a`, falls over `fout` until `b` (absolute times). */
export interface Envelope {
  a: Us;
  b: Us;
  fin: Us;
  fout: Us;
}

export interface FlatVideo {
  /** Unique per visible piece (clip path through compounds). */
  key: string;
  media: string;
  src_start_us: Us;
  start_us: Us;
  duration_us: Us;
  /** Mix: opacity rises from 0 to 1 over this span (absolute time). */
  alpha?: { start_us: Us; dur_us: Us };
  /** Where the picture sits on the canvas, after its own and its compounds' transforms. */
  place: Placement;
}

export interface FlatAudio {
  key: string;
  media: string;
  src_start_us: Us;
  start_us: Us;
  duration_us: Us;
  gain_db: number;
  envelopes: Envelope[];
  /** The video piece that decodes the same file range (embedded or separated audio). */
  videoKey?: string;
}

export interface Flat {
  video: FlatVideo[];
  audio: FlatAudio[];
}

interface Ctx {
  offset: Us;
  w0: Us;
  w1: Us;
  gain_db: number;
  envelopes: Envelope[];
  alpha?: { start_us: Us; dur_us: Us };
  muted: boolean;
  hidden: boolean;
  /** Transforms of the enclosing compound clips, innermost first. */
  chain: (Transform | undefined)[];
  path: string;
  depth: number;
}

const MAX_DEPTH = 8;

function edges(tracks: Track[], videoClipId: string): { in_us: Us; out_us: Us } {
  const main = tracks.find((t) => t.main);
  const i = main ? main.clips.findIndex((c) => c.id === videoClipId) : -1;
  if (!main || i < 0) return { in_us: 0, out_us: 0 };
  return { in_us: i > 0 ? main.clips[i - 1].transition_out?.duration_us ?? 0 : 0, out_us: main.clips[i].transition_out?.duration_us ?? 0 };
}

export function flatten(p: Project): Flat {
  const out: Flat = { video: [], audio: [] };
  const videoKeys = new Set<string>();

  const walk = (tracks: Track[], ctx: Ctx) => {
    if (ctx.depth > MAX_DEPTH) return;
    const toOuter = (t: Us) => t + ctx.offset;
    const visible = (c: Clip) => {
      const v0 = Math.max(c.timeline_start_us, ctx.w0);
      const v1 = Math.min(clipEnd(c), ctx.w1);
      return v1 > v0 ? { v0, v1, cut: v0 - c.timeline_start_us } : null;
    };

    const emitClip = (c: Clip, track: Track, kindOfTrack: 'video' | 'audio') => {
      const vis = visible(c);
      if (!vis) return;
      const media = p.media[c.media];
      if (!media) return;
      const hidden = ctx.hidden || Boolean(track.hidden);
      const muted = ctx.muted || Boolean(track.muted);
      const e = edges(tracks, c.linked_to ?? c.id);
      const env: Envelope = { a: toOuter(c.timeline_start_us), b: toOuter(clipEnd(c)), fin: Math.max(c.fade_in_us, e.in_us), fout: Math.max(c.fade_out_us, e.out_us) };
      const ownAlpha = kindOfTrack === 'video' && track.main && e.in_us > 0 ? { start_us: toOuter(c.timeline_start_us), dur_us: e.in_us } : undefined;
      const alpha = ownAlpha ?? ctx.alpha;
      const key = `${ctx.path}${c.id}`;

      if (media.kind === 'compound') {
        const data = p.compounds?.[media.id];
        if (!data) return;
        walk(data.tracks, {
          offset: ctx.offset + c.timeline_start_us - c.source.start_us,
          w0: c.source.start_us + vis.cut,
          w1: c.source.start_us + vis.cut + (vis.v1 - vis.v0),
          gain_db: ctx.gain_db + c.gain_db,
          envelopes: [...ctx.envelopes, env],
          alpha,
          muted,
          hidden: hidden || kindOfTrack === 'audio',
          chain: [c.transform, ...ctx.chain],
          path: `${key}/`,
          depth: ctx.depth + 1,
        });
        return;
      }

      const piece = { media: c.media, src_start_us: c.source.start_us + vis.cut, start_us: toOuter(vis.v0), duration_us: vis.v1 - vis.v0 };
      if (kindOfTrack === 'video' && media.has_video && !hidden) {
        const place = ctx.chain.reduce((pl, t) => composePlacement(pl, t), placement(c.transform, fitSize(media.width, media.height)));
        if (place.view.w > 0 && place.view.h > 0) {
          out.video.push({ key, ...piece, alpha, place });
          videoKeys.add(key);
        }
      }
      const sounds = kindOfTrack === 'audio' ? media.has_audio : media.has_audio && !c.audio_detached;
      if (sounds && !muted) {
        const videoKey = kindOfTrack === 'video' ? key : c.linked_to ? `${ctx.path}${c.linked_to}` : undefined;
        out.audio.push({ key: kindOfTrack === 'video' ? `${key}#a` : key, ...piece, gain_db: ctx.gain_db + c.gain_db, envelopes: [...ctx.envelopes, env], videoKey });
      }
    };

    const main = tracks.find((t) => t.main);
    const videoOrder = [...(main ? [main] : []), ...tracks.filter((t) => t.kind === 'video' && !t.main).reverse()];
    for (const track of videoOrder) for (const c of [...track.clips].sort((a, b) => a.timeline_start_us - b.timeline_start_us)) emitClip(c, track, 'video');
    for (const track of tracks.filter((t) => t.kind === 'audio')) for (const c of track.clips) emitClip(c, track, 'audio');
  };

  walk(p.tracks, { offset: 0, w0: 0, w1: Number.MAX_SAFE_INTEGER, gain_db: 0, envelopes: [], muted: false, hidden: false, chain: [], path: '', depth: 0 });
  // A separated audio only shares a decoder with its video if that video piece exists (not hidden).
  for (const a of out.audio) if (a.videoKey && !videoKeys.has(a.videoKey)) a.videoKey = undefined;
  return out;
}

/** Linear gain of a sound at absolute time t (volume × every fade around it). */
export function audioGainAt(a: FlatAudio, t: Us): number {
  if (t < a.start_us || t > a.start_us + a.duration_us) return 0;
  let g = dbToGain(a.gain_db);
  for (const e of a.envelopes) {
    if (t < e.a || t > e.b) return 0;
    if (e.fin > 0) g *= Math.min(1, (t - e.a) / e.fin);
    if (e.fout > 0) g *= Math.min(1, (e.b - t) / e.fout);
  }
  return g;
}

export function videoOpacityAt(v: FlatVideo, t: Us): number {
  if (!v.alpha || v.alpha.dur_us <= 0) return 1;
  return Math.min(1, Math.max(0, (t - v.alpha.start_us) / v.alpha.dur_us));
}
