import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { clipEnd, clipLocked, findClip, type Project } from '../../shared/model.ts';
import { setClipTransform } from '../../shared/ops.ts';
import { fitSize, IDENTITY, placement, type Transform } from '../../shared/transform.ts';
import { usePlayhead } from '../lib/playhead.ts';

/** Pixels within which a dragged clip snaps its center to the canvas center lines. */
const SNAP_PX = 6;

/**
 * Frame of the selected video clip over the preview: drag inside to move it,
 * drag a corner to scale it about its center. One undo step per drag.
 */
export function TransformBox(props: {
  project: Project;
  clipId: string | null;
  snapping: boolean;
  preview: (p: Project) => void;
  apply: (p: Project, base?: Project) => void;
}) {
  const { project, clipId } = props;
  const t = usePlayhead();
  const boxRef = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const [dragging, setDragging] = useState(false);

  const found = clipId ? findClip(project, clipId) : null;
  if (!found || found.track.kind !== 'video' || found.track.hidden) return null;
  const { clip } = found;
  const media = project.media[clip.media];
  if (!media || !(media.has_video || media.kind === 'compound')) return null;
  if (t < clip.timeline_start_us || t >= clipEnd(clip)) return null;
  const locked = clipLocked(project, clip.id);
  const fit = media.kind === 'compound' ? { w: 1, h: 1 } : fitSize(media.width, media.height);
  const { frame, view } = placement(clip.transform, fit);
  const pct = (n: number) => `${n * 100}%`;

  const start = (e: ReactPointerEvent, mode: 'move' | 'scale') => {
    if (locked || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = boxRef.current?.parentElement?.getBoundingClientRect();
    if (!stage) return;
    const base = project;
    const t0: Transform = clip.transform ?? IDENTITY;
    const cx = stage.left + (frame.x + frame.w / 2) * stage.width;
    const cy = stage.top + (frame.y + frame.h / 2) * stage.height;
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    let last: Project | null = null;
    setDragging(true);

    const onMove = (ev: PointerEvent) => {
      let next: Transform;
      if (mode === 'move') {
        let x = t0.x + (ev.clientX - e.clientX) / stage.width;
        let y = t0.y + (ev.clientY - e.clientY) / stage.height;
        const snapX = props.snapping && !ev.altKey && Math.abs(x) * stage.width < SNAP_PX;
        const snapY = props.snapping && !ev.altKey && Math.abs(y) * stage.height < SNAP_PX;
        if (snapX) x = 0;
        if (snapY) y = 0;
        setGuides({ v: snapX, h: snapY });
        next = { ...t0, x, y };
      } else {
        next = { ...t0, scale: t0.scale * (Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0) };
      }
      last = setClipTransform(base, clip.id, next);
      props.preview(last);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setGuides({ v: false, h: false });
      setDragging(false);
      if (last) props.apply(last, base);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const cropped = view.w < frame.w - 1e-6 || view.h < frame.h - 1e-6;
  return (
    <>
      {guides.v && <div className="tbox-guide v" />}
      {guides.h && <div className="tbox-guide h" />}
      {cropped && <div className="tbox-view" style={{ left: pct(view.x), top: pct(view.y), width: pct(view.w), height: pct(view.h) }} />}
      <div
        ref={boxRef}
        className={`tbox${locked ? ' locked' : ''}${dragging ? ' dragging' : ''}`}
        style={{ left: pct(frame.x), top: pct(frame.y), width: pct(frame.w), height: pct(frame.h) }}
        onPointerDown={(e) => start(e, 'move')}
        title={locked ? 'Pista bloqueada' : 'Arrastra para mover · esquinas para escalar · Alt: sin ajuste al centro'}
      >
        {!locked &&
          (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span key={corner} className={`tbox-handle ${corner}`} onPointerDown={(e) => start(e, 'scale')} />
          ))}
      </div>
    </>
  );
}
