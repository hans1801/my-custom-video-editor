import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  allClips,
  type Clip,
  clipEnd,
  clipLocked,
  findClip,
  formatTime,
  mainTrack,
  type Project,
  projectDuration,
  pruneEmptyTracks,
  snapToFrame,
  type Track,
  type TrackKind,
  trackLabel,
  US_PER_S,
  type Us,
} from '../../shared/model.ts';
import { expandSelection, type MoveTarget, moveSet, trimClip } from '../../shared/ops.ts';
import { thumbUrl, waveUrl } from '../lib/api.ts';
import { playhead, usePlayhead } from '../lib/playhead.ts';
import { SNAP_PX, snapPoints, snapShift } from '../lib/snap.ts';
import {
  IconCompound,
  IconDetach,
  IconEye,
  IconEyeOff,
  IconFilm,
  IconGroup,
  IconLink,
  IconLock,
  IconMagnet,
  IconMix,
  IconPlus,
  IconSpeaker,
  IconSpeakerOff,
  IconUnlock,
  IconWave,
} from './Icons.tsx';

/** Selected clips (one or many) or one Mix transition (by the id of the clip before it). */
export type Selection = { type: 'clips'; ids: string[] } | { type: 'transition'; id: string } | null;

export const selectedClipIds = (s: Selection): string[] => (s?.type === 'clips' ? s.ids : []);

/** Where something dropped from outside the timeline (media bin, file system) should land. */
export interface DropSpot {
  t: Us;
  /** Insertion index on the main track for the pointer time. */
  mainIndex: number;
  trackId?: string;
  newTrack?: TrackKind;
}

export type TrackFlag = 'locked' | 'hidden' | 'muted';

export const MEDIA_DRAG_TYPE = 'application/x-myeditor-media';
const RULER_H = 28;
const MAIN_H = 72;
const OVERLAY_H = 58;
const LANE_H = 44;
const NEW_ZONE_H = 24;
const HEAD_W = 172;
const TAIL_S = 20; // empty space after the last clip
export const MIN_PPS = 4;
export const MAX_PPS = 400;

interface Props {
  project: Project;
  selection: Selection;
  onSelect: (s: Selection) => void;
  pps: number;
  setPps: (pps: number) => void;
  playing: boolean;
  snapping: boolean;
  preview: (p: Project) => void;
  apply: (p: Project, base?: Project) => void;
  onAddTransition: (videoClipId: string) => void;
  onDropMedia: (mediaId: string, spot: DropSpot) => void;
  onDropFiles: (files: File[], spot: DropSpot) => void;
  onContextMenu: (clipId: string, x: number, y: number) => void;
  onOpenCompound: (clipId: string) => void;
  onTrackFlag: (trackId: string, flag: TrackFlag, value: boolean) => void;
  notify: (msg: string) => void;
}

interface Row {
  key: string;
  type: 'track' | 'new-video' | 'new-audio';
  track?: Track;
  top: number;
  height: number;
  lanes: Map<string, number>;
}

/** Overlapping clips on one track (only separated audio can overlap) get their own lane. */
function lanesOf(clips: Clip[]): { lanes: Map<string, number>; count: number } {
  const ends: Us[] = [];
  const lanes = new Map<string, number>();
  for (const c of clips) {
    let lane = ends.findIndex((end) => end <= c.timeline_start_us);
    if (lane < 0) lane = ends.length;
    ends[lane] = clipEnd(c);
    lanes.set(c.id, lane);
  }
  return { lanes, count: Math.max(1, ends.length) };
}

function layoutRows(p: Project): { rows: Row[]; height: number } {
  const rows: Row[] = [];
  let top = 0;
  const push = (row: Omit<Row, 'top'>) => {
    rows.push({ ...row, top });
    top += row.height;
  };
  push({ key: 'new-video', type: 'new-video', height: NEW_ZONE_H, lanes: new Map() });
  for (const track of p.tracks) {
    const { lanes, count } = lanesOf(track.clips);
    const height = track.main ? MAIN_H : track.kind === 'video' ? OVERLAY_H : count * LANE_H + 8;
    push({ key: track.id, type: 'track', track, height, lanes });
  }
  push({ key: 'new-audio', type: 'new-audio', height: NEW_ZONE_H, lanes: new Map() });
  return { rows, height: top };
}

