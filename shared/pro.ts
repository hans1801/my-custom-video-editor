// "Mejoras Pro": local enhancements built from free tools (FFmpeg filters,
// GFPGAN, Resemble Enhance). A job processes one clip's
// source range into a new medium; the clip is then pointed at it and keeps
// a link back to the original (Derived) for the before/after comparison.

import type { MediaInfo, Us } from './model.ts';

export interface ProOptions {
  /** deflicker + hqdn3d */
  deflicker: boolean;
  /** GFPGAN v1.4 face restoration */
  face: boolean;
  /** Resemble Enhance + voice EQ/compression */
  voice: boolean;
  /** loudnorm to −18 LUFS */
  normalize: boolean;
}

export const NO_PRO: ProOptions = { deflicker: false, face: false, voice: false, normalize: false };
export const VIDEO_OPTIONS = ['deflicker', 'face'] as const;
export const AUDIO_OPTIONS = ['voice', 'normalize'] as const;

export const PRO_LABELS: Record<keyof ProOptions, { title: string; detail: string }> = {
  deflicker: { title: 'Quitar parpadeo y ruido de imagen', detail: 'FFmpeg deflicker + hqdn3d' },
  face: { title: 'Mejorar calidad del rostro', detail: 'GFPGAN v1.4, mezcla 60 / 40' },
  voice: { title: 'Mejorar voz', detail: 'Resemble Enhance + ecualización' },
  normalize: { title: 'Normalizar volumen', detail: 'loudnorm a −18 LUFS' },
};

export interface Loudness {
  /** Integrated loudness, LUFS */
  i: number;
  /** True peak, dBTP */
  tp: number;
  /** Loudness range, LU */
  lra: number;
}

export interface ProMeasures {
  loudness?: { before: Loudness; after: Loudness };
  /** Mean frame-to-frame brightness change (0–255 scale); lower = steadier. */
  flicker?: { before: number; after: number };
  /** Steady high tones found after voice enhancement and notched out. */
  whines?: { hz: number; excess_db: number }[];
  faces?: { frames: number; with_face: number };
}

/** A range of the enhanced voice to blend with the clean-only version (palabra.py). Seconds in the enhanced medium. */
export interface VoiceFix {
  start: number;
  end: number;
  /** 0–1: share of the clean-only version (1 = only the natural one). */
  mix: number;
}

/** One pass of the voice model and how close it stayed to the original (fidelidad.py). */
export interface VoicePass {
  distance: number;
  /** The 4 worst moments (s) and their score; far above the usual = likely invented or distorted syllable. */
  worst: { t: number; score: number }[];
}

/** What a voice job keeps so words can be fixed later without running the model again. */
export interface VoiceKit {
  /** Folder in workspace/pro-kits with ia.wav (chosen pass) and clean.wav (clean-only). */
  kit: string;
  /** FFmpeg audio chain applied after the model. */
  chain: string;
  passes: VoicePass[];
  chosen: number;
  fixes: VoiceFix[];
}

export interface Derived {
  /** Original medium and the range of it that was processed. */
  from: string;
  start_us: Us;
  duration_us: Us;
  options: ProOptions;
  measures: ProMeasures;
  voice?: VoiceKit;
}

export interface ProStatus {
  installed: boolean;
  /** Why it can't run, in Spanish, when not installed. */
  reason?: string;
  device?: 'mps' | 'cuda' | 'cpu';
  /** Seconds per frame (face) and per second of audio (voice), for estimates. */
  face_s_per_frame: number;
  voice_s_per_s: number;
}

export interface ProJobRequest {
  clipId: string;
  media: string;
  start_us: Us;
  duration_us: Us;
  options: ProOptions;
  /** The clip shows picture (video track); otherwise only sound is produced. */
  video: boolean;
  /** The clip plays its sound (not separated to an audio track). */
  audio: boolean;
  /** Voice: run the model this many times (1–5) and keep the most faithful pass. */
  voice_passes?: number;
}

export interface ProFixRequest {
  clipId: string;
  /** An enhanced medium with a voice kit. */
  media: string;
  fixes: VoiceFix[];
}

/** Score far enough above the pass's average distance to flag a moment as suspicious. */
export const SUSPICIOUS_FACTOR = 1.6;
export const MAX_PASSES = 5;

export interface ProJob {
  id: string;
  /** 'fix' = word fixes re-rendered from a voice kit. */
  kind?: 'enhance' | 'fix';
  clipId: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  /** Current step, in Spanish. */
  stage: string;
  progress: number;
  /** Estimated seconds left; null while unknown. */
  eta_s: number | null;
  error?: string;
  media?: MediaInfo;
}

/** Rough duration of a job before it starts, in seconds. */
export function estimateSeconds(st: ProStatus, o: ProOptions, durationUs: Us, fps = 30, video = true, audio = true, passes = 1): number {
  const s = durationUs / 1e6;
  let t = 2 + s * 0.15; // cutting, muxing, thumbnails
  if (video && o.face) t += 20 + s * fps * st.face_s_per_frame;
  else if (video && o.deflicker) t += s * 0.4;
  if (audio && o.voice) t += 15 + s * st.voice_s_per_s * (passes + 0.15);
  if (audio && o.normalize) t += 1 + s * 0.05;
  if (video && o.deflicker) t += s * 0.2; // flicker measurement
  return t;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
