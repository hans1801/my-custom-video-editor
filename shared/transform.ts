// Position, scale and crop of a video clip on the 16:9 canvas.
//
// Geometry is in canvas fractions (0..1 across the width / height). A clip's
// picture is first fitted inside the canvas (like object-fit: contain), then
// scaled about the canvas center and moved; cropping hides edges of the
// picture without moving the rest (the hidden part shows the layers below).
// A compound clip's transform acts on its whole inner canvas, so nested
// transforms compose (composePlacement). Preview and export both use this.

export const CANVAS_ASPECT = 16 / 9;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5;
/** At most this share of the picture can be cropped away on each axis. */
export const MAX_CROP = 0.95;

export interface Crop {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Transform {
  /** Offset of the picture's center from the canvas center, in canvas widths / heights. */
  x: number;
  y: number;
  /** 1 = fitted to the canvas. */
  scale: number;
  /** Share of the picture hidden on each side (0..MAX_CROP). */
  crop: Crop;
}

export const IDENTITY: Transform = { x: 0, y: 0, scale: 1, crop: { left: 0, right: 0, top: 0, bottom: 0 } };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a picture lands: the whole (uncropped) frame, and the part of it that is visible. */
export interface Placement {
  frame: Rect;
  view: Rect;
}

export const isIdentity = (t?: Transform) =>
  !t || (t.x === 0 && t.y === 0 && t.scale === 1 && t.crop.left === 0 && t.crop.right === 0 && t.crop.top === 0 && t.crop.bottom === 0);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep every value in range; cropping can't hide more than MAX_CROP per axis. */
export function cleanTransform(t: Transform): Transform {
  const fix = (a: number, b: number) => {
    a = clamp(a, 0, MAX_CROP);
    b = clamp(b, 0, MAX_CROP);
    if (a + b > MAX_CROP) b = MAX_CROP - a;
    return [round(a), round(b)];
  };
  const [left, right] = fix(t.crop.left, t.crop.right);
  const [top, bottom] = fix(t.crop.top, t.crop.bottom);
  return { x: round(clamp(t.x, -2, 2)), y: round(clamp(t.y, -2, 2)), scale: round(clamp(t.scale, MIN_SCALE, MAX_SCALE)), crop: { left, right, top, bottom } };
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/** Size of a picture fitted inside the canvas, in canvas fractions. */
export function fitSize(width: number, height: number): { w: number; h: number } {
  if (!(width > 0 && height > 0)) return { w: 1, h: 1 };
  const ar = width / height;
  return ar >= CANVAS_ASPECT ? { w: 1, h: CANVAS_ASPECT / ar } : { w: ar / CANVAS_ASPECT, h: 1 };
}

export function placement(t: Transform | undefined, fit: { w: number; h: number }): Placement {
  const tr = t ?? IDENTITY;
  const w = fit.w * tr.scale;
  const h = fit.h * tr.scale;
  const frame = { x: 0.5 - w / 2 + tr.x, y: 0.5 - h / 2 + tr.y, w, h };
  const view = {
    x: frame.x + tr.crop.left * w,
    y: frame.y + tr.crop.top * h,
    w: w * (1 - tr.crop.left - tr.crop.right),
    h: h * (1 - tr.crop.top - tr.crop.bottom),
  };
  return { frame, view };
}

/** Apply a compound clip's transform (acting on its whole canvas) to a piece inside it. */
export function composePlacement(inner: Placement, outer: Transform | undefined): Placement {
  if (isIdentity(outer)) return inner;
  const o = outer!;
  const map = (r: Rect): Rect => ({ x: 0.5 + (r.x - 0.5) * o.scale + o.x, y: 0.5 + (r.y - 0.5) * o.scale + o.y, w: r.w * o.scale, h: r.h * o.scale });
  return { frame: map(inner.frame), view: intersect(map(inner.view), placement(o, { w: 1, h: 1 }).view) };
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/** The transform that puts a picture of size `fit` at `pl` (used when a compound is taken apart). */
export function transformFromPlacement(pl: Placement, fit: { w: number; h: number }): Transform {
  const { frame, view } = pl;
  const scale = frame.w / fit.w;
  return cleanTransform({
    x: frame.x + frame.w / 2 - 0.5,
    y: frame.y + frame.h / 2 - 0.5,
    scale,
    crop: {
      left: (view.x - frame.x) / frame.w,
      right: (frame.x + frame.w - (view.x + view.w)) / frame.w,
      top: (view.y - frame.y) / frame.h,
      bottom: (frame.y + frame.h - (view.y + view.h)) / frame.h,
    },
  });
}
