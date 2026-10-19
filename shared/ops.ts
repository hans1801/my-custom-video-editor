// Pure editing operations. Each takes a project and returns a new, normalized one.
// They only edit the JSON; nothing is rendered until export.
//
// Rules:
// - Main track: magnetic. Inserting, deleting, moving or trimming a clip
//   shifts the clips after it so there are never gaps.
// - Secondary tracks (overlay video, audio): free. Edits never move other clips.
//   A clip may not overlap another clip on the same secondary track; when it
//   would, it goes to a new track next to the target one.
// - Separated audio stays linked to its video clip: it follows it in time,
//   and cutting/trimming one cuts/trims both. It can change audio track, or be
//   unlinked to become a free audio clip.
// - Association with the main track ("linkage"): a free secondary clip belongs
//   to the main-track clip it overlaps the most (partial overlap counts, even
//   if it starts earlier). When main-track clips shift, their associated clips
//   shift with them. Moving a main clip carries its own associated clips;
//   changing a clip's duration (trim, Mix) only shifts the clips after it, so
//   the trimmed clip's own associated clips stay put. Clips that overlap no
//   main clip are independent and never move by themselves.
// - Locked tracks: their clips can't be edited and ripple never moves them.

import {
  allClips,
  clamp,
  type Clip,
  clipEnd,
  clipLocked,
  DEFAULT_TRANSITION_US,
  findClip,
  mainTrack,
  maxTransitionUs,
  type MediaInfo,
  MIN_CLIP_US,
  MIN_TRANSITION_US,
  newId,
  normalize,
  type Project,
  pruneEmptyTracks,
  snapToFrame,
  syncCompounds,
  type Track,
  type TrackKind,
  type Us,
} from './model.ts';
import { cleanTransform, isIdentity, type Transform } from './transform.ts';

// ---------- internal helpers

const withTracks = (p: Project, tracks: Track[]) => normalize({ ...p, tracks });

// ---------- linkage (secondary clips follow the main-track clip they belong to)

/** For each free secondary clip, the main-track clip it overlaps the most. */
export function anchorsOf(p: Project): Map<string, { anchor: string; anchorStart: Us }> {
  const main = mainTrack(p).clips;
  const map = new Map<string, { anchor: string; anchorStart: Us }>();
  for (const t of p.tracks) {
    if (t.main) continue;
    for (const c of t.clips) {
      if (c.linked_to) continue;
      let best: Clip | null = null;
      let bestOverlap = 0;
      for (const m of main) {
        const ov = Math.min(clipEnd(c), clipEnd(m)) - Math.max(c.timeline_start_us, m.timeline_start_us);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          best = m;
        }
      }
      if (best) map.set(c.id, { anchor: best.id, anchorStart: best.timeline_start_us });
    }
  }
  return map;
}

/**
 * After `after` was produced from `before` by a main-track edit, shift every
 * associated secondary clip by however much its main clip moved. A group
 * moves as one (by its lead member's shift). `exclude` = clips the edit moved
 * itself. Clips on locked tracks stay. Collisions go to a new track.
 */
export function follow(before: Project, after: Project, exclude: Set<string> = new Set()): Project {
  const anchors = anchorsOf(before);
  const shift = new Map<string, Us>();
  for (const [id, { anchor, anchorStart }] of anchors) {
    if (exclude.has(id)) continue;
    const a = findClip(after, anchor);
    if (a) shift.set(id, a.clip.timeline_start_us - anchorStart);
  }
  // Groups move together: use the shift of the group's main-track member, else of its earliest associated member.
  const groups = new Map<string, Clip[]>();
  for (const c of allClips(before)) if (c.group_id) groups.set(c.group_id, [...(groups.get(c.group_id) ?? []), c]);
  for (const members of groups.values()) {
    const mainMember = members.find((m) => mainTrack(before).clips.some((x) => x.id === m.id));
    let d: Us | undefined;
    if (mainMember) {
      const now = findClip(after, mainMember.id);
      d = now ? now.clip.timeline_start_us - mainMember.timeline_start_us : undefined;
    } else {
      const lead = [...members].sort((x, y) => x.timeline_start_us - y.timeline_start_us).find((m) => shift.has(m.id));
      d = lead ? shift.get(lead.id) : undefined;
    }
    for (const m of members) if (!exclude.has(m.id) && !m.linked_to && !mainTrack(before).clips.some((x) => x.id === m.id)) shift.set(m.id, d ?? 0);
  }
  const moved: string[] = [];
  let tracks = after.tracks.map((t) =>
    t.main || t.locked
      ? t
      : {
          ...t,
          clips: t.clips.map((c) => {
            const d = shift.get(c.id);
            if (!d) return c;
            moved.push(c.id);
            return { ...c, timeline_start_us: Math.max(0, c.timeline_start_us + d) };
          }),
        },
  );
  if (!moved.length) return after;
  tracks = resolveCollisions(tracks, moved);
  return withTracks(after, tracks);
}

