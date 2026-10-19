import { useEffect, useRef, useState } from 'react';
import { formatTime, type MediaInfo } from '../../shared/model.ts';
import { formatEta, PRO_LABELS, type ProJob, type ProOptions, SUSPICIOUS_FACTOR, type VoiceFix } from '../../shared/pro.ts';
import { mediaUrl, waveUrl } from '../lib/api.ts';
import { IconClose, IconCompare, IconPause, IconPlay } from './Icons.tsx';

type Side = 'before' | 'after';

/** Word fixes: the job that applies them, and how to start it. */
export interface Fixer {
  job?: ProJob;
  apply: (fixes: VoiceFix[]) => void;
}

/**
 * ANTES | DESPUÉS: the original range and the enhanced copy side by side, in
 * sync. One side is heard at a time; switch with the buttons or A / D.
 * With a voice kit it also fixes words that came out robotic (palabra.py).
 */
export function ProCompare({ after, original, onClose, fixer }: { after: MediaInfo; original: MediaInfo; onClose: () => void; fixer?: Fixer }) {
  const derived = after.derived!;
  const offset = derived.start_us / 1e6;
  const duration = after.duration_us / 1e6;
  const picture = after.has_video;
  const hasSound = after.has_audio || original.has_audio;
  const beforeRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const afterRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [listen, setListen] = useState<Side>('after');
  /** Stop playback here (listening to one range). */
  const stopAt = useRef<number | null>(null);

  // The enhanced copy is the clock; the original follows it. Runs every frame,
  // and on the media's own time updates when frames are throttled (window in background).
  const syncRef = useRef(() => {});
  syncRef.current = () => {
    const a = afterRef.current;
    const b = beforeRef.current;
    if (!a || !b) return;
    const target = offset + a.currentTime;
    if (Math.abs(b.currentTime - target) > (a.paused ? 0.01 : 0.08)) b.currentTime = target;
    if (a.paused !== b.paused) void (a.paused ? b.pause() : b.play().catch(() => {}));
    setT(a.currentTime);
    if (stopAt.current !== null && a.currentTime >= stopAt.current && !a.paused) {
      a.pause();
      stopAt.current = null;
    }
    if (a.currentTime >= duration - 0.02 && !a.paused) a.pause();
  };
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      syncRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (beforeRef.current) beforeRef.current.muted = listen !== 'before';
    if (afterRef.current) afterRef.current.muted = listen !== 'after';
  }, [listen]);

  const toggle = () => {
    const a = afterRef.current;
    if (!a) return;
    stopAt.current = null;
    if (a.paused) {
      if (a.currentTime >= duration - 0.05) a.currentTime = 0;
      void a.play().catch(() => {});
    } else a.pause();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
      if (typing && e.code !== 'Escape') return;
      if (e.code === 'Escape') onClose();
      else if (e.code === 'Space') toggle();
      else if (e.code === 'KeyA') setListen('before');
      else if (e.code === 'KeyD') setListen('after');
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const pane = (side: Side) => {
    const m = side === 'before' ? original : after;
    const ref = side === 'before' ? beforeRef : afterRef;
    const common = {
      ref,
      src: mediaUrl(m.id),
      preload: 'auto',
      muted: listen !== side,
      onPlay: () => side === 'after' && setPlaying(true),
      onPause: () => side === 'after' && setPlaying(false),
      onTimeUpdate: () => side === 'after' && syncRef.current(),
      onSeeked: () => side === 'after' && syncRef.current(),
      onLoadedMetadata: (e: { currentTarget: HTMLMediaElement }) => {
        if (side === 'before') e.currentTarget.currentTime = offset;
      },
    };
    return (
      <div className={`cmp-pane${listen === side ? ' heard' : ''}`}>
        <div className="cmp-label">
          {side === 'before' ? 'ANTES' : 'DESPUÉS'}
          {hasSound && listen === side && <span className="cmp-heard">♪ se oye</span>}
        </div>
        {picture ? (
          <video {...common} playsInline onClick={toggle} />
        ) : (
          <div className="cmp-wave" onClick={toggle}>
            <img src={waveUrl(m.id)} alt="" style={side === 'before' ? waveCrop(offset, duration, original.duration_us / 1e6) : undefined} />
            <div className="cmp-wave-head" style={{ left: `${(t / duration) * 100}%` }} />
            <audio {...common} />
          </div>
        )}
      </div>
    );
  };

  const seek = (sec: number) => {
    if (afterRef.current) afterRef.current.currentTime = Math.max(0, Math.min(duration, sec));
  };
  const playRange = (a: number, b: number) => {
    const el = afterRef.current;
    if (!el) return;
    el.currentTime = a;
    stopAt.current = b;
    void el.play().catch(() => {});
  };

  const m = derived.measures;
  const opts = (Object.keys(PRO_LABELS) as (keyof ProOptions)[]).filter((k) => derived.options[k]);
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal compare" role="dialog" aria-label="Comparar antes y después">
        <header>
          <h2>
            <IconCompare /> ANTES | DESPUÉS
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <IconClose />
          </button>
        </header>
        <p className="muted small">
          {original.name} · {formatTime(derived.start_us, true)} → {formatTime(derived.start_us + derived.duration_us, true)} · {opts.map((k) => PRO_LABELS[k].title).join(' · ')}
        </p>

        <div className="cmp-panes">
          {pane('before')}
          {pane('after')}
        </div>

        <div className="cmp-transport">
          <button className="icon-btn play" onClick={toggle} aria-label={playing ? 'Pausar' : 'Reproducir'}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <input
            type="range"
            aria-label="Posición"
            min={0}
            max={duration}
            step={0.01}
            value={t}
            onChange={(e) => {
              if (afterRef.current) afterRef.current.currentTime = Number(e.target.value);
            }}
          />
          <span className="cmp-time">
            {formatTime(t * 1e6)} / {formatTime(duration * 1e6)}
          </span>
          {hasSound && (
            <div className="cmp-listen" role="group" aria-label="Qué se oye">
              <span className="muted small">Oír:</span>
              <button className={`btn small${listen === 'before' ? ' primary' : ''}`} onClick={() => setListen('before')}>
                Antes <kbd>A</kbd>
              </button>
              <button className={`btn small${listen === 'after' ? ' primary' : ''}`} onClick={() => setListen('after')}>
                Después <kbd>D</kbd>
              </button>
            </div>
          )}
        </div>

        {(m.loudness || m.flicker || m.whines || m.faces) && (
          <dl className="facts cmp-measures">
            {m.loudness && (
              <>
                <dt>Volumen integrado</dt>
                <dd>
                  {m.loudness.before.i.toFixed(1)} → <strong>{m.loudness.after.i.toFixed(1)} LUFS</strong>
                </dd>
                <dt>Pico real</dt>
                <dd>
                  {db(m.loudness.before.tp)} → <strong>{db(m.loudness.after.tp)} dBTP</strong>
                </dd>
                <dt>Rango de volumen</dt>
                <dd>
                  {m.loudness.before.lra.toFixed(1)} → <strong>{m.loudness.after.lra.toFixed(1)} LU</strong>
                </dd>
              </>
            )}
            {m.flicker && (
              <>
                <dt>Parpadeo (cambio medio de brillo por cuadro)</dt>
                <dd>
                  {m.flicker.before.toFixed(2)} → <strong>{m.flicker.after.toFixed(2)}</strong>
                </dd>
              </>
            )}
            {m.faces && (
              <>
                <dt>Cuadros con rostro mejorado</dt>
                <dd>
                  {m.faces.with_face} de {m.faces.frames}
                </dd>
              </>
            )}
            {m.whines && (
              <>
                <dt>Pitidos agudos eliminados</dt>
                <dd>{m.whines.map((w) => `${(w.hz / 1000).toFixed(2)} kHz`).join(', ')}</dd>
              </>
            )}
          </dl>
        )}

        {derived.voice && fixer && <WordFixer key={after.id} after={after} duration={duration} t={t} fixer={fixer} seek={seek} playRange={playRange} />}
      </div>
    </div>
  );
}

