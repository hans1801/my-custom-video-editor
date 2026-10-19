import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import {
  allClips,
  clamp,
  clipLocked,
  dbToPercent,
  findClip,
  formatTime,
  MAX_GAIN_DB,
  MAX_VOLUME_PERCENT,
  maxTransitionUs,
  MIN_GAIN_DB,
  MIN_TRANSITION_US,
  percentToDb,
  type Project,
  trackLabel,
  US_PER_S,
  mainTrack,
} from '../../shared/model.ts';
import { setClipProps, setClipTransform, setTransition } from '../../shared/ops.ts';
import { IDENTITY, isIdentity, MAX_CROP, MAX_SCALE, MIN_SCALE, type Transform } from '../../shared/transform.ts';
import {
  IconCompound,
  IconCrop,
  IconDetach,
  IconFilm,
  IconGroup,
  IconKeyboard,
  IconLink,
  IconLock,
  IconMix,
  IconMove,
  IconSpeaker,
  IconTrash,
  IconUnlink,
  IconWave,
} from './Icons.tsx';
import { type ProControls, ProPanel } from './ProPanel.tsx';
import type { Selection } from './Timeline.tsx';

interface Props {
  project: Project;
  selection: Selection;
  onSelect: (s: Selection) => void;
  preview: (p: Project) => void;
  apply: (p: Project, base?: Project) => void;
  onSeparateAudio: (clipId: string) => void;
  onUnlink: (clipId: string) => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onCompound: () => void;
  onDecompose: (clipId: string) => void;
  onOpenCompound: (clipId: string) => void;
  pro: ProControls;
}

/**
 * Editable number: type an exact value and press Enter (or leave the field).
 * Escape cancels; ↑/↓ change by one step. Accepts "," or "." as decimal mark.
 */
function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  unit: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.value.toFixed(props.decimals);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(',', '.').replace(/[^\d.+-]/g, ''));
    setDraft(null);
    if (draft.trim() !== '' && Number.isFinite(v)) props.onCommit(clamp(v, props.min, props.max));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setDraft(null);
      props.onCommit(clamp(props.value + (e.key === 'ArrowUp' ? props.step : -props.step), props.min, props.max));
    }
  };
  return (
    <span className="num-field">
      <input
        type="text"
        inputMode="decimal"
        disabled={props.disabled}
        aria-label={`${props.label} (${props.unit})`}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <span className="unit">{props.unit}</span>
    </span>
  );
}

/**
 * A slider and an exact-value field that stay in sync. Dragging the slider
 * previews and records one undo step on release; the field commits on Enter.
 * `toField` / `fromField` convert between the stored value and the field's unit.
 */
function EditControl(props: {
  label: ReactNode;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint?: string;
  field: { min: number; max: number; step: number; decimals: number; unit: string; toField: (v: number) => number; fromField: (f: number) => number };
  project: Project;
  edit: (base: Project, value: number) => Project;
  preview: (p: Project) => void;
  apply: (p: Project, base?: Project) => void;
  disabled?: boolean;
}) {
  const base = useRef<Project | null>(null);
  const last = useRef<Project | null>(null);
  const commitDrag = () => {
    if (base.current && last.current) props.apply(last.current, base.current);
    base.current = null;
    last.current = null;
  };
  return (
    <div className={`control${props.disabled ? ' disabled' : ''}`}>
      <div className="control-head">
        <label className="control-label">{props.label}</label>
        <NumberField
          label={props.ariaLabel}
          value={props.field.toField(props.value)}
          min={props.field.min}
          max={props.field.max}
          step={props.field.step}
          decimals={props.field.decimals}
          unit={props.field.unit}
          disabled={props.disabled}
          onCommit={(f) => props.apply(props.edit(props.project, props.field.fromField(f)))}
        />
      </div>
      <input
        type="range"
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onPointerDown={() => (base.current = props.project)}
        onPointerUp={commitDrag}
        onBlur={commitDrag}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (base.current) {
            last.current = props.edit(base.current, v);
            props.preview(last.current);
          } else {
            props.apply(props.edit(props.project, v));
          }
        }}
      />
      {props.hint && <span className="control-hint">{props.hint}</span>}
    </div>
  );
}