/** Free clips in `ids` that now overlap another clip on their track go to a new track next to it. */
function resolveCollisions(tracks: Track[], ids: string[]): Track[] {
  let out = tracks;
  const order = ids
    .map((id) => out.flatMap((t) => t.clips).find((c) => c.id === id)!)
    .filter(Boolean)
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  for (const c of order) {
    const t = out.find((x) => x.clips.some((y) => y.id === c.id))!;
    if (t.main || !overlapsInTrack(t, c.timeline_start_us, clipEnd(c), c.id)) continue;
    out = out.map((x) => (x.id === t.id ? { ...x, clips: x.clips.filter((y) => y.id !== c.id) } : x));
    out = placeFree(out, t.id, c);
  }
  return out;
}

const mapClips = (p: Project, fn: (c: Clip, track: Track) => Clip | Clip[] | null): Track[] =>
  p.tracks.map((t) => ({ ...t, clips: t.clips.flatMap((c) => fn(c, t) ?? []) }));

function newClip(media: MediaInfo, timeline_start_us: Us): Clip {
  return {
    id: newId(),
    media: media.id,
    source: { start_us: 0, duration_us: media.duration_us },
    timeline_start_us,
    gain_db: 0,
    fade_in_us: 0,
    fade_out_us: 0,
  };
}

/** Does [start, end) collide with another clip of the track? */
export function overlapsInTrack(track: Track, start: Us, end: Us, ignoreId?: string): boolean {
  return track.clips.some((c) => c.id !== ignoreId && c.timeline_start_us < end && start < clipEnd(c));
}

/**
 * Put a free clip on `trackId`; if it would overlap there, create a new track
 * next to it (above for video, below for audio). Returns the new track list.
 */
function placeFree(tracks: Track[], trackId: string, clip: Clip): Track[] {
  const i = tracks.findIndex((t) => t.id === trackId);
  const target = tracks[i];
  if (!overlapsInTrack(target, clip.timeline_start_us, clipEnd(clip), clip.id)) {
    return tracks.map((t, j) => (j === i ? { ...t, clips: [...t.clips, clip] } : t));
  }
  const fresh: Track = { id: newId(), kind: target.kind, clips: [clip] };
  const out = [...tracks];
  out.splice(target.kind === 'video' ? i : i + 1, 0, fresh);
  return out;
}

/** First audio track where [start,end) fits, or a new audio track at the bottom. */
function placeInAudio(tracks: Track[], clip: Clip, preferredId?: string): Track[] {
  const audios = tracks.filter((t) => t.kind === 'audio' && !t.locked);
  const preferred = audios.find((t) => t.id === preferredId);
  if (preferred) return placeFree(tracks, preferred.id, clip);
  const fit = audios.find((t) => !overlapsInTrack(t, clip.timeline_start_us, clipEnd(clip)));
  if (fit) return placeFree(tracks, fit.id, clip);
  return [...tracks, { id: newId(), kind: 'audio', clips: [clip] }];
}

/** A clip plus everything that must move with it: its group and its linked audio / video. */
export function expandSelection(p: Project, ids: Iterable<string>): Set<string> {
  const set = new Set<string>();
  const queue = [...ids];
  const clips = allClips(p);
  while (queue.length) {
    const id = queue.pop()!;
    if (set.has(id)) continue;
    const c = clips.find((x) => x.id === id);
    if (!c) continue;
    set.add(id);
    if (c.group_id) for (const x of clips) if (x.group_id === c.group_id) queue.push(x.id);
    if (c.linked_to) queue.push(c.linked_to);
    for (const x of clips) if (x.linked_to === id) queue.push(x.id);
  }
  return set;
}

/** Insert a clip into the main track at `index`, dropping the Mix it would split. */
function insertInMain(tracks: Track[], clip: Clip, index: number): Track[] {
  return tracks.map((t) => {
    if (!t.main) return t;
    const clips = [...t.clips];
    const at = clamp(index, 0, clips.length);
    if (at > 0) clips[at - 1] = { ...clips[at - 1], transition_out: null };
    clips.splice(at, 0, { ...clip, transition_out: null });
    return { ...t, clips };
  });
}

