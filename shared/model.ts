// MyEditor project model. All times are integer microseconds (µs).
//
// Tracks, top to bottom (display order of `project.tracks`):
//   secondary video tracks (overlays, free positioning, drawn above the main track)
//   the main track (video, magnetic: no gaps)
//   audio tracks (free positioning)
//
// Compound clips are clips whose medium has kind 'compound'; their content lives in
// project.compounds[id].tracks, with the same track rules.

import type { Derived } from './pro.ts';
import type { Transform } from './transform.ts';

export type Us = number;

export const US_PER_S = 1_000_000;
export const SCHEMA_VERSION = 3;
export const MIN_CLIP_US = 100_000;
export const MIN_TRANSITION_US = 100_000;
export const MAX_TRANSITION_US = 3_000_000;
export const DEFAULT_TRANSITION_US = 500_000;
export const MIN_GAIN_DB = -60;
/** +12.04 dB = 400 % */
export const MAX_GAIN_DB = 20 * Math.log10(4);
export const MAX_VOLUME_PERCENT = 400;

export interface TimeRange {
  start_us: Us;
  duration_us: Us;
}

export interface MediaInfo {
  /** Content hash prefix; re-importing the same file yields the same id. */
  id: string;
  /** 'compound' = a compound clip whose content is project.compounds[id]. Default: a file. */
  kind?: 'file' | 'compound';
  name: string;
  /** File name inside the server workspace (media/<id>.<ext>). */
  file: string;
  duration_us: Us;
  has_video: boolean;
  has_audio: boolean;
  width: number;
  height: number;
  /** Mejoras Pro result: which original range it was made from (shared/pro.ts). */
  derived?: Derived;
}

export interface Transition {
  type: 'mix';
  duration_us: Us;
}

export interface Clip {
  id: string;
  media: string;
  source: TimeRange;
  timeline_start_us: Us;
  gain_db: number;
  fade_in_us: Us;
  fade_out_us: Us;
  /** Video clips: the embedded audio was moved to an audio track. */
  audio_detached?: boolean;
  /** Audio clips: id of the video clip this audio was separated from (follows it in time). */
  linked_to?: string;
  /** Main-track clips: crossfade into the next clip. */
  transition_out?: Transition | null;
  /** Clips sharing a group id are selected and moved together. */
  group_id?: string;
  /** Video clips: position, scale and crop on the canvas (shared/transform.ts). Absent = fitted, centered. */
  transform?: Transform;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  /** The one magnetic video track. */
  main?: boolean;
  /** Locked: its clips can't be selected, moved, trimmed or deleted, and ripple doesn't move them. */
  locked?: boolean;
  /** Video tracks: hidden in preview and export. */
  hidden?: boolean;
  /** Silenced in preview and export; clip volumes are kept. */
  muted?: boolean;
  /** Main track inside a compound: where its first clip starts (the root main track starts at 0). */
  offset_us?: Us;
  clips: Clip[];
}

export interface CompoundData {
  tracks: Track[];
}