const seconds = { min: 0, step: 0.1, decimals: 2, unit: 's', toField: (us: number) => us / US_PER_S, fromField: (s: number) => Math.round(s * US_PER_S) };

export type InspectorTab = 'video' | 'audio';

export function Inspector(props: Props) {
  const { project, selection, onSelect, preview, apply, onSeparateAudio, onUnlink, onDelete } = props;
  const [tab, setTab] = useState<InspectorTab>('video');
  if (selection?.type === 'transition') {
    const clips = mainTrack(project).clips;
    const i = clips.findIndex((c) => c.id === selection.id);
    const t = clips[i]?.transition_out;
    if (!t || !clips[i + 1]) return <EmptyInspector project={project} />;
    const max = maxTransitionUs(clips[i], clips[i + 1]);
    return (
      <aside className="inspector">
        <div className="insp-kind video">
          <IconMix width={14} height={14} /> Transición · pista principal
        </div>
        <h2>Mix (fundido cruzado)</h2>
        <p className="muted small">Entre el clip {i + 1} y el {i + 2}. Afecta a la imagen y al sonido de los dos clips; el siguiente se adelanta lo que dura el fundido.</p>
        <section className="insp-section">
          <EditControl
            label="Duración"
            ariaLabel="Duración de la transición"
            value={t.duration_us}
            min={MIN_TRANSITION_US}
            max={max}
            step={1_000_000 / 30}
            hint={`Entre ${(MIN_TRANSITION_US / US_PER_S).toFixed(1)} y ${(max / US_PER_S).toFixed(2)} s (la mitad del clip más corto).`}
            field={{ ...seconds, min: MIN_TRANSITION_US / US_PER_S, max: max / US_PER_S, step: 0.1 }}
            project={project}
            edit={(b, v) => setTransition(b, selection.id, Math.round(v))}
            preview={preview}
            apply={apply}
          />
        </section>
        <button className="btn danger" onClick={() => apply(setTransition(project, selection.id, null))}>
          <IconTrash /> Quitar transición
        </button>
      </aside>
    );
  }

  const ids = selection?.type === 'clips' ? selection.ids : [];
  if (ids.length > 1) return <MultiInspector {...props} ids={ids} />;
  const found = ids.length === 1 ? findClip(project, ids[0]) : null;
  if (!found) return <EmptyInspector project={project} />;
  const { clip, track } = found;
  const media = project.media[clip.media];
  const d = clip.source.duration_us;
  const isVideo = track.kind === 'video';
  const embeddedAudio = isVideo && media.has_audio && !clip.audio_detached;
  const hasSound = embeddedAudio || !isVideo;
  const linkedVideo = clip.linked_to ? findClip(project, clip.linked_to) : null;
  const separated = isVideo && clip.audio_detached ? allClips(project).find((c) => c.linked_to === clip.id) : undefined;
  const separatedTrack = separated ? findClip(project, separated.id)?.track : undefined;
  const fadeMax = Math.min(d, 10 * US_PER_S);
  const locked = clipLocked(project, clip.id);
  const compound = media.kind === 'compound';

  const what = compound ? 'Composición' : isVideo ? 'Clip de vídeo' : 'Clip de audio';
  const kindLabel = `${what} · ${track.main ? 'pista principal' : trackLabel(project, track)}`;

  const picture = isVideo && (media.has_video || compound);
  const shown: InspectorTab = picture ? tab : 'audio';
  const t = clip.transform ?? IDENTITY;
  const editT = (b: Project, fn: (cur: Transform) => Transform) => setClipTransform(b, clip.id, fn(findClip(b, clip.id)?.clip.transform ?? IDENTITY));
  const pct100 = { min: 0, step: 1, decimals: 1, unit: '%', toField: (v: number) => v, fromField: (f: number) => f };
  const cropControl = (side: keyof Transform['crop'], label: string) => (
    <EditControl
      label={label}
      ariaLabel={`Recorte ${label.toLowerCase()}`}
      value={t.crop[side] * 100}
      min={0}
      max={MAX_CROP * 100}
      step={0.5}
      field={{ ...pct100, max: MAX_CROP * 100 }}
      project={project}
      edit={(b, v) => editT(b, (cur) => ({ ...cur, crop: { ...cur.crop, [side]: v / 100 } }))}
      preview={preview}
      apply={apply}
      disabled={locked}
    />
  );

  return (
    <aside className="inspector">
      <div className={`insp-kind ${compound ? 'compound' : track.kind}`}>
        {compound ? <IconCompound width={14} height={14} /> : isVideo ? <IconFilm width={14} height={14} /> : <IconWave width={14} height={14} />} {kindLabel}
      </div>
      <h2 title={media.name}>{media.name}</h2>
      {locked && (
        <p className="insp-locked">
          <IconLock width={14} height={14} /> Pista bloqueada: desbloquéala con el candado de su encabezado para editar este clip.
        </p>
      )}
      {clip.group_id && (
        <p className="insp-group">
          <IconGroup width={14} height={14} /> En un grupo: se selecciona y se mueve con los demás.
          <button className="btn small ghost" onClick={props.onUngroup}>Desagrupar</button>
        </p>
      )}
      <dl className="facts">
        <dt>En la línea de tiempo</dt>
        <dd>
          {formatTime(clip.timeline_start_us, true)} → {formatTime(clip.timeline_start_us + d, true)}
        </dd>
        <dt>Del archivo</dt>
        <dd>
          {formatTime(clip.source.start_us, true)} → {formatTime(clip.source.start_us + d, true)}
        </dd>
        <dt>Duración</dt>
        <dd>{(d / US_PER_S).toFixed(2)} s</dd>
      </dl>

      <div className="insp-tabs" role="tablist" aria-label="Edición del clip">
        <button
          role="tab"
          aria-selected={shown === 'video'}
          className={`insp-tab video${shown === 'video' ? ' on' : ''}`}
          disabled={!picture}
          title={picture ? 'Imagen: posición, escala, recorte y mejoras de imagen' : 'Este clip no tiene imagen'}
          onClick={() => setTab('video')}
        >
          <IconFilm width={15} height={15} /> Vídeo
        </button>
        <button
          role="tab"
          aria-selected={shown === 'audio'}
          className={`insp-tab audio${shown === 'audio' ? ' on' : ''}`}
          title="Sonido: volumen, fundidos y mejoras de voz"
          onClick={() => setTab('audio')}
        >
          <IconSpeaker width={15} height={15} /> Audio
        </button>
      </div>

      {shown === 'video' ? (
        <div role="tabpanel" aria-label="Vídeo">
          <section className="insp-section video">
            <h3>
              <IconMove width={16} height={16} /> Posición y escala
            </h3>
            <p className="insp-target">También puedes arrastrar el clip en la vista previa, y sus esquinas para cambiar la escala.</p>
            <EditControl
              label="Posición horizontal"
              ariaLabel="Posición horizontal"
              value={t.x * 100}
              min={-100}
              max={100}
              step={0.5}
              hint="0 % = centrado · 100 % = un ancho del lienzo"
              field={{ ...pct100, min: -200, max: 200 }}
              project={project}
              edit={(b, v) => editT(b, (cur) => ({ ...cur, x: v / 100 }))}
              preview={preview}
              apply={apply}
              disabled={locked}
            />
            <EditControl
              label="Posición vertical"
              ariaLabel="Posición vertical"
              value={t.y * 100}
              min={-100}
              max={100}
              step={0.5}
              field={{ ...pct100, min: -200, max: 200 }}
              project={project}
              edit={(b, v) => editT(b, (cur) => ({ ...cur, y: v / 100 }))}
              preview={preview}
              apply={apply}
              disabled={locked}
            />
            <EditControl
              label="Escala"
              ariaLabel="Escala"
              value={t.scale * 100}
              min={MIN_SCALE * 100}
              max={MAX_SCALE * 100}
              step={1}
              hint="100 % = ajustado al lienzo"
              field={{ ...pct100, decimals: 0, min: MIN_SCALE * 100, max: MAX_SCALE * 100 }}
              project={project}
              edit={(b, v) => editT(b, (cur) => ({ ...cur, scale: v / 100 }))}
              preview={preview}
              apply={apply}
              disabled={locked}
            />
          </section>

          <section className="insp-section video">
            <h3>
              <IconCrop width={16} height={16} /> Recortar
            </h3>
            <p className="insp-target">Oculta los bordes de la imagen sin moverla; debajo se ven las otras pistas.</p>
            <div className="crop-grid">
              {cropControl('left', 'Izquierda')}
              {cropControl('right', 'Derecha')}
              {cropControl('top', 'Arriba')}
              {cropControl('bottom', 'Abajo')}
            </div>
          </section>

          <button className="btn small ghost reset-transform" onClick={() => apply(setClipTransform(project, clip.id, IDENTITY))} disabled={locked || isIdentity(clip.transform)}>
            Restablecer posición, escala y recorte
          </button>

          <ProPanel key={`${clip.id}-video`} kind="video" pro={props.pro} clip={clip} track={track} media={media} locked={locked} />
        </div>
      ) : (
        <div role="tabpanel" aria-label="Audio">
          <section className="insp-section audio">
            <h3>
              <IconSpeaker width={16} height={16} /> Edición de audio
            </h3>
            {hasSound && (
              <p className="insp-target">
                {compound
                  ? 'Afecta a todo el sonido de la composición; cada clip interior conserva su propio volumen.'
                  : isVideo
                  ? 'Afecta solo al sonido original de este clip de vídeo; la imagen no cambia.'
                  : linkedVideo
                    ? `Audio separado de «${project.media[linkedVideo.clip.media]?.name ?? 'vídeo'}».`
                    : 'Afecta a este clip de audio.'}
              </p>
            )}
            {hasSound ? (
              <>
                <EditControl
                  label="Volumen"
                  ariaLabel="Volumen del audio"
                  value={clip.gain_db}
                  min={MIN_GAIN_DB}
                  max={MAX_GAIN_DB}
                  step={0.5}
                  hint={clip.gain_db <= MIN_GAIN_DB ? 'Silenciado' : `${clip.gain_db > 0 ? '+' : ''}${clip.gain_db.toFixed(1)} dB · 100 % = nivel original`}
                  field={{ min: 0, max: MAX_VOLUME_PERCENT, step: 5, decimals: 0, unit: '%', toField: dbToPercent, fromField: percentToDb }}
                  project={project}
                  edit={(b, v) => setClipProps(b, clip.id, { gain_db: v })}
                  preview={preview}
                  apply={apply}
                  disabled={locked}
                />
                <EditControl
                  label="Fundido de entrada del audio"
                  ariaLabel="Fundido de entrada del audio"
                  value={clip.fade_in_us}
                  min={0}
                  max={fadeMax}
                  step={100_000}
                  field={{ ...seconds, max: Math.max(0, d - clip.fade_out_us) / US_PER_S }}
                  project={project}
                  edit={(b, v) => setClipProps(b, clip.id, { fade_in_us: v })}
                  preview={preview}
                  apply={apply}
                  disabled={locked}
                />
                <EditControl
                  label="Fundido de salida del audio"
                  ariaLabel="Fundido de salida del audio"
                  value={clip.fade_out_us}
                  min={0}
                  max={fadeMax}
                  step={100_000}
                  field={{ ...seconds, max: Math.max(0, d - clip.fade_in_us) / US_PER_S }}
                  project={project}
                  edit={(b, v) => setClipProps(b, clip.id, { fade_out_us: v })}
                  preview={preview}
                  apply={apply}
                  disabled={locked}
                />
              </>
            ) : clip.audio_detached ? (
              <div className="insp-note">
                <p>
                  El sonido de este clip está separado en {separatedTrack ? `la pista «${trackLabel(project, separatedTrack)}»` : 'una pista de audio'}. Edita su volumen y fundidos allí.
                </p>
                {separated && (
                  <button className="btn small" onClick={() => onSelect({ type: 'clips', ids: [separated.id] })}>
                    <IconWave /> Seleccionar el audio separado
                  </button>
                )}
              </div>
            ) : (
              <p className="insp-note">Este vídeo no tiene audio.</p>
            )}
            {(embeddedAudio && !compound) || clip.linked_to || linkedVideo ? (
              <div className="actions audio-actions">
                {embeddedAudio && !compound && (
                  <button className="btn" onClick={() => onSeparateAudio(clip.id)}>
                    <IconDetach /> Separar audio <kbd>⇧A</kbd>
                  </button>
                )}
                {clip.linked_to && (
                  <>
                    <p className="muted small">
                      <IconLink width={14} height={14} /> Enlazado a su vídeo: lo sigue al moverlo, cortarlo o recortarlo.
                    </p>
                    <button className="btn" onClick={() => onUnlink(clip.id)}>
                      <IconUnlink /> Desenlazar del vídeo
                    </button>
                  </>
                )}
                {linkedVideo && (
                  <button className="btn ghost small" onClick={() => onSelect({ type: 'clips', ids: [linkedVideo.clip.id] })}>
                    <IconFilm /> Seleccionar su vídeo
                  </button>
                )}
              </div>
            ) : null}
          </section>

          <ProPanel key={`${clip.id}-audio`} kind="audio" pro={props.pro} clip={clip} track={track} media={media} locked={locked} />
        </div>
      )}

      <section className="insp-section">
        <h3>Acciones</h3>
        <div className="actions">
          {compound && (
            <>
              <button className="btn" onClick={() => props.onOpenCompound(clip.id)}>
                <IconCompound /> Abrir composición <kbd>doble clic</kbd>
              </button>
              <button className="btn" onClick={() => props.onDecompose(clip.id)} disabled={locked}>
                <IconCompound /> Descomponer
              </button>
            </>
          )}
          {!compound && (
            <button className="btn" onClick={props.onCompound} disabled={locked}>
              <IconCompound /> Crear composición <kbd>⌥⌘G</kbd>
            </button>
          )}
          <button className="btn danger" onClick={onDelete} disabled={locked}>
            <IconTrash /> Borrar del timeline <kbd>⌫</kbd>
          </button>
        </div>
      </section>
    </aside>
  );
}