/** Remove a clip from wherever it is; on the main track the clip before it loses its Mix. */
function removeClip(tracks: Track[], clipId: string): Track[] {
  return tracks.map((t) => {
    const i = t.clips.findIndex((c) => c.id === clipId);
    if (i < 0) return t;
    const clips = t.clips.filter((c) => c.id !== clipId);
    if (t.main && i > 0) clips[i - 1] = { ...clips[i - 1], transition_out: null };
    return { ...t, clips };
  });
}

// ---------- media

export function addMedia(p: Project, media: MediaInfo): Project {
  return { ...p, media: { ...p.media, [media.id]: media } };
}

/** Point every clip that used `oldId` at a re-imported file (relinking a missing medium). */
export function relinkMedia(p: Project, oldId: string, media: MediaInfo): Project {
  const { [oldId]: _old, ...rest } = p.media;
  return withTracks({ ...p, media: { ...rest, [media.id]: media } }, mapClips(p, (c) => (c.media === oldId ? { ...c, media: media.id } : c)));
}

/** Remove a medium from the project together with every clip that uses it (also inside compound clips). */
export function removeMedia(p: Project, mediaId: string): Project {
  const { [mediaId]: _gone, ...media } = p.media;
  const strip = (tracks: Track[]): { tracks: Track[]; removed: Set<string> } => {
    const removed = new Set(tracks.flatMap((t) => t.clips.filter((c) => c.media === mediaId).map((c) => c.id)));
    let out = tracks;
    for (const id of removed) out = removeClip(out, id).map((t) => ({ ...t, clips: t.clips.filter((c) => c.linked_to !== id) }));
    return { tracks: out, removed };
  };
  const compounds = Object.fromEntries(Object.entries(p.compounds ?? {}).map(([id, d]) => [id, { tracks: normalize({ ...p, tracks: strip(d.tracks).tracks }).tracks }]));
  const root = strip(p.tracks);
  return pruneEmptyTracks(syncCompounds(follow(p, withTracks({ ...p, media, compounds }, root.tracks), root.removed)));
}

export const clipsUsingMedia = (p: Project, mediaId: string) =>
  [...p.tracks, ...Object.values(p.compounds ?? {}).flatMap((d) => d.tracks)].reduce((n, t) => n + t.clips.filter((c) => c.media === mediaId).length, 0);

/**
 * Add a clip for an imported medium.
 * - Video: into the main track at `mainIndex` (default: the end), or onto a
 *   secondary video track at time `at` when `trackId` names one.
 * - Audio-only: onto an audio track at time `at` (a new track if that spot is taken).
 */
export function addClipFromMedia(
  p: Project,
  media: MediaInfo,
  at: Us,
  mainIndex?: number,
  trackId?: string,
): { project: Project; clipId: string } {
  p = addMedia(p, media);
  const target = p.tracks.find((t) => t.id === trackId);
  const clip = newClip(media, Math.max(0, snapToFrame(p, at)));
  let tracks: Track[];
  if (media.has_video) {
    const free = target && target.kind === 'video' && !target.main && !target.locked;
    if (free) tracks = placeFree(p.tracks, target.id, clip);
    else if (!mainTrack(p).locked) tracks = insertInMain(p.tracks, clip, mainIndex ?? mainTrack(p).clips.length);
    else {
      // Main track locked: put the video on a new track above it.
      tracks = [{ id: newId(), kind: 'video', clips: [clip] }, ...p.tracks];
    }
  } else {
    tracks = placeInAudio(p.tracks, clip, target?.kind === 'audio' && !target.locked ? target.id : undefined);
  }
  return { project: follow(p, withTracks(p, tracks), new Set([clip.id])), clipId: clip.id };
}

// ---------- cut / delete / trim

/**
 * Split at timeline time t. Splitting a video clip also splits its separated
 * audio (they stay linked). Returns the
 * ids of the new right-hand pieces.
 */
