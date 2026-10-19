// MyEditor local server: stores imported media, serves it to the browser and
// runs FFmpeg exports. Listens on 127.0.0.1 only; no cloud, no accounts.

import { createHash, randomUUID } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { buildExport, type Resolution, type VideoEncoder } from '../shared/exportGraph.ts';
import { type MediaInfo, parseProject } from '../shared/model.ts';
import type { ProFixRequest, ProJobRequest } from '../shared/pro.ts';
import { detectEncoder, FFMPEG, ffmpegVersion, makeThumbnail, makeWaveform, probe } from './ffmpeg.ts';
import { createPro } from './pro.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = resolve(process.env.MYEDITOR_WORKSPACE ?? join(ROOT, 'workspace'));
const MEDIA_DIR = join(WORKSPACE, 'media');
const EXPORT_DIR = join(WORKSPACE, 'exports');
const TMP_DIR = join(WORKSPACE, 'tmp');
const PORT = Number(process.env.MYEDITOR_PORT ?? 5175);

const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const ID_RE = /^[a-f0-9]{16}$/;

await Promise.all([MEDIA_DIR, EXPORT_DIR, TMP_DIR].map((d) => mkdir(d, { recursive: true })));
const encoder = await detectEncoder();
const version = await ffmpegVersion();

const app = express();
app.use(express.json({ limit: '20mb' }));

const mediaJson = (id: string) => join(MEDIA_DIR, `${id}.json`);

async function readMedia(id: string): Promise<MediaInfo | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(await readFile(mediaJson(id), 'utf8')) as MediaInfo;
  } catch {
    return null;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ffmpeg: version, encoder, workspace: WORKSPACE });
});

/** Move a finished upload or result into the media store (id = content hash). */
async function storeAs(tmp: string, id: string, name: string, extra: Partial<MediaInfo> = {}): Promise<MediaInfo> {
  const existing = await readMedia(id);
  if (existing) {
    await rm(tmp, { force: true });
    return existing;
  }
  const file = `${id}${extname(tmp).toLowerCase()}`;
  const path = join(MEDIA_DIR, file);
  await rename(tmp, path);
  const info: MediaInfo = { id, name, file, ...(await probe(path)), ...extra };
  if (info.has_video) await makeThumbnail(path, join(MEDIA_DIR, `${id}.thumb.jpg`), info.duration_us);
  if (info.has_audio) await makeWaveform(path, join(MEDIA_DIR, `${id}.wave.png`));
  await writeFile(mediaJson(id), JSON.stringify(info, null, 2));
  return info;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').slice(0, 16);
}