function MultiInspector(props: Props & { ids: string[] }) {
  const { project, ids } = props;
  const clips = ids.map((id) => findClip(project, id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
  const videos = clips.filter((f) => f.track.kind === 'video').length;
  const audios = clips.length - videos;
  const groups = new Set(clips.map((f) => f.clip.group_id).filter(Boolean));
  const oneGroup = groups.size === 1 && clips.every((f) => f.clip.group_id);
  const locked = clips.filter((f) => clipLocked(project, f.clip.id)).length;
  const start = Math.min(...clips.map((f) => f.clip.timeline_start_us));
  const end = Math.max(...clips.map((f) => f.clip.timeline_start_us + f.clip.source.duration_us));
  return (
    <aside className="inspector">
      <div className="insp-kind multi">
        {oneGroup ? <IconGroup width={14} height={14} /> : <IconFilm width={14} height={14} />} {oneGroup ? 'Grupo' : 'Selección múltiple'}
      </div>
      <h2>{clips.length} clips seleccionados</h2>
      <dl className="facts">
        <dt>Contenido</dt>
        <dd>
          {videos} de vídeo · {audios} de audio
        </dd>
        <dt>Abarca</dt>
        <dd>
          {formatTime(start, true)} → {formatTime(end, true)}
        </dd>
      </dl>
      {locked > 0 && (
        <p className="insp-locked">
          <IconLock width={14} height={14} /> {locked} en pistas bloqueadas: no se moverán ni se borrarán.
        </p>
      )}
      <p className="muted small">Arrastra cualquiera de ellos para moverlos juntos. Shift o ⌘/Ctrl + clic añade o quita clips.</p>
      <section className="insp-section">
        <h3>Organizar</h3>
        <div className="actions">
          {!oneGroup && (
            <button className="btn" onClick={props.onGroup}>
              <IconGroup /> Agrupar <kbd>⌘G</kbd>
            </button>
          )}
          {groups.size > 0 && (
            <button className="btn" onClick={props.onUngroup}>
              <IconGroup /> Desagrupar <kbd>⇧⌘G</kbd>
            </button>
          )}
          <button className="btn" onClick={props.onCompound}>
            <IconCompound /> Crear composición <kbd>⌥⌘G</kbd>
          </button>
          <p className="muted small explain">
            <strong>Agrupar</strong> mantiene los clips en sus pistas y los mueve juntos. <strong>Composición</strong> los encierra en un único clip editable por dentro.
          </p>
          <button className="btn danger" onClick={props.onDelete}>
            <IconTrash /> Borrar selección <kbd>⌫</kbd>
          </button>
        </div>
      </section>
    </aside>
  );
}

function EmptyInspector({ project }: { project: Project }) {
  const { in_us, out_us } = project.range;
  return (
    <aside className="inspector">
      <h2>Propiedades</h2>
      <p className="muted">Selecciona un clip o una transición para editarlo.</p>
      <dl className="facts">
        <dt>Tramo de exportación</dt>
        <dd>{in_us === null && out_us === null ? 'Todo el proyecto' : `${formatTime(in_us ?? 0, true)} → ${out_us === null ? 'final' : formatTime(out_us, true)}`}</dd>
      </dl>
      <h3 className="plain">
        <IconKeyboard /> Atajos
      </h3>
      <ul className="shortcuts">
        <li><kbd>Espacio</kbd> Reproducir / pausar</li>
        <li><kbd>S</kbd> Cortar en el cabezal</li>
        <li><kbd>⌫</kbd> Borrar selección</li>
        <li><kbd>⇧A</kbd> Separar audio</li>
        <li><kbd>T</kbd> Transición Mix tras el clip</li>
        <li><kbd>N</kbd> Activar / desactivar ajuste magnético</li>
        <li>Arrastrar en vacío: selección por rectángulo · <kbd>⇧</kbd>/<kbd>⌘</kbd> + clic: añadir</li>
        <li><kbd>⌘A</kbd> Seleccionar todo · <kbd>⌘G</kbd> Agrupar · <kbd>⇧⌘G</kbd> Desagrupar</li>
        <li><kbd>⌥⌘G</kbd> Crear composición · doble clic para abrirla · <kbd>Esc</kbd> salir</li>
        <li><kbd>I</kbd> / <kbd>O</kbd> Marcar entrada / salida · <kbd>X</kbd> quitar</li>
        <li><kbd>←</kbd> <kbd>→</kbd> Fotograma (<kbd>⇧</kbd> 1 s)</li>
        <li><kbd>+</kbd> / <kbd>−</kbd> o <kbd>⌘</kbd> + rueda: zoom</li>
        <li><kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> Deshacer / rehacer</li>
        <li><kbd>⌘S</kbd> Guardar · <kbd>⌘O</kbd> Abrir · <kbd>⌘E</kbd> Exportar</li>
        <li>Clic derecho en un clip: más acciones</li>
      </ul>
      <p className="muted small">
        La pista <strong>Principal</strong> es magnética: al insertar, borrar o recortar, los clips siguientes se desplazan para no dejar huecos. Cada clip de otra pista va asociado al clip principal con el que más se solapa y se desplaza con él. Los que no tocan ninguno son independientes.
      </p>
    </aside>
  );
}