export function splitClip(p: Project, clipId: string, t: Us): { project: Project; rightIds: string[] } {
  const found = findClip(p, clipId);
  if (!found) return { project: p, rightIds: [] };
  if (found.clip.linked_to) return splitClip(p, found.clip.linked_to, t);
  if (clipLocked(p, clipId)) return { project: p, rightIds: [] };

  t = snapToFrame(p, t);
  const c = found.clip;
  const offset = t - c.timeline_start_us;
  if (offset < MIN_CLIP_US || c.source.duration_us - offset < MIN_CLIP_US) return { project: p, rightIds: [] };

  const left: Clip = { ...c, source: { start_us: c.source.start_us, duration_us: offset }, fade_out_us: 0, transition_out: null };
  const right: Clip = {
    ...c,
    id: newId(),
    source: { start_us: c.source.start_us + offset, duration_us: c.source.duration_us - offset },
    timeline_start_us: t,
    fade_in_us: 0,
  };
  const rightIds = [right.id];
  const tracks = mapClips(p, (x) => {
    if (x.id === c.id) return [left, right];
    if (found.track.kind === 'video' && x.linked_to === c.id) {
      const aRight: Clip = { ...x, id: newId(), linked_to: right.id, fade_in_us: 0 };
      rightIds.push(aRight.id);
      return [{ ...x, fade_out_us: 0 }, aRight];
    }
    return x;
  });
  return { project: withTracks(p, tracks), rightIds };
}

/** Clips that S should split: the selected one if it is under the playhead, else the main-track clip, else free clips. */
export function clipsToSplit(p: Project, t: Us, selectedId: string | null): string[] {
  return clipsToSplitMany(p, t, selectedId ? [selectedId] : []);
}

/** Selected clips under the playhead; with none, the main-track clip there, else free clips there. */
export function clipsToSplitMany(p: Project, t: Us, selected: string[]): string[] {
  const inside = (c: Clip) => t > c.timeline_start_us && t < clipEnd(c);
  const ok = (c: Clip) => inside(c) && !clipLocked(p, c.id);
  const sel = selected.map((id) => findClip(p, id)?.clip).filter((c): c is Clip => Boolean(c && ok(c)));
  // A separated audio is split through its video, so don't split both.
  const chosen = sel.filter((c) => !(c.linked_to && sel.some((v) => v.id === c.linked_to)));
  if (chosen.length) return chosen.map((c) => c.id);
  const main = mainTrack(p).clips.filter(ok);
  if (main.length) return [main[main.length - 1].id];
  return p.tracks.filter((tr) => !tr.main).flatMap((tr) => tr.clips.filter((c) => ok(c) && !c.linked_to).map((c) => c.id));
}

/**
 * Delete a clip. On the main track the following clips close the gap; on a
 * secondary track nothing else moves. Deleting a video clip also deletes its
 * separated audio; deleting separated audio leaves the video silent.
 */
export function deleteClip(p: Project, clipId: string): Project {
  return deleteClips(p, [clipId]);
}

/** Delete several clips at once (locked ones are skipped). Associated clips of later main clips follow the ripple. */
export function deleteClips(p: Project, ids: string[]): Project {
  const doomed = ids.filter((id) => findClip(p, id) && !clipLocked(p, id));
  if (!doomed.length) return p;
  let tracks = p.tracks;
  for (const id of doomed) tracks = removeClip(tracks, id).map((t) => ({ ...t, clips: t.clips.filter((c) => c.linked_to !== id) }));
  return pruneEmptyTracks(follow(p, withTracks(p, tracks), new Set(doomed)));
}

/**
 * Move one edge of a clip by delta µs (positive = right). On the main track the
 * clips after it shift; on secondary tracks the edge stops at the neighbour.
 * Separated audio is trimmed through its video clip so both stay in sync.
 */
export function trimClip(p: Project, clipId: string, edge: 'start' | 'end', delta: Us): Project {
  const found = findClip(p, clipId);
  if (!found) return p;
  if (found.clip.linked_to) return trimClip(p, found.clip.linked_to, edge, delta);
  if (clipLocked(p, clipId)) return p;

  const { clip: c, track } = found;
  const media = p.media[c.media];
  const free = !track.main;
  const others = track.clips.filter((x) => x.id !== c.id);
  delta = Math.round(delta);
  let next: Clip;
  if (edge === 'start') {
    const end = c.source.start_us + c.source.duration_us;
    let start = clamp(c.source.start_us + delta, 0, end - MIN_CLIP_US);
    if (free) {
      // Don't cross the previous clip or time 0.
      const prevEnd = Math.max(0, ...others.filter((x) => clipEnd(x) <= c.timeline_start_us).map(clipEnd));
      start = Math.max(start, c.source.start_us - (c.timeline_start_us - prevEnd));
    }
    const applied = start - c.source.start_us;
    next = { ...c, source: { start_us: start, duration_us: end - start }, timeline_start_us: free ? c.timeline_start_us + applied : c.timeline_start_us };
  } else {
    let duration = clamp(c.source.duration_us + delta, MIN_CLIP_US, media.duration_us - c.source.start_us);
    if (free) {
      const nextStart = Math.min(Infinity, ...others.filter((x) => x.timeline_start_us >= clipEnd(c)).map((x) => x.timeline_start_us));
      duration = Math.min(duration, nextStart - c.timeline_start_us);
    }
    next = { ...c, source: { ...c.source, duration_us: duration } };
  }
  return follow(p, withTracks(p, mapClips(p, (x) => (x.id === c.id ? next : x))));
}

