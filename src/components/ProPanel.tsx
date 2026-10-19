import { useState } from 'react';
import type { Clip, MediaInfo, Track } from '../../shared/model.ts';
import { AUDIO_OPTIONS, estimateSeconds, formatEta, NO_PRO, PRO_LABELS, type ProJob, type ProOptions, type ProStatus, VIDEO_OPTIONS } from '../../shared/pro.ts';
import { IconCompare, IconSparkle } from './Icons.tsx';

export interface ProControls {
  status: ProStatus | null;
  /** The running or queued job of a clip, if any. */
  jobFor: (clipId: string) => ProJob | undefined;
  start: (clip: Clip, options: ProOptions, video: boolean, audio: boolean, voicePasses: number) => void;
  cancel: (jobId: string) => void;
  compare: (clipId: string) => void;
  revert: (clipId: string) => void;
}

const DEVICE: Record<string, string> = { mps: 'GPU del Mac (MPS)', cuda: 'GPU NVIDIA (CUDA)', cpu: 'CPU (lento)' };

/** "Mejoras Pro" section of the clip inspector: pick enhancements, run them, follow progress. */
export function ProPanel(props: { kind: 'video' | 'audio'; pro: ProControls; clip: Clip; track: Track; media: MediaInfo; locked: boolean }) {
  const { kind, pro, clip, track, media, locked } = props;
  const keys: (keyof ProOptions)[] = [...(kind === 'video' ? VIDEO_OPTIONS : AUDIO_OPTIONS)];
  const [opts, setOpts] = useState<ProOptions>(NO_PRO);
  const [passes, setPasses] = useState(1);
  const job = pro.jobFor(clip.id);
  const st = pro.status;

  const compound = media.kind === 'compound';
  const picture = track.kind === 'video' && media.has_video;
  const sound = media.has_audio && (track.kind === 'audio' || !clip.audio_detached);
  const why = (key: keyof ProOptions): string | null => {
    if (compound) return 'No disponible en composiciones: ábrela y aplícalo a sus clips.';
    if (locked) return 'La pista está bloqueada.';
    if ((VIDEO_OPTIONS as readonly string[]).includes(key) && !picture) return track.kind === 'audio' ? 'Solo para clips de vídeo.' : 'Este clip no tiene imagen.';
    if ((AUDIO_OPTIONS as readonly string[]).includes(key) && !sound)
      return clip.audio_detached ? 'El audio está separado: selecciona su clip de audio.' : 'Este clip no tiene audio.';
    return null;
  };
  // Only this tab's options; the other tab has its own.
  const chosen = Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v && keys.includes(k as keyof ProOptions) && !why(k as keyof ProOptions)])) as unknown as ProOptions;
  const any = Object.values(chosen).some(Boolean);
  const running = job && (job.status === 'running' || job.status === 'queued');
  const est = st ? estimateSeconds(st, chosen, clip.source.duration_us, 30, picture, sound, passes) : 0;
  const done = media.derived;

  return (
    <section className="insp-section pro">
      <h3>
        <span className="pro-title">
          <IconSparkle width={16} height={16} /> Mejoras Pro · {kind === 'video' ? 'imagen' : 'sonido'}
        </span>
        <span className="pro-local">{st?.device ? `Local · ${DEVICE[st.device] ?? st.device}` : 'Local'}</span>
      </h3>

      {!st ? (
        <p className="insp-note">Consultando el servidor…</p>
      ) : !st.installed ? (
        <p className="insp-note">{st.reason} Mientras tanto no se pueden aplicar.</p>
      ) : (
        <>
          <p className="insp-target">Se aplican al tramo de este clip y crean una copia mejorada; el original no se toca.</p>
          <div className="pro-options">
            {keys.map((key) => {
              const blocked = why(key);
              return (
                <label key={key} className={`pro-option${blocked ? ' blocked' : ''}${chosen[key] ? ' on' : ''}`} title={blocked ?? ''}>
                  <input type="checkbox" checked={chosen[key]} disabled={Boolean(blocked) || Boolean(running)} onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })} />
                  <span>
                    <strong>{PRO_LABELS[key].title}</strong>
                    <small>{blocked ?? PRO_LABELS[key].detail}</small>
                  </span>
                </label>
              );
            })}
            {chosen.voice && (
              <div className="pro-passes" role="group" aria-label="Pasadas de la IA de voz">
                <span title="Cada pasada de la IA sale distinta: con varias se queda la más fiel a lo que dijiste (tarda más)">Pasadas:</span>
                {[1, 3, 5].map((n) => (
                  <button key={n} className={`btn small${passes === n ? ' primary' : ''}`} disabled={Boolean(running)} onClick={() => setPasses(n)}>
                    {n}
                  </button>
                ))}
                <span>{passes > 1 ? `se queda la más fiel de ${passes}` : 'una sola'}</span>
              </div>
            )}
          </div>

          {running ? (
            <div className="progress-block">
              <div className="progress">
                <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
              <div className="pro-progress-line">
                <span>
                  {job.stage}… {Math.round(job.progress * 100)} %
                </span>
                <span className="muted">{job.status === 'queued' ? 'Esperando turno' : job.eta_s === null ? 'Calculando…' : `Quedan ~${formatEta(job.eta_s)}`}</span>
              </div>
              <p className="muted small">Puedes seguir editando; al terminar se cambia el clip por la versión mejorada (⌘Z lo deshace).</p>
              <button className="btn small" onClick={() => pro.cancel(job.id)}>
                Cancelar
              </button>
            </div>
          ) : (
            <>
              {job?.status === 'error' && <pre className="error-log">{job.error}</pre>}
              <button className="btn primary" disabled={!any} onClick={() => pro.start(clip, chosen, picture, sound, chosen.voice ? passes : 1)}>
                <IconSparkle /> Aplicar mejoras
              </button>
              {any && <p className="muted small">Tiempo estimado: ~{formatEta(est)} para {(clip.source.duration_us / 1e6).toFixed(1)} s de clip.</p>}
            </>
          )}

          {done && (
            <div className="pro-done">
              <p className="small">
                <strong>Versión mejorada:</strong> {(Object.keys(PRO_LABELS) as (keyof ProOptions)[]).filter((k) => done.options[k]).map((k) => PRO_LABELS[k].title.toLowerCase()).join(', ')}.
              </p>
              <div className="actions">
                <button className="btn" onClick={() => pro.compare(clip.id)}>
                  <IconCompare /> Comparar ANTES | DESPUÉS
                </button>
                {kind === 'audio' && done.voice && (
                  <button className="btn" onClick={() => pro.compare(clip.id)} title="Marca una palabra que suene robótica y usa ahí la versión natural">
                    <IconSparkle /> Arreglar una palabra{done.voice.fixes.length ? ` (${done.voice.fixes.length})` : ''}
                  </button>
                )}
                <button className="btn ghost small" onClick={() => pro.revert(clip.id)} disabled={locked}>
                  Volver al original
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
