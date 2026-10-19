// Compound clips: one clip that holds a nested timeline. The selected clips
// move into project.compounds[id] with their own tracks; one clip on the
// timeline stands for all of them.
// Grouping is different: grouped clips stay on their tracks.

import {
  allClips,
  type Clip,
  clipEnd,
  clipLocked,
  findClip,
  mainTrack,
  type MediaInfo,
  MIN_CLIP_US,
  newId,
  normalize,
  type Project,
  pruneEmptyTracks,
  syncCompounds,
  type Track,
  type Us,
} from './model.ts';
import { expandSelection, follow, overlapsInTrack } from './ops.ts';
import { composePlacement, fitSize, isIdentity, placement, transformFromPlacement } from './transform.ts';

export interface CompoundResult {
  project: Project;
  clipId: string | null;
  error?: string;
  /** Part of the content lies outside the main-track block and is trimmed out of view. */
  hiddenParts?: boolean;
}

/** Turn the selected clips into one compound clip. */
export function createCompound(p: Project, ids: Iterable<string>): CompoundResult {
  const set = expandSelection(p, ids);
  if (!set.size) return { project: p, clipId: null, error: 'Selecciona al menos un clip.' };
  if ([...set].some((id) => clipLocked(p, id))) return { project: p, clipId: null, error: 'Hay clips en pistas bloqueadas.' };

  const main = mainTrack(p);
  const mainIdx = main.clips.map((c, i) => (set.has(c.id) ? i : -1)).filter((i) => i >= 0);
  if (mainIdx.length && mainIdx[mainIdx.length - 1] - mainIdx[0] !== mainIdx.length - 1)
    return { project: p, clipId: null, error: 'Los clips de la pista principal deben ir seguidos para crear una composición.' };

  const selected = allClips(p).filter((c) => set.has(c.id));
  const origin = Math.min(...selected.map((c) => c.timeline_start_us));
  const end = Math.max(...selected.map(clipEnd));

  // Inner tracks mirror the outer tracks that had selected clips, shifted so the content starts at 0.
  const mainSel = mainIdx.map((i) => main.clips[i]);
  const shift = (c: Clip): Clip => ({ ...c, timeline_start_us: c.timeline_start_us - origin });
  const inner: Track[] = [];
  for (const t of p.tracks) {
    if (t.main) {
      const clips = mainSel.map((c, i) => (i === mainSel.length - 1 ? { ...shift(c), transition_out: null } : shift(c)));
      inner.push({ id: newId(), kind: 'video', main: true, offset_us: mainSel.length ? mainSel[0].timeline_start_us - origin : 0, clips });
      continue;
    }
    const clips = t.clips.filter((c) => set.has(c.id)).map(shift);
    if (clips.length) inner.push({ id: newId(), kind: t.kind, clips });
  }
  const innerTracks = normalize({ ...p, tracks: inner }).tracks;

  const cid = `cmp-${newId()}`;
  const count = Object.values(p.media).filter((m) => m.kind === 'compound').length + 1;
  const firstVideo = selected.map((c) => p.media[c.media]).find((m) => m?.has_video && m.width);
  const media: MediaInfo = {
    id: cid,
    kind: 'compound',
    name: `Composición ${count}`,
    file: '',
    duration_us: end - origin,
    has_video: selected.some((c) => findClip(p, c.id)!.track.kind === 'video' && p.media[c.media]?.has_video),
    has_audio: selected.some((c) => p.media[c.media]?.has_audio),
    width: firstVideo?.width ?? 1920,
    height: firstVideo?.height ?? 1080,
  };

  const compoundClip: Clip = { id: newId(), media: cid, source: { start_us: 0, duration_us: end - origin }, timeline_start_us: origin, gain_db: 0, fade_in_us: 0, fade_out_us: 0 };
  let tracks = p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !set.has(c.id)) }));
  let hiddenParts = false;

  if (mainSel.length) {
    // On the main track the compound shows exactly the block it replaces, so nothing else moves.
    const blockStart = mainSel[0].timeline_start_us;
    const blockEnd = clipEnd(mainSel[mainSel.length - 1]);
    compoundClip.source = { start_us: blockStart - origin, duration_us: blockEnd - blockStart };
    compoundClip.transition_out = mainSel[mainSel.length - 1].transition_out ?? null;
    hiddenParts = origin < blockStart || end > blockEnd;
    tracks = tracks.map((t) => {
      if (!t.main) return t;
      const clips = [...t.clips];
      clips.splice(mainIdx[0], 0, compoundClip);
      return { ...t, clips };
    });
  } else {
    const kind = selected.some((c) => findClip(p, c.id)!.track.kind === 'video') ? 'video' : 'audio';
    const home = p.tracks.find((t) => t.kind === kind && !t.main && t.clips.some((c) => set.has(c.id)))!;
    tracks = tracks.map((t) => (t.id === home.id ? { ...t, clips: [...t.clips, compoundClip] } : t));
    const placed = tracks.find((t) => t.id === home.id)!;
    if (overlapsInTrack(placed, origin, end, compoundClip.id)) {
      tracks = tracks.map((t) => (t.id === home.id ? { ...t, clips: t.clips.filter((c) => c.id !== compoundClip.id) } : t));
      const fresh: Track = { id: newId(), kind, clips: [compoundClip] };
      const i = tracks.findIndex((t) => t.id === home.id);
      tracks.splice(kind === 'video' ? i : i + 1, 0, fresh);
    }
  }

  let next: Project = normalize({
    ...p,
    media: { ...p.media, [cid]: media },
    compounds: { ...(p.compounds ?? {}), [cid]: { tracks: innerTracks } },
    tracks,
  });
  next = pruneEmptyTracks(syncCompounds(next));
  return { project: next, clipId: compoundClip.id, hiddenParts };
}