/** Vertical extent of a clip inside the rows area. */
function clipBox(row: Row, c: Clip): { y0: number; y1: number } {
  if (row.track!.kind === 'video') return { y0: row.top + 6, y1: row.top + row.height - 6 };
  const y0 = row.top + 4 + (row.lanes.get(c.id) ?? 0) * LANE_H;
  return { y0, y1: y0 + LANE_H - 6 };
}

function rulerStep(pps: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * pps >= 80) ?? 600;
}

/** Main-track insertion index for a pointer time, ignoring `excludeId`. */
function mainIndexAt(p: Project, t: Us, excludeId?: string): number {
  return mainTrack(p).clips.filter((c) => c.id !== excludeId && c.timeline_start_us + c.source.duration_us / 2 < t).length;
}

/** A clip and the members of its group: what a click selects. */
function unitOf(p: Project, clipId: string): string[] {
  const c = findClip(p, clipId)?.clip;
  if (!c?.group_id) return [clipId];
  return allClips(p).filter((x) => x.group_id === c.group_id).map((x) => x.id);
}

interface DragGhost {
  left: number;
  top: number;
  width: number;
  height: number;
  valid: boolean;
}

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function Timeline(props: Props) {
  const { project, selection, onSelect, pps, setPps, playing, snapping, preview, apply } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ t: number; x: number } | null>(null);
  const [guide, setGuide] = useState<Us | null>(null);
  const [ghost, setGhost] = useState<DragGhost | null>(null);
  const [dragging, setDragging] = useState<Set<string>>(new Set());
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);

  const duration = projectDuration(project);
  const width = Math.max((duration / US_PER_S + TAIL_S) * pps, 600);
  const xOf = (t: Us) => (t / US_PER_S) * pps;
  const { rows, height: rowsHeight } = useMemo(() => layoutRows(project), [project]);
  const thresholdUs = (SNAP_PX / pps) * US_PER_S;
  const selected = useMemo(() => new Set(selectedClipIds(selection)), [selection]);

  /** Pointer → timeline time, position inside the rows area, and the row under it. */
  const pointer = (clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left + el.scrollLeft;
    const y = clientY - r.top + el.scrollTop - RULER_H;
    return { x, y, t: Math.max(0, (x / pps) * US_PER_S), row: rows.find((row) => y >= row.top && y < row.top + row.height) ?? (y < 0 ? rows[0] : rows[rows.length - 1]) };
  };

  // ---- Zoom (Ctrl/Cmd + wheel) keeps the time under the cursor in place.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const x = e.clientX - el.getBoundingClientRect().left;
      zoomAnchor.current = { t: ((x + el.scrollLeft) / pps) * US_PER_S, x };
      setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, pps * Math.exp(-e.deltaY * 0.01))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pps, setPps]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = zoomAnchor.current ?? { t: playhead.get(), x: el.clientWidth / 2 };
    zoomAnchor.current = null;
    el.scrollLeft = Math.max(0, (anchor.t / US_PER_S) * pps - anchor.x);
  }, [pps]);

  // Track headers scroll vertically with the tracks.
  const syncHeads = () => {
    if (headsRef.current && scrollRef.current) headsRef.current.style.transform = `translateY(${-scrollRef.current.scrollTop}px)`;
  };

  // ---- Follow the playhead while playing.
  useEffect(() => {
    if (!playing) return;
    return playhead.subscribe(() => {
      const el = scrollRef.current;
      if (!el) return;
      const x = (playhead.get() / US_PER_S) * pps;
      if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = x - 80;
    });
  }, [playing, pps]);

  // ---- Generic pointer drag helper (window listeners so the drag survives leaving the element).
  const drag = (e: ReactPointerEvent, onMove: (ev: PointerEvent, dxPx: number) => void, onEnd: (moved: boolean, ev: PointerEvent) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) moved = true;
      if (!moved) return;
      // Scroll when dragging near the left/right edge.
      const el = scrollRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (ev.clientX > r.right - 30) el.scrollLeft += 12;
        else if (ev.clientX < r.left + 30) el.scrollLeft -= 12;
      }
      onMove(ev, ev.clientX - startX);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd(moved, ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const seekTo = (t: Us, points: Us[]) => {
    if (snapping) {
      const s = snapShift([t], points, thresholdUs);
      t += s.shift;
      setGuide(s.at);
    }
    playhead.set(snapToFrame(project, t));
  };

  // ---- Playhead scrub on the ruler (snaps to clip edges and marks when snapping is on).
  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const points = snapping ? snapPoints(project, new Set(), false) : [];
    seekTo(pointer(e.clientX, 0).t, points);
    drag(e, (ev) => seekTo(pointer(ev.clientX, 0).t, points), () => setGuide(null));
  };

  // ---- Marquee selection on empty space; a plain click there moves the playhead.
  const startMarquee = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const initial = additive ? selectedClipIds(selection) : [];
    const p0 = pointer(e.clientX, e.clientY);
    const hits = (m: Marquee): string[] => {
      const x0 = Math.min(m.x0, m.x1);
      const x1 = Math.max(m.x0, m.x1);
      const y0 = Math.min(m.y0, m.y1);
      const y1 = Math.max(m.y0, m.y1);
      const ids = new Set(initial);
      for (const row of rows) {
        if (row.type !== 'track' || row.track!.locked) continue;
        for (const c of row.track!.clips) {
          const b = clipBox(row, c);
          if (xOf(c.timeline_start_us) < x1 && xOf(clipEnd(c)) > x0 && b.y0 < y1 && b.y1 > y0) for (const id of unitOf(project, c.id)) ids.add(id);
        }
      }
      return [...ids];
    };
    drag(
      e,
      (ev) => {
        const p1 = pointer(ev.clientX, ev.clientY);
        const m = { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
        setMarquee(m);
        const ids = hits(m);
        onSelect(ids.length ? { type: 'clips', ids } : null);
      },
      (moved) => {
        setMarquee(null);
        if (moved || additive) return;
        onSelect(null);
        seekTo(p0.t, snapping ? snapPoints(project, new Set(), false) : []);
        setGuide(null);
      },
    );
  };

  /** Ids that move together with a clip (its separated audio, or its video). */
  const companions = (ids: Iterable<string>): Set<string> => expandSelection(project, ids);

  // ---- Trim by dragging an edge.
  const startTrim = (e: ReactPointerEvent, clip: Clip, edge: 'start' | 'end', track: Track) => {
    if (e.button !== 0) return;
    if (clipLocked(project, clip.id)) return;
    const base = project;
    let last = base;
    onSelect({ type: 'clips', ids: [clip.id] });
    const points = snapping ? snapPoints(base, companions([clip.id]), true) : [];
    // The left edge of a main-track clip doesn't move on screen (the content slides), so it doesn't snap.
    const edgeMoves = edge === 'end' || !(track.main || (clip.linked_to && findClip(base, clip.linked_to)?.track.main));
    drag(
      e,
      (_ev, dx) => {
        let delta = (dx / pps) * US_PER_S;
        if (snapping && edgeMoves) {
          const edgeT = edge === 'start' ? clip.timeline_start_us : clipEnd(clip);
          const s = snapShift([edgeT + delta], points, thresholdUs);
          delta += s.shift;
          setGuide(s.at);
        }
        last = trimClip(base, clip.id, edge, snapToFrame(base, delta));
        preview(last);
      },
      (moved) => {
        setGuide(null);
        if (moved) apply(last, base);
      },
    );
  };

  // ---- Click / drag a clip: select (Shift or ⌘/Ctrl adds or removes), then move the whole selection.
  const startMove = (e: ReactPointerEvent, clip: Clip, track: Track) => {
    if (e.button !== 0) return;
    const unit = unitOf(project, clip.id);
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.stopPropagation();
      e.preventDefault();
      const ids = new Set(selectedClipIds(selection));
      const on = unit.every((id) => ids.has(id));
      for (const id of unit) on ? ids.delete(id) : ids.add(id);
      onSelect(ids.size ? { type: 'clips', ids: [...ids] } : null);
      return;
    }
    const moving = selected.has(clip.id) && selected.size > 1 ? [...selected] : unit;
    if (!selected.has(clip.id) || selected.size <= 1) onSelect({ type: 'clips', ids: unit });
    const base = project;
    const set = companions(moving);
    const lockedSet = [...set].some((id) => clipLocked(base, id));
    let last = base;
    let valid = true;
    const grabUs = pointer(e.clientX, e.clientY).t - clip.timeline_start_us;
    const points = snapping ? snapPoints(base, set, true) : [];
    const baseRows = layoutRows(base).rows;
    drag(
      e,
      (ev) => {
        setDragging(set);
        const { t, row } = pointer(ev.clientX, ev.clientY);
        let start = Math.max(0, t - grabUs);
        let target: MoveTarget | null = null;
        const rowKind: TrackKind | null = row.type === 'new-video' ? 'video' : row.type === 'new-audio' ? 'audio' : row.track!.kind;
        valid = !lockedSet && rowKind === track.kind && !(clip.linked_to && row.track?.main) && !row.track?.locked;
        if (valid) {
          const freeTarget = row.type !== 'track' || !row.track!.main;
          if (snapping && freeTarget && !clip.linked_to) {
            const s = snapShift([start, start + clip.source.duration_us], points, thresholdUs);
            start = Math.max(0, start + s.shift);
            setGuide(s.at);
          } else setGuide(null);
          if (row.type === 'new-video' || row.type === 'new-audio') target = { kind: 'new-track', trackKind: rowKind!, at: start };
          else if (row.track!.main) target = { kind: 'main', index: mainIndexAt(base, t, clip.id), at: t };
          else target = { kind: 'track', trackId: row.track!.id, at: start };
        } else setGuide(null);
        last = target ? moveSet(base, moving, clip.id, target) : base;
        // Show the result live (main-track ripple, new position) unless the move
        // adds a track: then only the ghost moves, so rows don't jump under the pointer.
        preview(last.tracks.length === base.tracks.length ? last : base);
        const ghostRow = baseRows.find((r) => r.key === row.key) ?? row;
        setGhost({
          left: xOf(clip.linked_to ? clip.timeline_start_us : start),
          top: ghostRow.top + 4,
          width: Math.max(8, xOf(clip.source.duration_us)),
          height: Math.max(16, Math.min(ghostRow.height - 8, 40)),
          valid,
        });
      },
      (moved) => {
        setGhost(null);
        setGuide(null);
        setDragging(new Set());
        if (!moved) return;
        if (valid && last !== base) apply(pruneEmptyTracks(last), base);
        else {
          preview(base);
          if (lockedSet) props.notify('Hay clips en una pista bloqueada: desbloquéala para moverlos.');
          else if (!valid)
            props.notify(
              track.kind === 'video' ? 'Los clips de vídeo van en pistas de vídeo desbloqueadas.' : clip.linked_to ? 'El audio separado sigue a su vídeo: desenlázalo para moverlo en el tiempo.' : 'Los clips de audio van en pistas de audio desbloqueadas.',
            );
        }
      },
    );
  };

  // ---- Drop from the media bin or from the file system.
  const spotFor = (clientX: number, clientY: number): DropSpot => {
    const { t, row } = pointer(clientX, clientY);
    const spot: DropSpot = { t, mainIndex: mainIndexAt(project, t) };
    if (row.type === 'new-video') spot.newTrack = 'video';
    else if (row.type === 'new-audio') spot.newTrack = 'audio';
    else spot.trackId = row.track!.id;
    return spot;
  };
  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE) && !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDropRow(pointer(e.clientX, e.clientY).row.key);
    },
    onDragLeave: () => setDropRow(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropRow(null);
      const spot = spotFor(e.clientX, e.clientY);
      const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
      if (mediaId) props.onDropMedia(mediaId, spot);
      else if (e.dataTransfer.files.length) props.onDropFiles([...e.dataTransfer.files], spot);
    },
  };

  const waveStyle = (c: Clip): CSSProperties => {
    const media = project.media[c.media];
    return media?.has_audio && media.kind !== 'compound'
      ? { backgroundImage: `url(${waveUrl(c.media)})`, backgroundSize: `${xOf(media.duration_us)}px 100%`, backgroundPositionX: -xOf(c.source.start_us) }
      : {};
  };

  const fades = (c: Clip) => (
    <>
      {c.fade_in_us > 0 && <div className="clip-fade fade-in" style={{ width: xOf(c.fade_in_us) }} />}
      {c.fade_out_us > 0 && <div className="clip-fade fade-out" style={{ width: xOf(c.fade_out_us) }} />}
    </>
  );

  const renderClip = (c: Clip, r: Row) => {
    const track = r.track!;
    const media = project.media[c.media];
    const isVideo = track.kind === 'video';
    const compound = media?.kind === 'compound';
    const box = clipBox(r, c);
    const style: CSSProperties = { left: xOf(c.timeline_start_us), width: Math.max(2, xOf(c.source.duration_us)) };
    if (!isVideo) {
      style.top = box.y0 - r.top;
      style.height = box.y1 - box.y0;
    }
    const embeddedAudio = isVideo && media?.has_audio && !c.audio_detached;
    const classes = [
      'clip',
      `clip-${track.kind}`,
      track.main && 'clip-main',
      c.linked_to && 'clip-linked',
      compound && 'clip-compound',
      c.group_id && 'grouped',
      selected.has(c.id) && 'selected',
      dragging.has(c.id) && 'dragging',
    ].filter(Boolean);
    return (
      <div
        key={c.id}
        className={classes.join(' ')}
        style={style}
        onPointerDown={(e) => startMove(e, c, track)}
        onDoubleClick={() => compound && props.onOpenCompound(c.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!selected.has(c.id)) onSelect({ type: 'clips', ids: unitOf(project, c.id) });
          props.onContextMenu(c.id, e.clientX, e.clientY);
        }}
        title={`${media?.name ?? 'medio'} · ${formatTime(c.source.duration_us, true)}${compound ? ' · doble clic para editar' : ''}`}
      >
        {compound ? (
          <div className="clip-compound-body" />
        ) : isVideo ? (
          <>
            <div className="clip-thumbs" style={{ backgroundImage: `url(${thumbUrl(c.media)})`, bottom: embeddedAudio ? 16 : 0 }} />
            {embeddedAudio && (
              <div className={`clip-audio-strip${track.muted ? ' muted' : ''}`} title="Audio del vídeo">
                <div className="clip-wave" style={waveStyle(c)} />
                {fades(c)}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="clip-wave" style={waveStyle(c)} />
            {fades(c)}
          </>
        )}
        <div className="clip-label">
          {compound ? <IconCompound width={12} height={12} /> : isVideo ? <IconFilm width={12} height={12} /> : c.linked_to ? <IconLink width={12} height={12} /> : <IconWave width={12} height={12} />}
          <span>{media?.name ?? 'medio'}</span>
          {c.group_id && <IconGroup width={12} height={12} className="clip-badge" />}
          {c.audio_detached && <IconDetach width={12} height={12} className="clip-badge" />}
          {c.gain_db !== 0 && (embeddedAudio || !isVideo || compound) && <span className="clip-badge">{Math.round(Math.pow(10, c.gain_db / 20) * 100)} %</span>}
        </div>
        <div className="trim-handle left" onPointerDown={(e) => startTrim(e, c, 'start', track)} />
        <div className="trim-handle right" onPointerDown={(e) => startTrim(e, c, 'end', track)} />
      </div>
    );
  };

  const renderTransitions = (track: Track) =>
    track.clips.slice(0, -1).map((c, i) => {
      const next = track.clips[i + 1];
      const t = c.transition_out;
      const isSel = selection?.type === 'transition' && selection.id === c.id;
      if (t) {
        const w = Math.max(16, xOf(t.duration_us));
        return (
          <button
            key={`t-${c.id}`}
            className={`tl-transition${isSel ? ' selected' : ''}`}
            style={{ left: xOf(next.timeline_start_us) + xOf(t.duration_us) / 2 - w / 2, width: w }}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect({ type: 'transition', id: c.id });
            }}
            title={`Mix · ${(t.duration_us / US_PER_S).toFixed(2)} s`}
          >
            <IconMix width={14} height={14} />
          </button>
        );
      }
      return (
        <button
          key={`j-${c.id}`}
          className="tl-junction"
          style={{ left: xOf(clipEnd(c)) - 11 }}
          onPointerDown={(e) => {
            e.stopPropagation();
            props.onAddTransition(c.id);
          }}
          title="Añadir transición Mix"
        >
          +
        </button>
      );
    });

  const trackControls = (track: Track) => (
    <div className="tl-head-ctrls" onPointerDown={(e) => e.stopPropagation()}>
      <button
        className={`head-btn${track.locked ? ' on' : ''}`}
        aria-pressed={Boolean(track.locked)}
        aria-label={track.locked ? 'Desbloquear pista' : 'Bloquear pista'}
        title={track.locked ? 'Pista bloqueada: clic para desbloquear' : 'Bloquear pista (evita cambios)'}
        onClick={() => props.onTrackFlag(track.id, 'locked', !track.locked)}
      >
        {track.locked ? <IconLock width={15} height={15} /> : <IconUnlock width={15} height={15} />}
      </button>
      {track.kind === 'video' && (
        <button
          className={`head-btn${track.hidden ? ' on' : ''}`}
          aria-pressed={Boolean(track.hidden)}
          aria-label={track.hidden ? 'Mostrar pista' : 'Ocultar pista'}
          title={track.hidden ? 'Pista oculta en vista previa y exportación: clic para mostrar' : 'Ocultar pista (vista previa y exportación)'}
          onClick={() => props.onTrackFlag(track.id, 'hidden', !track.hidden)}
        >
          {track.hidden ? <IconEyeOff width={15} height={15} /> : <IconEye width={15} height={15} />}
        </button>
      )}
      <button
        className={`head-btn${track.muted ? ' on' : ''}`}
        aria-pressed={Boolean(track.muted)}
        aria-label={track.muted ? 'Activar sonido de la pista' : 'Silenciar pista'}
        title={track.muted ? 'Pista silenciada: clic para activar el sonido' : 'Silenciar pista (no cambia el volumen de los clips)'}
        onClick={() => props.onTrackFlag(track.id, 'muted', !track.muted)}
      >
        {track.muted ? <IconSpeakerOff width={15} height={15} /> : <IconSpeaker width={15} height={15} />}
      </button>
    </div>
  );

  const step = rulerStep(pps);
  const ticks: number[] = [];
  for (let s = 0; s * pps <= width; s += step) ticks.push(s);
  const { in_us, out_us } = project.range;
  const anyAudio = project.tracks.some((t) => t.kind === 'audio' && t.clips.length);
  const firstAudioId = project.tracks.find((t) => t.kind === 'audio')?.id;

  return (
    <div className="timeline">
      <div className="tl-heads" style={{ width: HEAD_W }}>
        <div className="tl-heads-ruler" style={{ height: RULER_H }} />
        <div className="tl-heads-inner" ref={headsRef}>
          {rows.map((r) =>
            r.type === 'track' ? (
              <div key={r.key} className={`tl-head${r.track!.main ? ' main' : ''}${r.track!.locked ? ' locked' : ''}`} style={{ height: r.height }}>
                <span className="tl-head-name">
                  {r.track!.main ? <IconMagnet /> : r.track!.kind === 'video' ? <IconFilm /> : <IconWave />}
                  <span>{trackLabel(project, r.track!)}</span>
                </span>
                {trackControls(r.track!)}
              </div>
            ) : (
              <div key={r.key} className="tl-head new" style={{ height: r.height }} />
            ),
          )}
        </div>
      </div>
      <div className="tl-scroll" ref={scrollRef} onScroll={syncHeads}>
        <div className="tl-content" style={{ width }}>
          <div className="tl-ruler" style={{ height: RULER_H }} onPointerDown={scrub}>
            {(in_us !== null || out_us !== null) && (
              <div className="tl-range" style={{ left: xOf(in_us ?? 0), width: xOf((out_us ?? duration) - (in_us ?? 0)) }}>
                {in_us !== null && <span className="tl-mark in">I</span>}
                {out_us !== null && <span className="tl-mark out">O</span>}
              </div>
            )}
            {ticks.map((s) => (
              <div key={s} className="tl-tick" style={{ left: s * pps }}>
                <span>{formatTime(s * US_PER_S, step < 1)}</span>
              </div>
            ))}
          </div>

          <div className="tl-rows" style={{ height: rowsHeight }} {...dropHandlers}>
            {rows.map((r) => {
              const style = { top: r.top, height: r.height };
              if (r.type !== 'track') {
                const kind = r.type === 'new-video' ? 'vídeo' : 'audio';
                return (
                  <div key={r.key} style={style} onPointerDown={startMarquee} className={`tl-row tl-new${dropRow === r.key || (ghost && dragZoneHot(r, ghost)) ? ' hot' : ''}`}>
                    <span>
                      <IconPlus width={12} height={12} /> Suelta aquí para crear una pista de {kind}
                    </span>
                  </div>
                );
              }
              const track = r.track!;
              const cls = ['tl-row', 'tl-track', track.kind, track.main && 'main', dropRow === r.key && 'hot', track.locked && 'locked', track.hidden && 'hidden', track.muted && 'muted'].filter(Boolean);
              return (
                <div key={r.key} style={style} onPointerDown={startMarquee} className={cls.join(' ')}>
                  {track.clips.map((c) => renderClip(c, r))}
                  {track.main && !track.locked && renderTransitions(track)}
                  {track.main && !track.clips.length && <div className="tl-empty">Pista principal: arrastra vídeos aquí</div>}
                  {track.id === firstAudioId && !anyAudio && <div className="tl-empty">Arrastra audios aquí · o separa el audio de un vídeo</div>}
                </div>
              );
            })}
            {ghost && <div className={`tl-ghost${ghost.valid ? '' : ' invalid'}`} style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }} />}
            {marquee && (
              <div
                className="tl-marquee"
                style={{
                  left: Math.min(marquee.x0, marquee.x1),
                  top: Math.min(marquee.y0, marquee.y1),
                  width: Math.abs(marquee.x1 - marquee.x0),
                  height: Math.abs(marquee.y1 - marquee.y0),
                }}
              />
            )}
          </div>

          {guide !== null && <div className="tl-guide" style={{ transform: `translateX(${xOf(guide)}px)`, height: RULER_H + rowsHeight }} />}
          <Playhead pps={pps} height={RULER_H + rowsHeight} />
        </div>
      </div>
    </div>
  );
}

function dragZoneHot(row: Row, ghost: DragGhost): boolean {
  return ghost.valid && ghost.top >= row.top && ghost.top < row.top + row.height;
}

function Playhead({ pps, height }: { pps: number; height: number }) {
  const t = usePlayhead();
  return (
    <div className="tl-playhead" style={{ transform: `translateX(${(t / US_PER_S) * pps}px)`, height }}>
      <div className="tl-playhead-head" />
    </div>
  );
}