// ---------- move (drag & drop inside the timeline)

export type MoveTarget =
  /** Insert into the main track before the clip at `index` (index counted without the moved clip). `at` = pointer time. */
  | { kind: 'main'; index: number; at?: Us }
  /** Place on an existing secondary track at time `at`. */
  | { kind: 'track'; trackId: string; at: Us }
  /** Create a new secondary track (video: above everything, audio: below everything). */
  | { kind: 'new-track'; trackKind: TrackKind; at: Us };

/** Whether a clip may be dropped on a track of the given kind. */
export function canMoveTo(p: Project, clipId: string, kind: TrackKind): boolean {
  const found = findClip(p, clipId);
  return Boolean(found && found.track.kind === kind);
}

/**
 * Move a clip. Video clips travel between the main track and secondary video
 * tracks; audio clips between audio tracks. Linked audio only changes track
 * (it keeps following its video). Call `pruneEmptyTracks` when the drag ends.
 */
export function moveClip(p: Project, clipId: string, target: MoveTarget): Project {
  const found = findClip(p, clipId);
  if (!found) return p;
  const { clip, track } = found;
  const targetKind: TrackKind | undefined =
    target.kind === 'main' ? 'video' : target.kind === 'new-track' ? target.trackKind : p.tracks.find((t) => t.id === target.trackId)?.kind;
  if (targetKind !== track.kind) return p; // video ↔ audio is not allowed

  // Separated audio follows its video: only its track changes.
  if (clip.linked_to) {
    if (target.kind === 'main') return p;
    const tracks = removeClip(p.tracks, clip.id);
    if (target.kind === 'new-track') return withTracks(p, [...tracks, { id: newId(), kind: 'audio', clips: [clip] }]);
    return withTracks(p, tracks.map((t) => (t.id === target.trackId ? { ...t, clips: [...t.clips, clip] } : t)));
  }

  const moved: Clip = { ...clip, transition_out: null };
  let tracks = removeClip(p.tracks, clip.id);
  if (target.kind === 'main') {
    tracks = insertInMain(tracks, moved, target.index);
  } else {
    moved.timeline_start_us = Math.max(0, snapToFrame(p, target.at));
    if (target.kind === 'new-track') {
      const fresh: Track = { id: newId(), kind: target.trackKind, clips: [moved] };
      tracks = target.trackKind === 'video' ? [fresh, ...tracks] : [...tracks, fresh];
    } else {
      const t = tracks.find((x) => x.id === target.trackId);
      if (!t) return p;
      tracks = t.main ? insertInMain(tracks, moved, t.clips.length) : placeFree(tracks, t.id, moved);
    }
  }
  return withTracks(p, tracks);
}

// ---------- audio

/**
 * Separate audio: mark the video clip and add an audio clip that
 * reads the same file and range. No new file is created. The audio goes to the
 * first audio track with room, or a new one.
 */
export function separateAudio(p: Project, videoClipId: string): { project: Project; audioClipId: string | null } {
  const found = findClip(p, videoClipId);
  if (!found || found.track.kind !== 'video') return { project: p, audioClipId: null };
  const c = found.clip;
  if (c.audio_detached || !p.media[c.media]?.has_audio || p.media[c.media]?.kind === 'compound' || clipLocked(p, c.id)) return { project: p, audioClipId: null };
  const audioClip: Clip = {
    id: newId(),
    media: c.media,
    source: { ...c.source },
    timeline_start_us: c.timeline_start_us,
    gain_db: c.gain_db,
    fade_in_us: c.fade_in_us,
    fade_out_us: c.fade_out_us,
    linked_to: c.id,
  };
  const tracks = mapClips(p, (x) => (x.id === c.id ? { ...x, audio_detached: true, gain_db: 0, fade_in_us: 0, fade_out_us: 0 } : x));
  return { project: withTracks(p, placeInAudio(tracks, audioClip)), audioClipId: audioClip.id };
}

/** Turn separated audio into a free audio clip (it stops following its video). */
export function unlinkAudio(p: Project, audioClipId: string): Project {
  const found = findClip(p, audioClipId);
  if (!found?.clip.linked_to) return p;
  return withTracks(p, mapClips(p, (c) => (c.id === audioClipId ? { ...c, linked_to: undefined } : c)));
}