// Import: the browser PUTs the raw file. The id is a content hash, so importing
// the same file twice (or re-importing after opening a project) reuses it.
app.put('/api/media', async (req: Request, res: Response) => {
  const name = String(req.query.name ?? '').slice(0, 255);
  const ext = extname(name).toLowerCase();
  if (!MEDIA_EXT.has(ext)) {
    res.status(400).json({ error: `Formato no soportado (${ext || 'sin extensión'}). Usa vídeo o audio.` });
    return;
  }
  const tmp = join(TMP_DIR, `${randomUUID()}${ext}`);
  const hash = createHash('sha1');
  try {
    req.on('data', (chunk: Buffer) => hash.update(chunk));
    await pipeline(req, createWriteStream(tmp));
    res.json(await storeAs(tmp, hash.digest('hex').slice(0, 16), name));
  } catch (err) {
    await rm(tmp, { force: true });
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/media/:id', async (req, res) => {
  const info = await readMedia(req.params.id);
  if (!info) res.status(404).json({ error: 'Medio no encontrado' });
  else res.json(info);
});

app.get('/api/media/:id/file', async (req, res) => {
  const info = await readMedia(req.params.id);
  if (!info) res.status(404).end();
  else res.sendFile(join(MEDIA_DIR, info.file)); // supports Range for seeking
});

app.get('/api/media/:id/:kind(thumb.jpg|wave.png)', (req, res) => {
  const { id, kind } = req.params;
  const path = join(MEDIA_DIR, `${id}.${kind}`);
  if (!ID_RE.test(id) || !existsSync(path)) res.status(404).end();
  else res.sendFile(path, { maxAge: '1d' });
});

// ---- Export jobs
interface Job {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  error?: string;
  file: string;
  fileName: string;
  child?: ChildProcess;
  log: string;
}
const jobs = new Map<string, Job>();

function runExport(job: Job, args: string[], durationUs: number, enc: VideoEncoder, retry: () => void) {
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.child = child;
  child.stdout.on('data', (d: Buffer) => {
    const last = [...d.toString().matchAll(/out_time_us=(\d+)/g)].at(-1);
    if (last) job.progress = Math.max(0, Math.min(0.99, Number(last[1]) / durationUs));
  });
  child.stderr.on('data', (d: Buffer) => {
    job.log = (job.log + d.toString()).slice(-8000);
  });
  child.on('close', (code) => {
    job.child = undefined;
    if (job.status === 'cancelled') return;
    if (code === 0) {
      job.status = 'done';
      job.progress = 1;
    } else if (enc === 'h264_videotoolbox') {
      // Hardware encoder refused (e.g. resolution limits): retry in software.
      retry();
    } else {
      job.status = 'error';
      job.error = job.log.trim().split('\n').slice(-4).join('\n');
    }
  });
}

app.post('/api/export', async (req, res) => {
  try {
    const project = parseProject(req.body?.project);
    const resolution: Resolution = req.body?.resolution === '4k' ? '4k' : '1080p';
    const useRange = Boolean(req.body?.useRange);
    for (const m of Object.values(project.media)) {
      if (m.kind === 'compound') continue; // content lives in project.compounds, not on disk
      if (!(await readMedia(m.id))) throw new Error(`Falta el medio «${m.name}». Vuelve a importarlo.`);
    }
    const base = String(req.body?.fileName || project.name || 'export').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80) || 'export';
    const fileName = `${base}-${resolution}${useRange ? '-tramo' : ''}.mp4`;
    const id = randomUUID();
    const file = join(EXPORT_DIR, `${id}.mp4`);
    const job: Job = { id, status: 'running', progress: 0, file, fileName, log: '' };
    jobs.set(id, job);

    const start = (enc: VideoEncoder) => {
      const plan = buildExport(project, { resolution, useRange, encoder: enc, outPath: file, mediaPath: (m) => join(MEDIA_DIR, project.media[m].file) });
      runExport(job, plan.args, plan.duration_us, enc, () => start('libx264'));
    };
    start(encoder);
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/export/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) res.status(404).json({ error: 'Exportación no encontrada' });
  else res.json({ id: job.id, status: job.status, progress: job.progress, error: job.error, fileName: job.fileName, path: job.file });
});

app.post('/api/export/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.status === 'running') {
    job.status = 'cancelled';
    job.child?.kill('SIGTERM');
    void rm(job.file, { force: true });
  }
  res.json({ ok: true });
});

app.get('/api/export/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') res.status(404).end();
  else res.download(job.file, job.fileName);
});

// ---- Mejoras Pro (local AI enhancements, server/pro.ts)
const pro = createPro({
  root: ROOT,
  tmpDir: TMP_DIR,
  kitsDir: join(WORKSPACE, 'pro-kits'),
  mediaPath: (m) => join(MEDIA_DIR, m.file),
  readMedia,
  storeFile: async (path, name, extra) => storeAs(path, await hashFile(path), name, extra),
});

app.get('/api/pro/status', async (_req, res) => {
  res.json(await pro.status());
});

app.post('/api/pro/jobs', async (req, res) => {
  try {
    res.json(await pro.start(req.body as ProJobRequest));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/pro/fix', async (req, res) => {
  try {
    res.json(await pro.fix(req.body as ProFixRequest));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/pro/jobs/:id', (req, res) => {
  const job = pro.get(req.params.id);
  if (!job) res.status(404).json({ error: 'Trabajo no encontrado' });
  else res.json(job);
});

app.post('/api/pro/jobs/:id/cancel', (req, res) => {
  pro.cancel(req.params.id);
  res.json({ ok: true });
});

if (process.argv.includes('--serve-dist')) {
  const dist = join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`MyEditor server en http://127.0.0.1:${PORT}  (${version}; encoder ${encoder})`);
  console.log(`Workspace: ${WORKSPACE}`);
});