export interface Project {
  schema_version: number;
  app: 'MyEditor';
  id: string;
  name: string;
  time_unit: 'us';
  fps: { num: number; den: number };
  media: Record<string, MediaInfo>;
  tracks: Track[];
  /** Export range set with I / O. null = from the start / to the end. */
  range: { in_us: Us | null; out_us: Us | null };
  /** Content of compound clips, keyed by their medium id. */
  compounds?: Record<string, CompoundData>;
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function createProject(name = 'Proyecto sin título'): Project {
  return {
    schema_version: SCHEMA_VERSION,
    app: 'MyEditor',
    id: newId(),
    name,
    time_unit: 'us',
    fps: { num: 30, den: 1 },
    media: {},
    tracks: [
      { id: 'main', kind: 'video', main: true, clips: [] },
      { id: newId(), kind: 'audio', clips: [] },
    ],
    range: { in_us: null, out_us: null },
  };
}

// ---- Track helpers
export const mainTrack = (p: Project): Track => p.tracks.find((t) => t.main)!;
/** @deprecated name kept for older call sites: the main (magnetic) video track. */
export const videoTrack = mainTrack;
export const videoTracks = (p: Project) => p.tracks.filter((t) => t.kind === 'video');
export const audioTracks = (p: Project) => p.tracks.filter((t) => t.kind === 'audio');
export const overlayTracks = (p: Project) => p.tracks.filter((t) => t.kind === 'video' && !t.main);
export const allClips = (p: Project) => p.tracks.flatMap((t) => t.clips);
export const isCompoundMedia = (p: Project, mediaId: string) => p.media[mediaId]?.kind === 'compound';

/** A clip can't be edited when its track, or the track of its linked partner, is locked. */
export function clipLocked(p: Project, clipId: string): boolean {
  const found = findClip(p, clipId);
  if (!found) return false;
  if (found.track.locked) return true;
  const partnerIds = new Set([found.clip.linked_to, ...allClips(p).filter((c) => c.linked_to === clipId).map((c) => c.id)]);
  return p.tracks.some((t) => t.locked && t.clips.some((c) => partnerIds.has(c.id)));
}

export const clipEnd = (c: Clip): Us => c.timeline_start_us + c.source.duration_us;

export function frameUs(p: Project): number {
  return (US_PER_S * p.fps.den) / p.fps.num;
}

/** Round a time to the nearest frame boundary. */
export function snapToFrame(p: Project, t: Us): Us {
  const f = frameUs(p);
  return Math.round(Math.round(t / f) * f);
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

/** Track label shown in the timeline header. */
export function trackLabel(p: Project, track: Track): string {
  if (track.main) return 'Principal';
  const list = track.kind === 'video' ? [...overlayTracks(p)].reverse() : audioTracks(p);
  return `${track.kind === 'video' ? 'Vídeo' : 'Audio'} ${list.findIndex((t) => t.id === track.id) + (track.kind === 'video' ? 2 : 1)}`;
}

/** Longest transition allowed between two neighbours so both can also hold their other transition. */
export function maxTransitionUs(a: Clip, b: Clip): Us {
  return Math.max(0, Math.min(MAX_TRANSITION_US, Math.floor(Math.min(a.source.duration_us, b.source.duration_us) / 2)));
}

/**
 * Recompute derived fields after every edit:
 * - track order: secondary video tracks, main track, audio tracks (at least one);
 * - the main track is magnetic: clip i starts where clip i-1 ends, minus its Mix overlap;
 * - secondary tracks keep their own positions (no ripple);
 * - separated audio clips mirror their video clip's source range and position;
 * - transitions, fades and gain are clamped to valid values.
 */
export function normalize(p: Project): Project {
  let main = p.tracks.find((t) => t.main && t.kind === 'video');
  if (!main) main = { id: 'main', kind: 'video', main: true, clips: [] };
  const overlays = p.tracks.filter((t) => t.kind === 'video' && t !== main).map((t) => ({ ...t, main: undefined }));
  let audios = p.tracks.filter((t) => t.kind === 'audio');
  if (!audios.length) audios = [{ id: newId(), kind: 'audio', clips: [] }];

  // Keep every source range inside its medium (a compound can get shorter).
  const fitSource = (c: Clip): Clip => {
    const dur = p.media[c.media]?.duration_us;
    if (!dur || c.source.start_us + c.source.duration_us <= dur) return c;
    const start = Math.min(c.source.start_us, Math.max(0, dur - MIN_CLIP_US));
    return { ...c, source: { start_us: start, duration_us: Math.max(MIN_CLIP_US, dur - start) } };
  };

  // Main track: magnetic layout.
  const mainClips = main.clips.map((c) => ({ ...fitSource(c) }));
  let t = Math.max(0, main.offset_us ?? 0);
  for (let i = 0; i < mainClips.length; i++) {
    const c = mainClips[i];
    c.timeline_start_us = t;
    const next = mainClips[i + 1];
    if (c.transition_out) {
      const max = next ? maxTransitionUs(c, next) : 0;
      if (!next || max < MIN_TRANSITION_US) c.transition_out = null;
      else c.transition_out = { type: 'mix', duration_us: clamp(c.transition_out.duration_us, MIN_TRANSITION_US, max) };
    }
    t += c.source.duration_us - (c.transition_out?.duration_us ?? 0);
  }

  const freeSorted = (clips: Clip[]) =>
    clips.map((c) => ({ ...fitSource(c), timeline_start_us: Math.max(0, c.timeline_start_us), transition_out: null })).sort((x, y) => x.timeline_start_us - y.timeline_start_us);
  const overlayTracksOut = overlays.map((tr) => ({ ...tr, clips: freeSorted(tr.clips) }));

  const videoById = new Map<string, Clip>();
  for (const c of mainClips) videoById.set(c.id, c);
  for (const tr of overlayTracksOut) for (const c of tr.clips) videoById.set(c.id, c);

  const audioTracksOut = audios.map((tr) => {
    const clips: Clip[] = [];
    for (const a of tr.clips) {
      if (a.linked_to) {
        const v = videoById.get(a.linked_to);
        if (!v) continue; // its video clip is gone
        clips.push({ ...a, source: { ...v.source }, timeline_start_us: v.timeline_start_us });
      } else {
        clips.push({ ...fitSource(a), timeline_start_us: Math.max(0, a.timeline_start_us) });
      }
    }
    clips.sort((x, y) => x.timeline_start_us - y.timeline_start_us);
    return { ...tr, clips };
  });

  const tracks: Track[] = [...overlayTracksOut, { ...main, main: true, clips: mainClips }, ...audioTracksOut];
  for (const tr of tracks) for (const c of tr.clips) clampClipProps(c);
  return { ...p, tracks };
}

/** Remove empty secondary tracks, keeping one audio track. */
export function pruneEmptyTracks(p: Project): Project {
  const firstAudio = p.tracks.find((t) => t.kind === 'audio');
  const tracks = p.tracks.filter((t) => t.main || t.clips.length > 0);
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push(firstAudio ?? { id: newId(), kind: 'audio', clips: [] });
  return tracks.length === p.tracks.length ? p : normalize({ ...p, tracks });
}

function clampClipProps(c: Clip) {
  c.gain_db = clamp(Number.isFinite(c.gain_db) ? c.gain_db : 0, MIN_GAIN_DB, MAX_GAIN_DB);
  const d = c.source.duration_us;
  c.fade_in_us = clamp(Math.round(c.fade_in_us || 0), 0, d);
  c.fade_out_us = clamp(Math.round(c.fade_out_us || 0), 0, d - c.fade_in_us);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function projectDuration(p: Project): Us {
  let end = 0;
  for (const track of p.tracks) for (const c of track.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/** Effective export range in µs, clamped to the project. */
export function effectiveRange(p: Project, useMarks: boolean): { start: Us; end: Us } {
  const total = projectDuration(p);
  if (!useMarks) return { start: 0, end: total };
  const start = clamp(p.range.in_us ?? 0, 0, total);
  const end = clamp(p.range.out_us ?? total, 0, total);
  return end > start ? { start, end } : { start: 0, end: total };
}

/** Crossfade durations that apply to a main-track clip from its neighbours' Mix transitions. */
export function transitionEdges(p: Project, videoClipId: string): { in_us: Us; out_us: Us } {
  const clips = mainTrack(p).clips;
  const i = clips.findIndex((c) => c.id === videoClipId);
  if (i < 0) return { in_us: 0, out_us: 0 };
  return {
    in_us: i > 0 ? clips[i - 1].transition_out?.duration_us ?? 0 : 0,
    out_us: clips[i].transition_out?.duration_us ?? 0,
  };
}

export const dbToGain = (db: number) => (db <= MIN_GAIN_DB ? 0 : Math.pow(10, db / 20));
/** Volume shown to the user: 100 % = original level, 0 % = silence. */
export const dbToPercent = (db: number) => dbToGain(db) * 100;
export const percentToDb = (pct: number) => (pct <= 0 ? MIN_GAIN_DB : clamp(20 * Math.log10(pct / 100), MIN_GAIN_DB, MAX_GAIN_DB));

/** Validate and upgrade a JSON object loaded from disk. Throws with a readable message. */
export function parseProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new Error('El archivo no es un proyecto JSON.');
  const p = raw as Partial<Project>;
  if (p.app !== 'MyEditor') throw new Error('Este JSON no es un proyecto de MyEditor.');
  if (typeof p.schema_version !== 'number' || p.schema_version > SCHEMA_VERSION)
    throw new Error(`Versión de proyecto no soportada: ${String(p.schema_version)}.`);
  if (!Array.isArray(p.tracks) || !p.media || typeof p.media !== 'object')
    throw new Error('El proyecto está incompleto (faltan pistas o medios).');
  let tracks = p.tracks as Track[];
  // v1: exactly [video, audio]; the video track becomes the main track.
  if (p.schema_version === 1) tracks = tracks.map((t, i) => ({ ...t, main: i === 0 && t.kind === 'video' ? true : undefined }));
  const checkTracks = (list: Track[], where: string) => {
    if (list.filter((t) => t.main).length !== 1) throw new Error(`${where} debe tener exactamente una pista principal.`);
    for (const track of list) {
      if (track.kind !== 'video' && track.kind !== 'audio') throw new Error(`Pista de tipo desconocido: ${String(track.kind)}.`);
      for (const c of track.clips) {
        if (!p.media![c.media]) throw new Error(`El clip ${c.id} usa un medio que no está en el proyecto.`);
      }
    }
  };
  checkTracks(tracks, 'El proyecto');
  const compounds = p.compounds ?? {};
  for (const [id, data] of Object.entries(compounds)) {
    if (p.media[id]?.kind !== 'compound') throw new Error(`La composición ${id} no tiene su medio.`);
    checkTracks(data.tracks, 'Cada composición');
  }
  for (const m of Object.values(p.media)) if (m.kind === 'compound' && !compounds[m.id]) throw new Error(`Falta el contenido de la composición «${m.name}».`);
  return normalize({ ...createProject(), ...p, schema_version: SCHEMA_VERSION, tracks, compounds } as Project);
}

/** mm:ss or mm:ss:ff. Frames are rounded, since frame-snapped times like 4033333 µs are not exact. */
/** Length of a compound's content: where its last clip ends. */
export function tracksDuration(tracks: Track[]): Us {
  let end = 0;
  for (const t of tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/**
 * Refresh the media entries of compound clips (duration, has_video, has_audio)
 * from their content. Nested compounds are resolved innermost first.
 */
export function syncCompounds(p: Project): Project {
  if (!p.compounds || !Object.keys(p.compounds).length) return p;
  const media = { ...p.media };
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const [id, data] of Object.entries(p.compounds)) {
      const clips = data.tracks.flatMap((t) => t.clips);
      const next: MediaInfo = {
        ...media[id],
        duration_us: Math.max(MIN_CLIP_US, tracksDuration(data.tracks)),
        has_video: data.tracks.some((t) => t.kind === 'video' && t.clips.some((c) => media[c.media]?.has_video)),
        has_audio: clips.some((c) => media[c.media]?.has_audio),
      };
      const prev = media[id];
      if (prev.duration_us !== next.duration_us || prev.has_video !== next.has_video || prev.has_audio !== next.has_audio) {
        media[id] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return normalize({ ...p, media });
}

export function formatTime(t: Us, withFrames = false, fps = 30): string {
  const frames = Math.round((Math.max(0, t) * fps) / US_PER_S);
  const totalS = withFrames ? Math.floor(frames / fps) : Math.floor(Math.max(0, t) / US_PER_S + 1e-9);
  const base = `${String(Math.floor(totalS / 60)).padStart(2, '0')}:${String(totalS % 60).padStart(2, '0')}`;
  return withFrames ? `${base}:${String(frames % fps).padStart(2, '0')}` : base;
}