/** Seconds field: type freely, applied on Enter or when leaving it. */
function SecField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = Number(text.replace(',', '.'));
    setText(null);
    if (text.trim() !== '' && Number.isFinite(v)) onCommit(v);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={text ?? value.toFixed(2).replace('.', ',')}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setText(null);
      }}
    />
  );
}

const num = (v: number, decimals = 2) => v.toFixed(decimals).replace('.', ',');
const sec = (v: number) => `${v.toFixed(2).replace('.', ',')} s`;

/**
 * Fix words that came out robotic: mark a range and how much of Resemble's
 * clean-only (natural) version to use there. Re-rendered from the saved
 * voice kit in seconds, without running the model again.
 */
function WordFixer(props: { after: MediaInfo; duration: number; t: number; fixer: Fixer; seek: (s: number) => void; playRange: (a: number, b: number) => void }) {
  const { after, duration, t, fixer, seek, playRange } = props;
  const voice = after.derived!.voice!;
  const [fixes, setFixes] = useState<VoiceFix[]>(voice.fixes);
  const [draft, setDraft] = useState<{ start: number; end: number; mix: number }>({ start: 0, end: Math.min(duration, 0.5), mix: 1 });
  const job = fixer.job;
  const busy = job?.kind === 'fix' && (job.status === 'running' || job.status === 'queued');
  const pass = voice.passes[voice.chosen];
  const flagged = (score: number) => pass && score >= pass.distance * SUSPICIOUS_FACTOR;
  const changed = JSON.stringify(fixes) !== JSON.stringify(voice.fixes);
  const clampT = (v: number) => Math.round(Math.max(0, Math.min(duration, v)) * 100) / 100;
  const setStart = (v: number) => setDraft((d) => ({ ...d, start: clampT(v), end: Math.max(clampT(v) + 0.05, d.end) }));
  const setEnd = (v: number) => setDraft((d) => ({ ...d, end: clampT(Math.max(v, d.start + 0.05)) }));
  const pct = (v: number) => `${(v / duration) * 100}%`;

  return (
    <section className="word-fix">
      <h3>Arreglar palabras</h3>
      <p className="muted small">
        Si una palabra suena robótica, márcala y usa ahí la versión de <strong>solo limpieza</strong> (natural, sin agudos reconstruidos). Su volumen se iguala al de la versión mejorada y
        entra con fundidos de 60 ms.
      </p>

      {pass && (
        <p className="small">
          {voice.passes.length > 1 ? (
            <>
              Pasada elegida: <strong>{voice.chosen + 1} de {voice.passes.length}</strong>, la más fiel al original (distancia {num(pass.distance)}; las otras{' '}
              {voice.passes.filter((_, i) => i !== voice.chosen).map((p) => num(p.distance)).join(' · ')}).
            </>
          ) : (
            <>Distancia al original: {num(pass.distance)} (más baja = más fiel).</>
          )}
        </p>
      )}

      <div className="fix-strip" onClick={(e) => seek(((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth) * duration)} title="Clic para ir a ese momento">
        {fixes.map((f, i) => (
          <span key={i} className="fix-range" style={{ left: pct(f.start), width: pct(f.end - f.start) }} />
        ))}
        <span className="fix-range draft" style={{ left: pct(draft.start), width: pct(draft.end - draft.start) }} />
        {pass?.worst.map((w) => <span key={w.t} className={`fix-point${flagged(w.score) ? ' flagged' : ''}`} style={{ left: pct(w.t) }} />)}
        <span className="fix-head" style={{ left: pct(t) }} />
      </div>

      {pass && (
        <div className="fix-points">
          <span className="muted small">Momentos que más cambiaron:</span>
          {pass.worst.map((w) => (
            <button
              key={w.t}
              className={`btn small${flagged(w.score) ? ' warn-btn' : ''}`}
              title={flagged(w.score) ? 'Muy por encima de lo normal: posible sílaba deformada' : 'Dentro de lo normal'}
              onClick={() => {
                setDraft((d) => ({ ...d, start: clampT(w.t - 0.25), end: clampT(w.t + 0.25) }));
                playRange(clampT(w.t - 0.25), clampT(w.t + 0.25));
              }}
            >
              {sec(w.t)} · {num(w.score, 1)}
            </button>
          ))}
        </div>
      )}

      <div className="fix-draft">
        <label>
          Desde
          <SecField label="Inicio del tramo (s)" value={draft.start} onCommit={setStart} />
          <button className="btn small ghost" onClick={() => setStart(t)} title="Usar la posición actual">
            aquí
          </button>
        </label>
        <label>
          Hasta
          <SecField label="Fin del tramo (s)" value={draft.end} onCommit={setEnd} />
          <button className="btn small ghost" onClick={() => setEnd(t)} title="Usar la posición actual">
            aquí
          </button>
        </label>
        <label className="fix-mix">
          Versión natural {Math.round(draft.mix * 100)} %
          <input type="range" min={0} max={1} step={0.05} value={draft.mix} aria-label="Cuánto de la versión natural" onChange={(e) => setDraft((d) => ({ ...d, mix: Number(e.target.value) }))} />
        </label>
        <button className="btn small" onClick={() => playRange(draft.start, draft.end)}>
          <IconPlay width={14} height={14} /> Escuchar tramo
        </button>
        <button className="btn small" disabled={busy || draft.end - draft.start < 0.05} onClick={() => setFixes((list) => [...list, draft].sort((a, b) => a.start - b.start))}>
          Añadir tramo
        </button>
      </div>

      {fixes.length > 0 && (
        <ul className="fix-list">
          {fixes.map((f, i) => (
            <li key={i}>
              <span>
                {sec(f.start)} → {sec(f.end)} · {Math.round(f.mix * 100)} % natural
              </span>
              <button className="btn small ghost" onClick={() => playRange(f.start, f.end)}>
                Escuchar
              </button>
              <button className="btn small ghost" disabled={busy} onClick={() => setFixes((list) => list.filter((_, j) => j !== i))}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}

      {busy ? (
        <div className="progress-block">
          <div className="progress">
            <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <span className="small">
            {job.stage}… {job.eta_s ? `~${formatEta(job.eta_s)}` : ''}
          </span>
        </div>
      ) : (
        <div className="fix-actions">
          <button className="btn primary" disabled={!changed} onClick={() => fixer.apply(fixes)}>
            Aplicar arreglos
          </button>
          {job?.kind === 'fix' && job.status === 'error' && <span className="error small">{job.error}</span>}
          {!changed && voice.fixes.length > 0 && <span className="muted small">Aplicados {voice.fixes.length} tramo(s). Escúchalos con «Después».</span>}
        </div>
      )}
    </section>
  );
}

/** Show only the processed range of the original's full-length waveform. */
function waveCrop(offset: number, duration: number, total: number) {
  const scale = total / duration;
  return { width: `${scale * 100}%`, maxWidth: 'none', marginLeft: `${-(offset / duration) * 100}%` };
}