// ---------- transitions, properties, range

/** Add, change or remove (duration null) the Mix transition after a main-track clip. */
export function setTransition(p: Project, videoClipId: string, duration_us: Us | null): Project {
  const clips = mainTrack(p).clips;
  const i = clips.findIndex((c) => c.id === videoClipId);
  if (i < 0 || i === clips.length - 1) return p;
  const max = maxTransitionUs(clips[i], clips[i + 1]);
  if (mainTrack(p).locked) return p;
  const transition =
    duration_us === null || max < MIN_TRANSITION_US ? null : { type: 'mix' as const, duration_us: clamp(duration_us, MIN_TRANSITION_US, max) };
  return follow(p, withTracks(p, mapClips(p, (c) => (c.id === videoClipId ? { ...c, transition_out: transition } : c))));
}

export function defaultTransitionFor(p: Project, videoClipId: string): Us {
  const clips = mainTrack(p).clips;
  const i = clips.findIndex((c) => c.id === videoClipId);
  if (i < 0 || i === clips.length - 1) return 0;
  return Math.min(DEFAULT_TRANSITION_US, maxTransitionUs(clips[i], clips[i + 1]));
}

export function setClipProps(p: Project, clipId: string, props: Partial<Pick<Clip, 'gain_db' | 'fade_in_us' | 'fade_out_us'>>): Project {
  if (clipLocked(p, clipId)) return p;
  return withTracks(p, mapClips(p, (c) => (c.id === clipId ? { ...c, ...props } : c)));
}

/** Position / scale / crop of a video clip. Identity removes the field. */
export function setClipTransform(p: Project, clipId: string, t: Transform): Project {
  if (clipLocked(p, clipId)) return p;
  const found = findClip(p, clipId);
  if (!found || found.track.kind !== 'video') return p;
  const clean = cleanTransform(t);
  return withTracks(
    p,
    mapClips(p, (c) => {
      if (c.id !== clipId) return c;
      const { transform: _old, ...rest } = c;
      return isIdentity(clean) ? rest : { ...rest, transform: clean };
    }),
  );
}

export function setRangeMark(p: Project, which: 'in' | 'out', t: Us | null): Project {
  const range = { ...p.range, [which === 'in' ? 'in_us' : 'out_us']: t === null ? null : snapToFrame(p, t) };
  if (range.in_us !== null && range.out_us !== null && range.out_us <= range.in_us) {
    if (which === 'in') range.out_us = null;
    else range.in_us = null;
  }
  return { ...p, range };
}


// ---------- multi-clip move (selection, groups)

/**
 * Move a set of clips together, driven by the clip being dragged.
 * - Main-track clips in the set move as one block (order kept) to where the
 *   drag points; the set's secondary clips shift by the same amount.
 * - Dragging the block out of the main track places it on a secondary video
 *   track, keeping the relative timing.
 * - A set without main-track clips shifts in time; clips of the dragged kind
 *   also move by the same number of tracks.
 * Associated clips outside the set follow their main clips. Locked clips
 * can't move.
 */