/** Put a compound clip's (visible) content back on the timeline. Returns the restored clip ids. */
export function decompose(p: Project, clipId: string): { project: Project; ids: string[]; error?: string } {
  const found = findClip(p, clipId);
  const media = found && p.media[found.clip.media];
  if (!found || media?.kind !== 'compound') return { project: p, ids: [], error: 'Selecciona una composición.' };
  if (clipLocked(p, clipId)) return { project: p, ids: [], error: 'La pista está bloqueada.' };
  const data = p.compounds?.[media.id];
  if (!data) return { project: p, ids: [], error: 'Falta el contenido de la composición.' };

  const c = found.clip;
  const w0 = c.source.start_us;
  const w1 = c.source.start_us + c.source.duration_us;
  const offset = c.timeline_start_us - w0;
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  for (const t of data.tracks) for (const x of t.clips) idMap.set(x.id, newId());

  /**
   * An inner clip in outer time, with fresh ids. Main-track clips are cut to
   * what the compound shows; secondary clips come back whole (nothing hidden is lost).
   */
  const piece = (x: Clip, clipToWindow = true): Clip | null => {
    const v0 = clipToWindow ? Math.max(x.timeline_start_us, w0) : x.timeline_start_us;
    const v1 = clipToWindow ? Math.min(clipEnd(x), w1) : clipEnd(x);
    if (v1 - v0 < MIN_CLIP_US) return null;
    const cut = v0 - x.timeline_start_us;
    if (x.group_id && !groupMap.has(x.group_id)) groupMap.set(x.group_id, newId());
    return {
      ...x,
      id: idMap.get(x.id)!,
      linked_to: x.linked_to ? idMap.get(x.linked_to) : undefined,
      group_id: x.group_id ? groupMap.get(x.group_id) : undefined,
      source: { start_us: x.source.start_us + cut, duration_us: v1 - v0 },
      timeline_start_us: v0 + offset,
      fade_in_us: cut > 0 ? 0 : x.fade_in_us,
      fade_out_us: v1 < clipEnd(x) ? 0 : x.fade_out_us,
    };
  };

  // The compound's own position / scale / crop is baked into each picture it held.
  const fitOf = (x: Clip) => {
    const m = p.media[x.media];
    return m?.kind === 'compound' ? { w: 1, h: 1 } : fitSize(m?.width ?? 0, m?.height ?? 0);
  };
  const bake = (x: Clip): Clip => {
    if (isIdentity(c.transform)) return x;
    const t = transformFromPlacement(composePlacement(placement(x.transform, fitOf(x)), c.transform), fitOf(x));
    const { transform: _t, ...rest } = x;
    return isIdentity(t) ? rest : { ...rest, transform: t };
  };

  const innerMain = data.tracks.find((t) => t.main);
  const mainPieces = (innerMain?.clips ?? []).map((x) => piece(x)).filter((x): x is Clip => Boolean(x)).map(bake);
  const restored: string[] = [];
  let tracks = p.tracks.map((t) => ({ ...t, clips: t.clips.filter((x) => x.id !== c.id) }));
  let secondaryShift: Us = 0;

  if (found.track.main) {
    const idx = found.index;
    const block = mainPieces.map((x, i) => (i === mainPieces.length - 1 ? { ...x, transition_out: c.transition_out ?? null } : x));
    // The block starts where the compound started; keep the inner tracks in sync with it.
    if (block.length) secondaryShift = c.timeline_start_us - block[0].timeline_start_us;
    tracks = tracks.map((t) => {
      if (!t.main) return t;
      const clips = [...t.clips];
      clips.splice(idx, 0, ...block);
      return { ...t, clips };
    });
    restored.push(...block.map((x) => x.id));
  } else if (mainPieces.length) {
    tracks = tracks.map((t) => (t.id === found.track.id ? { ...t, clips: [...t.clips, ...mainPieces.map((x) => ({ ...x, transition_out: null }))] } : t));
    restored.push(...mainPieces.map((x) => x.id));
  }

  for (const it of data.tracks) {
    if (it.main) continue;
    const pieces = it.clips
      .map((x) => piece(x, Boolean(x.linked_to)))
      .filter((x): x is Clip => Boolean(x))
      .map((x) => ({ ...(it.kind === 'video' ? bake(x) : x), timeline_start_us: Math.max(0, x.timeline_start_us + secondaryShift) }));
    if (!pieces.length) continue;
    const fits = (t: Track) => t.kind === it.kind && !t.main && !t.locked && pieces.every((x) => x.linked_to || !overlapsInTrack(t, x.timeline_start_us, clipEnd(x)));
    const home = tracks.find(fits);
    if (home) tracks = tracks.map((t) => (t.id === home.id ? { ...t, clips: [...t.clips, ...pieces] } : t));
    else if (it.kind === 'video') tracks = [{ id: newId(), kind: 'video', clips: pieces }, ...tracks];
    else tracks = [...tracks, { id: newId(), kind: 'audio', clips: pieces }];
    restored.push(...pieces.map((x) => x.id));
  }

  let next: Project = normalize({ ...p, tracks });
  // Drop the compound's content once no clip uses it any more.
  const stillUsed = [...next.tracks, ...Object.entries(next.compounds ?? {}).filter(([id]) => id !== media.id).flatMap(([, d]) => d.tracks)].some((t) =>
    t.clips.some((x) => x.media === media.id),
  );
  if (!stillUsed) {
    const { [media.id]: _m, ...mediaRest } = next.media;
    const { [media.id]: _c, ...compoundsRest } = next.compounds ?? {};
    next = { ...next, media: mediaRest, compounds: compoundsRest };
  }
  next = pruneEmptyTracks(syncCompounds(follow(p, normalize(next), new Set([c.id, ...restored]))));
  return { project: next, ids: restored };
}

// ---------- editing inside a compound

/** The project as seen inside the compound at the end of `path` (root when empty). */
export function getView(root: Project, path: string[]): Project {
  const cid = path[path.length - 1];
  const data = cid ? root.compounds?.[cid] : undefined;
  if (!data) return root;
  return normalize({ ...root, tracks: data.tracks, range: { in_us: null, out_us: null } });
}

/** Write an edited view back into the root project. */
export function setView(root: Project, path: string[], view: Project): Project {
  const cid = path[path.length - 1];
  if (!cid || !root.compounds?.[cid]) return view;
  return syncCompounds({
    ...root,
    name: view.name,
    media: view.media,
    compounds: { ...(view.compounds ?? root.compounds), [cid]: { tracks: view.tracks } },
  });
}

/** Keep only the part of `path` that still exists (after undo, decompose…). */
export function validPath(root: Project, path: string[]): string[] {
  const i = path.findIndex((id) => !root.compounds?.[id]);
  return i < 0 ? path : path.slice(0, i);
}
