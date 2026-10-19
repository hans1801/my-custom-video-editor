import { useEffect, useRef, useState } from 'react';
import { effectiveRange, formatTime, type Project } from '../../shared/model.ts';
import type { Resolution } from '../../shared/exportGraph.ts';
import { cancelExport, downloadUrl, type ExportJob, getExport, startExport } from '../lib/api.ts';
import { IconClose, IconExport } from './Icons.tsx';

export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const hasMarks = project.range.in_us !== null || project.range.out_us !== null;
  const [resolution, setResolution] = useState<Resolution>('1080p');
  const [useRange, setUseRange] = useState(hasMarks);
  const [fileName, setFileName] = useState(project.name);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>(0);

  const range = effectiveRange(project, useRange);
  const running = job?.status === 'running';

  useEffect(() => () => window.clearInterval(timer.current), []);

  const start = async () => {
    setError(null);
    try {
      const id = await startExport(project, resolution, useRange, fileName);
      setJob({ id, status: 'running', progress: 0, fileName, path: '' });
      timer.current = window.setInterval(async () => {
        try {
          const j = await getExport(id);
          setJob(j);
          if (j.status !== 'running') window.clearInterval(timer.current);
        } catch (err) {
          window.clearInterval(timer.current);
          setError((err as Error).message);
        }
      }, 400);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const cancel = async () => {
    if (job) await cancelExport(job.id);
    window.clearInterval(timer.current);
    setJob(null);
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal" role="dialog" aria-label="Exportar">
        <header>
          <h2>
            <IconExport /> Exportar MP4
          </h2>
          <button className="icon-btn" onClick={onClose} disabled={running} aria-label="Cerrar">
            <IconClose />
          </button>
        </header>

        <label className="field">
          <span className="field-label">Nombre del archivo</span>
          <input type="text" value={fileName} onChange={(e) => setFileName(e.target.value)} disabled={running} />
        </label>

        <fieldset className="segmented" disabled={running}>
          <legend>Resolución</legend>
          <label className={resolution === '1080p' ? 'on' : ''}>
            <input type="radio" name="res" checked={resolution === '1080p'} onChange={() => setResolution('1080p')} />
            1080p <small>1920×1080</small>
          </label>
          <label className={resolution === '4k' ? 'on' : ''}>
            <input type="radio" name="res" checked={resolution === '4k'} onChange={() => setResolution('4k')} />
            4K <small>3840×2160</small>
          </label>
        </fieldset>

        <fieldset className="segmented" disabled={running}>
          <legend>Qué exportar</legend>
          <label className={!useRange ? 'on' : ''}>
            <input type="radio" name="range" checked={!useRange} onChange={() => setUseRange(false)} />
            Todo el proyecto
          </label>
          <label className={useRange ? 'on' : ''} title={hasMarks ? '' : 'Marca la entrada con I y la salida con O en la línea de tiempo'}>
            <input type="radio" name="range" checked={useRange} disabled={!hasMarks} onChange={() => setUseRange(true)} />
            Tramo I → O
          </label>
        </fieldset>
        <p className="muted small">
          {formatTime(range.start, true)} → {formatTime(range.end, true)} · duración {((range.end - range.start) / 1e6).toFixed(2)} s · H.264 + AAC
        </p>

        {job && (
          <div className="progress-block">
            <div className="progress">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            <span>
              {job.status === 'running' && `Exportando… ${Math.round(job.progress * 100)} %`}
              {job.status === 'done' && 'Listo.'}
              {job.status === 'error' && 'La exportación falló.'}
            </span>
            {job.status === 'done' && <p className="muted small">Guardado también en: {job.path}</p>}
            {job.error && <pre className="error-log">{job.error}</pre>}
          </div>
        )}
        {error && <p className="error">{error}</p>}

        <footer>
          {running ? (
            <button className="btn" onClick={cancel}>
              Cancelar
            </button>
          ) : job?.status === 'done' ? (
            <a className="btn primary" href={downloadUrl(job.id)} download={job.fileName}>
              Descargar {job.fileName}
            </a>
          ) : (
            <button className="btn primary" onClick={start} disabled={range.end - range.start <= 0}>
              <IconExport /> Exportar
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