export function moveSet(p: Project, ids: Iterable<string>, draggedId: string, target: MoveTarget): Project {
  const set = expandSelection(p, ids);
  if ([...set].some((id) => clipLocked(p, id))) return p;
  const targetTrack = target.kind === 'track' ? p.tracks.find((t) => t.id === target.trackId) : undefined;
  if (targetTrack?.locked || ((target.kind === 'main' || targetTrack?.main) && mainTrack(p).locked)) return p;

  // Separated audio whose video is in the set just follows that video.
  const units = [...set].filter((id) => {
    const c = findClip(p, id)!.clip;
    return !(c.linked_to && set.has(c.linked_to));
  });
  let dragged = findClip(p, draggedId)!.clip;
  if (dragged.linked_to && set.has(dragged.linked_to)) dragged = findClip(p, dragged.linked_to)!.clip;
  if (units.length === 1) return follow(p, moveClip(p, units[0], target), set);

  const main = mainTrack(p);
  const mainSel = main.clips.filter((c) => set.has(c.id));
  const freeSel = units.map((id) => findClip(p, id)!).filter((f) => !f.track.main && !f.clip.linked_to);
  const draggedKind = findClip(p, dragged.id)!.track.kind;
  const delta0 = target.kind === 'main' ? 0 : target.at - dragged.timeline_start_us;

  const shiftFree = (tracks: Track[], d: Us): Track[] => {
    const minStart = Math.min(...freeSel.map((f) => f.clip.timeline_start_us));
    const dd = Math.max(d, -minStart);
    const movedIds = new Set(freeSel.map((f) => f.clip.id));
    const shifted = tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (movedIds.has(c.id) ? { ...c, timeline_start_us: c.timeline_start_us + dd } : c)) }));
    return resolveCollisions(shifted, [...movedIds]);
  };

  /** Re-insert the main block at the insertion point for time `at` (or `index`). */
  const reorderMain = (at: Us | undefined, index: number): Track[] => {
    const rest = main.clips.filter((c) => !set.has(c.id));
    const at2 = at ?? Infinity;
    const idx = at === undefined ? clamp(index, 0, rest.length) : rest.filter((c) => c.timeline_start_us + c.source.duration_us / 2 < at2).length;
    const block = mainSel.map((c) => ({ ...c }));
    const order = [...rest.slice(0, idx), ...block, ...rest.slice(idx)];
    // A Mix only survives if the same two clips are still neighbours.
    const oldNext = new Map(main.clips.map((c, i) => [c.id, main.clips[i + 1]?.id]));
    const clips = order.map((c, i) => (c.transition_out && oldNext.get(c.id) !== order[i + 1]?.id ? { ...c, transition_out: null } : c));
    return p.tracks.map((t) => (t.main ? { ...t, clips } : t));
  };

  let tracks: Track[];
  if (mainSel.length && (target.kind === 'main' || !mainSel.some((c) => c.id === dragged.id))) {
    // Reorder the block on the main track (also when a free member of the set is dragged).
    const blockAt =
      target.kind === 'main' ? target.at : target.at + (mainSel[0].timeline_start_us - dragged.timeline_start_us) + mainSel[0].source.duration_us / 2;
    const reordered = withTracks(p, reorderMain(blockAt, target.kind === 'main' ? target.index : 0));
    const d = findClip(reordered, mainSel[0].id)!.clip.timeline_start_us - mainSel[0].timeline_start_us;
    tracks = shiftFree(reordered.tracks, d);
  } else if (mainSel.length) {
    // Drag the block out of the main track onto a secondary video track.
    if (target.kind === 'main' || draggedKind !== 'video') return p;
    const goTo = target.kind === 'new-track' ? null : target.trackId;
    if (goTo && p.tracks.find((t) => t.id === goTo)?.kind !== 'video') return p;
    let out = removeMany(p.tracks, mainSel.map((c) => c.id));
    let trackId = goTo;
    if (!trackId) {
      trackId = newId();
      out = [{ id: trackId, kind: 'video', clips: [] }, ...out];
    }
    for (const c of mainSel) {
      const moved = { ...c, transition_out: null, timeline_start_us: Math.max(0, c.timeline_start_us + delta0) };
      out = placeFree(out, trackId, moved);
    }
    tracks = shiftFree(withTracks(p, out).tracks, delta0);
  } else if (target.kind === 'main') {
    // Free clips dropped on the main track: videos enter as a block, the rest shift with them.
    const videos = freeSel.filter((f) => f.track.kind === 'video').map((f) => f.clip).sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    if (!videos.length) return p;
    let out = removeMany(p.tracks, videos.map((c) => c.id));
    const rest = mainTrack({ ...p, tracks: out }).clips;
    const idx = target.at === undefined ? target.index : rest.filter((c) => c.timeline_start_us + c.source.duration_us / 2 < target.at!).length;
    videos.forEach((c, i) => (out = insertInMain(out, { ...c }, idx + i)));
    const placed = withTracks(p, out);
    const d = findClip(placed, videos[0].id)!.clip.timeline_start_us - videos[0].timeline_start_us;
    const audios = freeSel.filter((f) => f.track.kind === 'audio');
    const movedIds = new Set(audios.map((f) => f.clip.id));
    tracks = resolveCollisions(
      placed.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (movedIds.has(c.id) ? { ...c, timeline_start_us: Math.max(0, c.timeline_start_us + d) } : c)) })),
      [...movedIds],
    );
  } else {
    // Only secondary clips: shift in time, and move the dragged kind by the same number of tracks.
    const minStart = Math.min(...freeSel.map((f) => f.clip.timeline_start_us));
    const d = Math.max(delta0, -minStart);
    const kindTracks = p.tracks.filter((t) => t.kind === draggedKind && !t.main);
    const srcIdx = kindTracks.findIndex((t) => t.clips.some((c) => c.id === dragged.id));
    const tgtIdx = target.kind === 'new-track' ? (draggedKind === 'video' ? -1 : kindTracks.length) : kindTracks.findIndex((t) => t.id === target.trackId);
    const step = tgtIdx < 0 && target.kind === 'track' ? 0 : tgtIdx - srcIdx;
    let out = removeMany(p.tracks, freeSel.map((f) => f.clip.id));
    const fresh = new Map<number, string>();
    for (const f of [...freeSel].sort((a, b) => a.clip.timeline_start_us - b.clip.timeline_start_us)) {
      const moved = { ...f.clip, timeline_start_us: f.clip.timeline_start_us + d };
      let trackId = f.track.id;
      if (f.track.kind === draggedKind && step !== 0) {
        const i = kindTracks.findIndex((t) => t.id === f.track.id) + step;
        const candidate = kindTracks[i];
        if (candidate && !candidate.locked) trackId = candidate.id;
        else {
          if (!fresh.has(i)) {
            const id = newId();
            fresh.set(i, id);
            out = draggedKind === 'video' ? [{ id, kind: 'video', clips: [] }, ...out] : [...out, { id, kind: 'audio', clips: [] }];
          }
          trackId = fresh.get(i)!;
        }
      }
      out = placeFree(out, trackId, moved);
    }
    tracks = out;
  }
  return follow(p, withTracks(p, tracks), set);
}

