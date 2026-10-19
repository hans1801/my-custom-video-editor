import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * Draggable border between two panels. `side` says which panel it resizes:
 * 'left' grows when dragged right, 'right' grows when dragged left.
 * Arrow keys nudge it; double-click restores the default width.
 */
export function Splitter(props: {
  label: string;
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  onChange: (w: number) => void;
}) {
  const { side, width, min, max } = props;
  const clampW = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    document.body.classList.add('resizing');
    const onMove = (ev: PointerEvent) => props.onChange(clampW(w0 + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX)));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.shiftKey ? 50 : 10) * (e.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1);
    props.onChange(clampW(width + step));
  };

  return (
    <div className="splitter">
      <div
        className="splitter-hit"
        role="separator"
        aria-orientation="vertical"
        aria-label={props.label}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title={`${props.label}: arrastra para cambiar el ancho · doble clic para restablecer`}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          props.onChange(clampW(props.defaultWidth));
        }}
      />
    </div>
  );
}
