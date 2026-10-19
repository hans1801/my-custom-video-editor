// Mejoras Pro jobs: one at a time, in the background, with progress and ETA.
// Picture: FFmpeg deflicker/denoise, GFPGAN (pro/face.py). Sound: Resemble
// Enhance (pro/voice.py), voice EQ/compression, whine notches, loudnorm.
// Everything runs on this Mac; nothing is uploaded.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaInfo } from '../shared/model.ts';
import {
  type Loudness,
  MAX_PASSES,
  type ProFixRequest,
  type ProJob,
  type ProJobRequest,
  type ProMeasures,
  type ProOptions,
  type ProStatus,
  type VoiceFix,
  type VoiceKit,
  type VoicePass,
} from '../shared/pro.ts';
import { FFMPEG, FFPROBE, run } from './ffmpeg.ts';

// ---- The recipe (README, "Mejoras Pro")
export const DEFLICKER = 'deflicker=size=5:mode=am,hqdn3d=1.4:1.2:4:4';
export const FACE_FINISH = 'hqdn3d=0:0:6:6,eq=brightness=0.03:contrast=1.02:saturation=1.12,colorchannelmixer=rr=0.995:bb=1.005';
// Approved voice recipe (mejorar_voz.py), split in two so "Normalizar" can be
// chosen apart. Both checked = exactly the approved chain, in one pass.
// The three notches remove the steady ~14.7 kHz tone Resemble Enhance leaves.
const VOICE_NOTCHES = 'equalizer=f=14492:t=q:w=10:g=-15,equalizer=f=14702:t=q:w=10:g=-20,equalizer=f=14912:t=q:w=10:g=-15';
const NOTCH_BAND = [14300, 15100];
export const VOICE_HIGHPASS = 'highpass=f=75';
export const VOICE_FINISH =
  'equalizer=f=1600:t=q:w=1:g=3,highshelf=f=3500:t=q:w=0.7:g=4,lowpass=f=15500:p=2,lowpass=f=15500,' +
  'acompressor=threshold=-22dB:ratio=2:attack=10:release=150:makeup=1,alimiter=limit=0.89';
/** Single pass (dynamic), as approved. */
const NORMALIZE = 'pan=stereo|c0=c0|c1=c0,loudnorm=I=-18:TP=-1.5:LRA=7';
const LOUDNORM = 'loudnorm=I=-18:TP=-1.5:LRA=7';
/** Extra steady tones elsewhere are only notched when they clearly stand out. */
const EXTRA_WHINE_DB = 15;
const NEEDED_FILTERS = ['deflicker', 'hqdn3d', 'eq', 'colorchannelmixer', 'highpass', 'equalizer', 'highshelf', 'lowpass', 'acompressor', 'alimiter', 'loudnorm', 'signalstats'];

interface Deps {
  root: string;
  tmpDir: string;
  /** Where voice kits (chosen pass + clean-only version) are kept for word fixes. */
  kitsDir: string;
  mediaPath: (m: MediaInfo) => string;
  readMedia: (id: string) => Promise<MediaInfo | null>;
  /** Hash, move into the media store, probe, thumbnail and waveform. */
  storeFile: (path: string, name: string, extra: Partial<MediaInfo>) => Promise<MediaInfo>;
}

interface Rates {
  face_s_per_frame: number;
  voice_s_per_s: number;
}

interface Job extends ProJob {
  /** An enhancement, or a word fix re-rendered from a voice kit. */
  req?: ProJobRequest;
  fix?: ProFixRequest;
  child?: ChildProcess;
  log: string;
}