function removeMany(tracks: Track[], ids: string[]): Track[] {
  let out = tracks;
  for (const id of ids) out = removeClip(out, id);
  return out;
}

// ---------- groups

/** Group the selected clips (with their linked audio/video). Needs at least two. */
export function groupClips(p: Project, ids: Iterable<string>): Project {
  const set = [...expandSelection(p, ids)].filter((id) => !clipLocked(p, id));
  if (set.length < 2) return p;
  const gid = newId();
  const members = new Set(set);
  return withTracks(p, mapClips(p, (c) => (members.has(c.id) ? { ...c, group_id: gid } : c)));
}

export function ungroupClips(p: Project, ids: Iterable<string>): Project {
  const groups = new Set([...ids].map((id) => findClip(p, id)?.clip.group_id).filter(Boolean));
  if (!groups.size) return p;
  return withTracks(p, mapClips(p, (c) => (c.group_id && groups.has(c.group_id) ? { ...c, group_id: undefined } : c)));
}

// ---------- track controls

export function setTrackFlag(p: Project, trackId: string, flag: 'locked' | 'hidden' | 'muted', value: boolean): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, [flag]: value || undefined } : t)) };
}

// ---------- Mejoras Pro (shared/pro.ts)

/** Apply `fix` to one clip wherever it lives (root or inside a compound). Null when the clip is gone. */
function mapClipEverywhere(p: Project, clipId: string, media: Record<string, MediaInfo>, fix: (c: Clip) => Clip): Project | null {
  let hit = false;
  const on = (tracks: Track[]) =>
    tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        hit = true;
        return fix(c);
      }),
    }));
  const next = { ...p, media };
  const compounds = Object.fromEntries(Object.entries(p.compounds ?? {}).map(([id, d]) => [id, { tracks: normalize({ ...next, tracks: on(d.tracks) }).tracks }]));
  const tracks = on(p.tracks);
  return hit ? syncCompounds(normalize({ ...next, tracks, compounds })) : null;
}

/** Point a clip at a Mejoras Pro result that covers its old medium from `rangeStartUs` on. */
export function applyEnhancedMedia(p: Project, clipId: string, media: MediaInfo, rangeStartUs: Us): Project | null {
  return mapClipEverywhere(p, clipId, { ...p.media, [media.id]: media }, (c) => ({
    ...c,
    media: media.id,
    source: { start_us: Math.max(0, c.source.start_us - rangeStartUs), duration_us: c.source.duration_us },
  }));
}

/** Put a clip back on the original medium its Mejoras Pro result was made from. */
export function revertEnhancedMedia(p: Project, clipId: string, original: MediaInfo): Project | null {
  const found = findClip(p, clipId) ?? Object.values(p.compounds ?? {}).flatMap((d) => d.tracks.flatMap((t) => t.clips)).map((clip) => ({ clip })).find((f) => f.clip.id === clipId);
  const derived = found && p.media[found.clip.media]?.derived;
  if (!derived) return null;
  return mapClipEverywhere(p, clipId, { ...p.media, [original.id]: original }, (c) => ({
    ...c,
    media: original.id,
    source: { start_us: c.source.start_us + derived.start_us, duration_us: c.source.duration_us },
  }));
}
