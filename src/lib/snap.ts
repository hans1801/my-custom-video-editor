import { allClips, clipEnd, type Project, type Us } from '../../shared/model.ts';
import { playhead } from './playhead.ts';

// Magnetic snapping: clip edges, the playhead, the I/O marks and the timeline start.

export const SNAP_PX = 8;

export function snapPoints(p: Project, exclude: Set<string>, includePlayhead: boolean): Us[] {
  const pts = new Set<Us>([0]);
  for (const c of allClips(p)) {
    if (exclude.has(c.id)) continue;
    pts.add(c.timeline_start_us);
    pts.add(clipEnd(c));
  }
  if (includePlayhead) pts.add(playhead.get());
  if (p.range.in_us !== null) pts.add(p.range.in_us);
  if (p.range.out_us !== null) pts.add(p.range.out_us);
  return [...pts];
}

/**
 * Snap any of `candidates` (times that move together, e.g. a clip's start and
 * end) to the nearest point within `thresholdUs`. Returns the shift to apply
 * and the point that was hit, or a zero shift.
 */
export function snapShift(candidates: Us[], points: Us[], thresholdUs: number): { shift: Us; at: Us | null } {
  let best: { shift: Us; at: Us | null } = { shift: 0, at: null };
  let bestDist = thresholdUs;
  for (const c of candidates) {
    for (const p of points) {
      const d = Math.abs(p - c);
      if (d <= bestDist) {
        bestDist = d;
        best = { shift: p - c, at: p };
      }
    }
  }
  return best;
}