export function createPro(deps: Deps) {
  const proDir = join(deps.root, 'pro');
  const python = join(proDir, '.venv', 'bin', 'python');
  const modelsDir = join(proDir, 'models');
  const timingsPath = join(modelsDir, 'timings.json');
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let active: Job | null = null;
  let missingFilters: string[] | null = null;

  const readJson = <T>(path: string): T | null => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return null;
    }
  };

  async function status(): Promise<ProStatus> {
    if (missingFilters === null) {
      const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters']);
      missingFilters = NEEDED_FILTERS.filter((f) => !new RegExp(`\\s${f}\\s`).test(stdout));
    }
    const check = readJson<{ ok: boolean; device: ProStatus['device']; face_s_per_frame: number; voice_s_per_s: number }>(join(modelsDir, 'status.json'));
    const learned = readJson<Partial<Rates>>(timingsPath) ?? {};
    // Until a real job is timed: the reference 0.34 s/frame (M1 Max, with face
    // parsing and paste-back) or 1.5× the synthetic measurement elsewhere.
    const base: Rates = {
      face_s_per_frame: check?.device === 'mps' ? 0.34 : (check?.face_s_per_frame ?? 1) * 1.5,
      voice_s_per_s: check?.voice_s_per_s ?? 3,
    };
    const rates = { ...base, ...learned };
    let reason: string | undefined;
    if (!existsSync(python)) reason = 'Falta el entorno de Python. Ejecuta pro/setup.sh.';
    else if (!check?.ok) reason = 'Los modelos no están comprobados. Ejecuta pro/setup.sh.';
    else if (missingFilters.length) reason = `A tu FFmpeg le faltan filtros: ${missingFilters.join(', ')}.`;
    return { installed: !reason, reason, device: check?.device, ...rates };
  }

  function learn(key: keyof Rates, value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    const learned = readJson<Partial<Rates>>(timingsPath) ?? {};
    learned[key] = learned[key] ? learned[key]! * 0.5 + value * 0.5 : value;
    void writeFile(timingsPath, JSON.stringify(learned, null, 2));
  }

  /** Run a process for the job; stdout lines go to onLine. Rejects on failure or cancel. */
  function spawnJob(job: Job, cmd: string, args: string[], onLine: (line: string) => void = () => {}, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONWARNINGS: 'ignore' } });
      job.child = child;
      let buf = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine(l.trim());
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
        job.log = (job.log + d.toString()).slice(-6000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        job.child = undefined;
        if (job.status === 'cancelled') reject(new Error('cancelled'));
        else if (code === 0) resolve(stderr);
        else reject(new Error(lastLines(stderr) || `El proceso terminó con código ${code}`));
      });
    });
  }

  const ffmpegProgress = (durationS: number, set: (f: number) => void) => (line: string) => {
    const m = /^out_time_us=(\d+)/.exec(line);
    if (m) set(Number(m[1]) / 1e6 / durationS);
  };

  async function videoFps(path: string): Promise<string> {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', path]);
    const s = (JSON.parse(stdout) as { streams?: { avg_frame_rate?: string; r_frame_rate?: string }[] }).streams?.[0];
    const ok = (r?: string) => r && /^\d+\/\d+$/.test(r) && Number(r.split('/')[0]) > 0 && Number(r.split('/')[1]) > 0 && fpsValue(r) <= 240;
    return ok(s?.avg_frame_rate) ? s!.avg_frame_rate! : ok(s?.r_frame_rate) ? s!.r_frame_rate! : '30/1';
  }

  async function loudness(job: Job, input: string[], filters = ''): Promise<Loudness & { thresh: number; offset: number }> {
    const stderr = await spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', ...input, '-vn', '-af', `${filters ? `${filters},` : ''}${LOUDNORM}:print_format=json`, '-f', 'null', '-']);
    const json = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr)?.[0];
    if (!json) throw new Error('No se pudo medir el volumen.');
    const v = JSON.parse(json) as Record<string, string>;
    return { i: Number(v.input_i), tp: Number(v.input_tp), lra: Number(v.input_lra), thresh: Number(v.input_thresh), offset: Number(v.target_offset) };
  }

  async function flicker(job: Job, input: string[]): Promise<number> {
    const stderr = await spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', ...input, '-an', '-vf', 'scale=320:-2,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']);
    const ys = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    if (ys.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < ys.length; i++) sum += Math.abs(ys[i] - ys[i - 1]);
    return Math.round((sum / (ys.length - 1)) * 1000) / 1000;
  }

  async function runJob(job: Job) {
    const req = job.req!;
    const o = req.options;
    const media = await deps.readMedia(req.media);
    if (!media) throw new Error('No encuentro el medio original.');
    const src = deps.mediaPath(media);
    const s = req.start_us / 1e6;
    const d = req.duration_us / 1e6;
    const cut = ['-ss', s.toFixed(6), '-t', d.toFixed(6), '-i', src];
    const st = await status();
    const work = join(deps.tmpDir, `pro-${job.id}`);
    await mkdir(work, { recursive: true });
    try {
      const video = req.video && media.has_video;
      const audio = req.audio && media.has_audio;
      const fps = video ? await videoFps(src) : '30/1';
      const frames = Math.max(1, Math.round(d * fpsValue(fps)));
      const measures: ProMeasures = {};
      const passes = Math.max(1, Math.min(MAX_PASSES, Math.round(req.voice_passes ?? 1)));
      let voicePasses: VoicePass[] = [];
      let chosen = 0;
      let audioChain = '';

      // ---- Plan the steps with an estimated cost each (seconds), for progress and ETA.
      type Step = { label: string; est: number; run: (set: (f: number) => void) => Promise<void> };
      const steps: Step[] = [];
      const vOut = join(work, 'video.mp4');
      const aOut = join(work, 'audio.wav');

      if (video && o.face) {
        steps.push({
          label: 'Mejorando el rostro',
          est: 20 + frames * st.face_s_per_frame,
          run: async (set) => {
            const w = even(media.width);
            const h = even(media.height);
            let rate = 0;
            await spawnJob(
              job,
              python,
              [join(proDir, 'face.py'), '--ffmpeg', FFMPEG, '--input', src, '--output', vOut, '--start', s.toFixed(6), '--duration', d.toFixed(6),
                '--fps', fps, '--width', String(w), '--height', String(h), '--frames', String(frames), '--pre', o.deflicker ? DEFLICKER : '', '--post', FACE_FINISH],
              (line) => {
                const m = parseLine(line);
                if (m?.stage !== 'face' || typeof m.done !== 'number') return;
                set(m.done / Math.max(1, m.total as number));
                if (typeof m.elapsed === 'number' && m.done > 0) rate = m.elapsed / m.done;
                if (m.finished) measures.faces = { frames: m.done, with_face: m.faces as number };
              },
              proDir,
            );
            if (rate) learn('face_s_per_frame', rate);
          },
        });
      } else if (video) {
        steps.push({
          label: o.deflicker ? 'Quitando parpadeo y ruido' : 'Preparando la imagen',
          est: d * (o.deflicker ? 0.4 : 0.15),
          run: (set) =>
            spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...cut, '-an', ...(o.deflicker ? ['-vf', DEFLICKER] : []),
              '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', vOut], ffmpegProgress(d, set)).then(() => {}),
        });
      }

      if (audio) {
        const voiceIn = join(work, 'voice-in.wav');
        const voiceOut = join(work, 'voice-out.wav');
        const cleanOut = join(work, 'voice-clean.wav');
        let whines: { hz: number; excess_db: number }[] = [];
        if (o.voice) {
          const runs = passes + 0.15; // the clean-only pass is much lighter
          steps.push({
            label: passes > 1 ? `Mejorando la voz (${passes} pasadas)` : 'Mejorando la voz',
            est: 15 + d * st.voice_s_per_s * runs,
            run: async (set) => {
              await spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', '-y', ...cut, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', voiceIn]);
              let loaded = 0;
              let reported = 0;
              // Chunks are 30 s, so between reports progress follows the estimate.
              const tick = setInterval(() => loaded && set(Math.min(0.95, Math.max(reported, (Date.now() - loaded) / 1000 / (d * st.voice_s_per_s * runs)))), 500);
              try {
                await spawnJob(job, python, [join(proDir, 'voice.py'), '--input', voiceIn, '--output', voiceOut, '--passes', String(passes), '--clean', cleanOut], (line) => {
                  const m = parseLine(line);
                  if (m?.stage !== 'voice') return;
                  if (m.done === 0) loaded = Date.now();
                  if (typeof m.done === 'number' && typeof m.total === 'number' && m.total > 0) reported = m.done / m.total;
                  if (m.finished) {
                    whines = (m.whines as typeof whines) ?? [];
                    voicePasses = (m.passes as VoicePass[]) ?? [];
                    chosen = typeof m.chosen === 'number' ? m.chosen : 0;
                    if (typeof m.elapsed === 'number') learn('voice_s_per_s', m.elapsed / (d * runs));
                  }
                }, proDir);
              } finally {
                clearInterval(tick);
              }
            },
          });
        }
        steps.push({
          label: o.normalize ? 'Normalizando el volumen' : 'Preparando el audio',
          est: 1 + d * (o.normalize ? 0.05 : 0.03),
          run: async () => {
            const input = o.voice ? ['-i', voiceOut] : cut;
            const chain: string[] = [];
            if (o.voice) {
              const extra = whines.filter((w) => (w.hz < NOTCH_BAND[0] || w.hz > NOTCH_BAND[1]) && w.excess_db >= EXTRA_WHINE_DB);
              chain.push(VOICE_HIGHPASS, VOICE_NOTCHES, ...extra.map((w) => `equalizer=f=${w.hz}:t=q:w=10:g=-${Math.min(30, Math.round(w.excess_db))}`), VOICE_FINISH);
              const removed = [...whines.filter((w) => w.hz >= NOTCH_BAND[0] && w.hz <= NOTCH_BAND[1]), ...extra];
              if (removed.length) measures.whines = removed;
            }
            if (o.normalize) chain.push(NORMALIZE);
            audioChain = chain.join(',');
            await spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', '-y', ...input, '-vn', ...(chain.length ? ['-af', chain.join(',')] : []), '-ar', '48000', '-c:a', 'pcm_f32le', aOut]);
          },
        });
      }

      const out = join(work, `result.${video ? 'mp4' : 'm4a'}`);
      steps.push({
        label: 'Montando el resultado',
        est: 1 + d * 0.05,
        run: (set) =>
          spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...(video ? ['-i', vOut] : []), ...(audio ? ['-i', aOut] : []),
            ...(video ? ['-map', '0:v', '-c:v', 'copy'] : []), ...(audio ? ['-map', `${video ? 1 : 0}:a`, '-c:a', 'aac', '-b:a', '256k'] : []),
            '-t', d.toFixed(6), '-movflags', '+faststart', out], ffmpegProgress(d, set)).then(() => {}),
      });

      const measureAudio = audio && (o.voice || o.normalize);
      const measureVideo = video && o.deflicker;
      if (measureAudio || measureVideo)
        steps.push({
          label: 'Midiendo antes y después',
          est: 1 + (measureAudio ? d * 0.06 : 0) + (measureVideo ? d * 0.2 : 0),
          run: async (set) => {
            if (measureAudio) measures.loudness = { before: pick(await loudness(job, cut)), after: pick(await loudness(job, ['-i', out])) };
            set(0.5);
            if (measureVideo) measures.flicker = { before: await flicker(job, cut), after: await flicker(job, ['-i', out]) };
          },
        });

      // ---- Run the steps.
      const total = steps.reduce((a, b) => a + b.est, 0);
      let doneEst = 0;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const startedAt = Date.now();
        const rest = steps.slice(i + 1).reduce((a, b) => a + b.est, 0);
        job.stage = step.label;
        const set = (f: number) => {
          const frac = Math.max(0, Math.min(1, f));
          job.progress = Math.min(0.99, (doneEst + frac * step.est) / total);
          const elapsed = (Date.now() - startedAt) / 1000;
          // Measured rate once the step is underway; the estimate before that.
          const left = frac > 0.05 && elapsed > 2 ? (elapsed / frac) * (1 - frac) : step.est * (1 - frac);
          job.eta_s = Math.round(left + rest);
        };
        set(0);
        await step.run(set);
        doneEst += step.est;
      }

      job.stage = 'Guardando';
      // Keep the chosen pass and the clean-only version so words can be fixed later.
      let voice: VoiceKit | undefined;
      if (audio && o.voice) {
        const kitDir = join(deps.kitsDir, job.id);
        await mkdir(kitDir, { recursive: true });
        await rename(join(work, 'voice-out.wav'), join(kitDir, 'ia.wav'));
        await rename(join(work, 'voice-clean.wav'), join(kitDir, 'clean.wav'));
        voice = { kit: job.id, chain: audioChain, passes: voicePasses, chosen, fixes: [] };
      }
      const base = media.name.replace(/\.[^.]+$/, '');
      job.media = await deps.storeFile(out, `${base} (mejorado).${video ? 'mp4' : 'm4a'}`, {
        derived: {
          from: media.derived?.from ?? media.id,
          start_us: (media.derived?.start_us ?? 0) + req.start_us,
          duration_us: req.duration_us,
          options: mergeOptions(media.derived?.options, o),
          measures,
          ...(voice ? { voice } : {}),
        },
      });
      job.status = 'done';
      job.progress = 1;
      job.eta_s = 0;
      job.stage = 'Listo';
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Re-render the voice of an enhanced medium with some words blended with the clean-only version (palabra.py). */
  async function runFix(job: Job) {
    const req = job.fix!;
    const media = await deps.readMedia(req.media);
    const voice = media?.derived?.voice;
    if (!media || !voice) throw new Error('Este clip no tiene una mejora de voz que se pueda arreglar.');
    const kitDir = join(deps.kitsDir, voice.kit);
    if (!existsSync(join(kitDir, 'ia.wav'))) throw new Error('Faltan los archivos de la mejora de voz. Vuelve a aplicar «Mejorar voz».');
    const d = media.duration_us / 1e6;
    const work = join(deps.tmpDir, `pro-${job.id}`);
    await mkdir(work, { recursive: true });
    try {
      const fixed = join(work, 'fixed.wav');
      const aOut = join(work, 'audio.wav');
      const video = media.has_video;
      const out = join(work, `result.${video ? 'mp4' : 'm4a'}`);
      const fixes: VoiceFix[] = req.fixes
        .map((f) => ({ start: round2(Math.max(0, f.start)), end: round2(Math.min(d, f.end)), mix: Math.max(0, Math.min(1, f.mix)) }))
        .filter((f) => f.end - f.start >= 0.05)
        .sort((a, b) => a.start - b.start);
      job.stage = 'Arreglando las palabras';
      job.progress = 0.1;
      job.eta_s = Math.round(3 + d * 0.1);
      await spawnJob(job, python, [join(proDir, 'fix.py'), join(kitDir, 'ia.wav'), join(kitDir, 'clean.wav'), fixed, JSON.stringify(fixes)], undefined, proDir);
      job.progress = 0.4;
      await spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', '-y', '-i', fixed, ...(voice.chain ? ['-af', voice.chain] : []), '-ar', '48000', '-c:a', 'pcm_f32le', aOut]);
      job.stage = 'Montando el resultado';
      job.progress = 0.7;
      // The picture is copied from the current enhanced medium untouched.
      await spawnJob(job, FFMPEG, ['-hide_banner', '-nostdin', '-y', ...(video ? ['-i', deps.mediaPath(media)] : []), '-i', aOut,
        ...(video ? ['-map', '0:v', '-c:v', 'copy'] : []), '-map', `${video ? 1 : 0}:a`, '-c:a', 'aac', '-b:a', '256k', '-t', d.toFixed(6), '-movflags', '+faststart', out]);
      job.stage = 'Guardando';
      job.progress = 0.9;
      const after = pick(await loudness(job, ['-i', out]));
      const prev = media.derived!.measures;
      job.media = await deps.storeFile(out, media.name, {
        derived: { ...media.derived!, measures: { ...prev, loudness: { before: prev.loudness?.before ?? after, after } }, voice: { ...voice, fixes } },
      });
      job.status = 'done';
      job.progress = 1;
      job.eta_s = 0;
      job.stage = 'Listo';
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function pump() {
    if (active || !queue.length) return;
    const job = queue.shift()!;
    if (job.status !== 'queued') return void pump();
    active = job;
    job.status = 'running';
    try {
      await (job.fix ? runFix(job) : runJob(job));
    } catch (err) {
      if ((job.status as ProJob['status']) !== 'cancelled') {
        job.status = 'error';
        job.error = (err as Error).message;
        console.error(`[pro] ${job.id}: ${job.error}\n${job.log.slice(-1500)}`);
      }
    } finally {
      active = null;
      void pump();
    }
  }

  return {
    status,
    async start(req: ProJobRequest): Promise<ProJob> {
      const st = await status();
      if (!st.installed) throw new Error(st.reason);
      const media = await deps.readMedia(req.media);
      if (!media) throw new Error('No encuentro el medio del clip. Vuelve a importarlo.');
      const o = req.options;
      const video = req.video && media.has_video;
      const audio = req.audio && media.has_audio;
      if (!((video && (o.deflicker || o.face)) || (audio && (o.voice || o.normalize)))) throw new Error('Elige al menos una mejora que se pueda aplicar a este clip.');
      if (!(req.duration_us > 0) || req.start_us < 0 || req.start_us + req.duration_us > media.duration_us + 50_000) throw new Error('El tramo del clip no cabe en el medio.');
      for (const j of jobs.values()) if (j.clipId === req.clipId && (j.status === 'queued' || j.status === 'running')) throw new Error('Este clip ya se está mejorando.');
      const job: Job = { id: randomUUID(), clipId: req.clipId, status: 'queued', stage: 'En cola', progress: 0, eta_s: null, req, log: '' };
      jobs.set(job.id, job);
      queue.push(job);
      void pump();
      return view(job);
    },
    async fix(req: ProFixRequest): Promise<ProJob> {
      const st = await status();
      if (!st.installed) throw new Error(st.reason);
      if (!Array.isArray(req.fixes)) throw new Error('Faltan los tramos a arreglar.');
      const media = await deps.readMedia(req.media);
      if (!media?.derived?.voice) throw new Error('Este clip no tiene una mejora de voz que se pueda arreglar.');
      for (const j of jobs.values()) if (j.clipId === req.clipId && (j.status === 'queued' || j.status === 'running')) throw new Error('Este clip ya se está procesando.');
      const job: Job = { id: randomUUID(), clipId: req.clipId, status: 'queued', stage: 'En cola', progress: 0, eta_s: null, fix: req, log: '' };
      jobs.set(job.id, job);
      queue.push(job);
      void pump();
      return view(job);
    },
    get: (id: string) => {
      const job = jobs.get(id);
      return job ? view(job) : null;
    },
    cancel(id: string) {
      const job = jobs.get(id);
      if (!job || (job.status !== 'running' && job.status !== 'queued')) return;
      job.status = 'cancelled';
      job.stage = 'Cancelado';
      job.child?.kill('SIGTERM');
    },
  };
}

const view = (j: Job): ProJob => ({ id: j.id, kind: j.fix ? 'fix' : 'enhance', clipId: j.clipId, status: j.status, stage: j.stage, progress: j.progress, eta_s: j.eta_s, error: j.error, media: j.media });
const round2 = (n: number) => Math.round(n * 100) / 100;
const even = (n: number) => Math.max(2, n - (n % 2));
const fpsValue = (r: string) => {
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
};
const pick = (l: Loudness): Loudness => ({ i: l.i, tp: l.tp, lra: l.lra });
const lastLines = (s: string) => s.trim().split('\n').slice(-4).join('\n');
const mergeOptions = (a: ProOptions | undefined, b: ProOptions): ProOptions => ({
  deflicker: Boolean(a?.deflicker || b.deflicker),
  face: Boolean(a?.face || b.face),
  voice: Boolean(a?.voice || b.voice),
  normalize: Boolean(a?.normalize || b.normalize),
});

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}
