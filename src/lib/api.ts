import type { MediaInfo, Project } from '../../shared/model.ts';
import type { Resolution } from '../../shared/exportGraph.ts';
import type { ProFixRequest, ProJob, ProJobRequest, ProStatus } from '../../shared/pro.ts';

export const mediaUrl = (id: string) => `/api/media/${id}/file`;
export const thumbUrl = (id: string) => `/api/media/${id}/thumb.jpg`;
export const waveUrl = (id: string) => `/api/media/${id}/wave.png`;

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

/** Upload one file to the local server; reports upload progress 0..1. */
export function importFile(file: File, onProgress: (f: number) => void): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/media?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as MediaInfo & { error?: string };
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error ?? `HTTP ${xhr.status}`));
      } catch {
        reject(new Error(`Respuesta inesperada del servidor (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('No se pudo contactar con el servidor local. ¿Está en marcha (npm run dev)?'));
    xhr.send(file);
  });
}

export async function mediaExists(id: string): Promise<boolean> {
  const res = await fetch(`/api/media/${id}`);
  return res.ok;
}

export interface ExportJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  error?: string;
  fileName: string;
  path: string;
}

export async function startExport(project: Project, resolution: Resolution, useRange: boolean, fileName: string): Promise<string> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, resolution, useRange, fileName }),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  return ((await res.json()) as { id: string }).id;
}

export async function getExport(id: string): Promise<ExportJob> {
  const res = await fetch(`/api/export/${id}`);
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ExportJob;
}

export async function cancelExport(id: string): Promise<void> {
  await fetch(`/api/export/${id}/cancel`, { method: 'POST' });
}

export const downloadUrl = (id: string) => `/api/export/${id}/download`;

// ---- Mejoras Pro
export async function getProStatus(): Promise<ProStatus> {
  const res = await fetch('/api/pro/status');
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ProStatus;
}

export async function startProJob(req: ProJobRequest): Promise<ProJob> {
  const res = await fetch('/api/pro/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ProJob;
}

export async function startProFix(req: ProFixRequest): Promise<ProJob> {
  const res = await fetch('/api/pro/fix', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ProJob;
}

export async function getProJob(id: string): Promise<ProJob> {
  const res = await fetch(`/api/pro/jobs/${id}`);
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as ProJob;
}

export async function cancelProJob(id: string): Promise<void> {
  await fetch(`/api/pro/jobs/${id}/cancel`, { method: 'POST' });
}

export async function getMedia(id: string): Promise<MediaInfo | null> {
  const res = await fetch(`/api/media/${id}`);
  return res.ok ? ((await res.json()) as MediaInfo) : null;
}
