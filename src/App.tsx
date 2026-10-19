import { type CSSProperties, type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCompound, decompose, getView, setView, validPath } from '../shared/compound.ts';
import {
  allClips,
  clipLocked,
  createProject,
  findClip,
  formatTime,
  frameUs,
  mainTrack,
  type MediaInfo,
  parseProject,
  type Project,
  projectDuration,
  pruneEmptyTracks,
  snapToFrame,
  type TrackKind,
  US_PER_S,
  type Us,
} from '../shared/model.ts';
import {
  addClipFromMedia,
  addMedia,
  applyEnhancedMedia,
  revertEnhancedMedia,
  clipsToSplitMany,
  clipsUsingMedia,
  defaultTransitionFor,
  deleteClips,
  groupClips,
  moveClip,
  relinkMedia,
  removeMedia,
  separateAudio,
  setRangeMark,
  setTrackFlag,
  setTransition,
  splitClip,
  ungroupClips,
  unlinkAudio,
} from '../shared/ops.ts';
import { ExportDialog } from './components/ExportDialog.tsx';
import {
  IconBack,
  IconCompound,
  IconCut,
  IconDetach,
  IconExport,
  IconFilm,
  IconGroup,
  IconImport,
  IconMagnet,
  IconMarkIn,
  IconMarkOut,
  IconMix,
  IconOpen,
  IconPause,
  IconPlay,
  IconRedo,
  IconSave,
  IconToStart,
  IconTrash,
  IconUndo,
  IconUnlink,
  IconWave,
  IconZoomIn,
  IconZoomOut,
  Logo,
} from './components/Icons.tsx';
import { Inspector } from './components/Inspector.tsx';
import { ProCompare } from './components/ProCompare.tsx';
import { TransformBox } from './components/TransformBox.tsx';
import { Splitter } from './components/Splitter.tsx';
import type { ProControls } from './components/ProPanel.tsx';
import { type DropSpot, MAX_PPS, MEDIA_DRAG_TYPE, MIN_PPS, type Selection, selectedClipIds, Timeline } from './components/Timeline.tsx';
import { cancelProJob, getMedia, getProJob, getProStatus, importFile, mediaExists, startProFix, startProJob, thumbUrl } from './lib/api.ts';
import { formatEta, type ProJob, type ProStatus } from '../shared/pro.ts';
import { useProjectHistory } from './lib/history.ts';
import { playhead, usePlayhead } from './lib/playhead.ts';
import { PreviewEngine } from './lib/previewEngine.ts';
import { type FileHandle, openProject, saveProject, serialize } from './lib/projectFile.ts';

const AUTOSAVE_KEY = 'myeditor:autosave';
const PANELS_KEY = 'myeditor:panels';
const PANELS = { bin: { def: 250, min: 160, max: 520 }, insp: { def: 300, min: 250, max: 640 } };

function readPanels(): { bin: number; insp: number } {
  try {
    const v = JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}') as { bin?: number; insp?: number };
    const ok = (n: unknown, r: { def: number; min: number; max: number }) => (typeof n === 'number' && n >= r.min && n <= r.max ? n : r.def);
    return { bin: ok(v.bin, PANELS.bin), insp: ok(v.insp, PANELS.insp) };
  } catch {
    return { bin: PANELS.bin.def, insp: PANELS.insp.def };
  }
}
const SNAP_KEY = 'myeditor:snapping';

function readSnapping(): boolean {
  try {
    return localStorage.getItem(SNAP_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadAutosave(): Project {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return parseProject(JSON.parse(raw));
  } catch {
    /* no usable autosave */
  }
  return createProject();
}

interface Upload {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/**
 * Where a medium lands. Without a placement: videos at the end of the main
 * track, audio at the playhead. From a timeline drop: the track under the pointer.
 */
type Placement = Partial<DropSpot> & { t: Us };

/** Add a clip for `media` at `pl`; returns the project and the track the clip ended on. */
function placeMedia(p: Project, media: MediaInfo, pl: Placement): { project: Project; trackId: string } {
  let { project, clipId } = addClipFromMedia(p, media, pl.t, pl.mainIndex, pl.trackId);
  const kind: TrackKind = media.has_video ? 'video' : 'audio';
  if (pl.newTrack === kind) project = pruneEmptyTracks(moveClip(project, clipId, { kind: 'new-track', trackKind: kind, at: pl.t }));
  return { project, trackId: findClip(project, clipId)!.track.id };
}

interface ContextMenu {
  clipId: string;
  x: number;
  y: number;
}

export default function App() {
  const history = useProjectHistory(loadAutosave);
  const root = history.project;
  const [path, setPath] = useState<string[]>([]);
  const livePath = useMemo(() => validPath(root, path), [root, path]);
  const view = useMemo(() => getView(root, livePath), [root, livePath]);
  const [selection, setSelection] = useState<Selection>(null);
  const [pps, setPps] = useState(40);
  const [playing, setPlaying] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [savedRevision, setSavedRevision] = useState(history.revision);
  const [snapping, setSnapping] = useState(readSnapping);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [panels, setPanels] = useState(readPanels);
  useEffect(() => {
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
    } catch {
      /* the widths just won't be remembered */
    }
  }, [panels]);
  const fileHandle = useRef<FileHandle | null>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const outerPlayheads = useRef<Us[]>([]);
  const rootRef = useRef(root);
  rootRef.current = root;
  const pathRef = useRef(livePath);
  pathRef.current = livePath;
  const viewRef = useRef(view);
  viewRef.current = view;

  // ---- Edits act on the current view (the project or the inside of a compound) and are written back to the root.
  const { apply: applyRoot, preview: previewRoot, update: updateRoot, undo, redo, reset } = history;
  const toRoot = useCallback((v: Project) => setView(rootRef.current, pathRef.current, v), []);
  const apply = useCallback((next: Project, base?: Project) => applyRoot(toRoot(next), base ? toRoot(base) : undefined), [applyRoot, toRoot]);
  const preview = useCallback((next: Project) => previewRoot(toRoot(next)), [previewRoot, toRoot]);
  const update = useCallback(
    (fn: (v: Project) => Project) => {
      const p = pathRef.current;
      updateRoot((r) => setView(r, p, fn(getView(r, p))));
    },
    [updateRoot],
  );

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((m) => (m === msg ? null : m)), 4500);
  }, []);

  // ---- Mejoras Pro: jobs run on the local server; a finished result replaces the clip's medium (one undo step).
  const [proStatus, setProStatus] = useState<ProStatus | null>(null);
  const [proJobs, setProJobs] = useState<Record<string, ProJob>>({});
  const [comparing, setComparing] = useState<{ after: MediaInfo; original: MediaInfo; clipId: string } | null>(null);
  /** Source start of the clip when its job began: where the result starts in the old medium. */
  const proStarts = useRef(new Map<string, Us>());
  const proSettled = useRef(new Set<string>());

  useEffect(() => {
    getProStatus()
      .then(setProStatus)
      .catch(() => setProStatus({ installed: false, reason: 'No se pudo contactar con el servidor local.', face_s_per_frame: 0.34, voice_s_per_s: 2 }));
  }, []);

  const openCompare = useCallback(
    async (after: MediaInfo, clipId: string) => {
      if (!after.derived) return;
      const original = rootRef.current.media[after.derived.from] ?? (await getMedia(after.derived.from));
      if (!original) return notify('No encuentro el medio original para comparar.');
      setComparing({ after, original, clipId });
    },
    [notify],
  );

  const settle = useCallback(
    (job: ProJob) => {
      if (proSettled.current.has(job.id)) return;
      proSettled.current.add(job.id);
      if (job.status === 'error') return notify(`Mejoras Pro: no se pudo terminar. ${job.error ?? ''}`);
      if (job.status !== 'done' || !job.media) return;
      const r = rootRef.current;
      const next = applyEnhancedMedia(r, job.clipId, job.media, proStarts.current.get(job.id) ?? 0);
      if (next) {
        applyRoot(next);
        notify(job.kind === 'fix' ? 'Palabras arregladas. ⌘Z vuelve a la versión anterior.' : 'Mejoras aplicadas al clip. ⌘Z vuelve al original.');
      } else {
        applyRoot(addMedia(r, job.media));
        notify('El clip ya no existe: la versión mejorada quedó en Medios.');
      }
      void openCompare(job.media, job.clipId);
    },
    [applyRoot, notify, openCompare],
  );

  const activeProJobs = Object.values(proJobs).filter((j) => j.status === 'queued' || j.status === 'running');
  const activeProIds = activeProJobs.map((j) => j.id).join(',');
  useEffect(() => {
    if (!activeProIds) return;
    const timer = window.setInterval(() => {
      for (const id of activeProIds.split(',')) {
        getProJob(id)
          .then((j) => {
            setProJobs((all) => (all[id]?.status === 'cancelled' ? all : { ...all, [id]: j }));
            if (j.status === 'done' || j.status === 'error') settle(j);
          })
          .catch(() => {});
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [activeProIds, settle]);

  const clipAnywhere = (p: Project, clipId: string) =>
    [...p.tracks, ...Object.values(p.compounds ?? {}).flatMap((d) => d.tracks)].flatMap((t) => t.clips).find((c) => c.id === clipId);

  const pro: ProControls = {
    status: proStatus,
    jobFor: (clipId) => Object.values(proJobs).filter((j) => j.clipId === clipId && j.status !== 'cancelled').at(-1),
    start: (clip, options, video, audio, passes) => {
      startProJob({ clipId: clip.id, media: clip.media, start_us: clip.source.start_us, duration_us: clip.source.duration_us, options, video, audio, voice_passes: passes })
        .then((job) => {
          proStarts.current.set(job.id, clip.source.start_us);
          setProJobs((all) => ({ ...all, [job.id]: job }));
        })
        .catch((err: Error) => notify(err.message));
    },
    cancel: (id) => {
      void cancelProJob(id);
      setProJobs((all) => ({ ...all, [id]: { ...all[id], status: 'cancelled' } }));
    },
    compare: (clipId) => {
      const c = clipAnywhere(rootRef.current, clipId);
      const m = c && rootRef.current.media[c.media];
      if (m) void openCompare(m, clipId);
    },
    revert: (clipId) => {
      const c = clipAnywhere(rootRef.current, clipId);
      const from = c && rootRef.current.media[c.media]?.derived?.from;
      if (!from) return;
      void (async () => {
        const original = rootRef.current.media[from] ?? (await getMedia(from));
        const next = original && revertEnhancedMedia(rootRef.current, clipId, original);
        if (!next) return notify('No encuentro el medio original.');
        applyRoot(next);
        notify('Clip devuelto al original. ⌘Z para rehacer la mejora.');
      })();
    },
  };

  useEffect(() => {
    if (livePath.length !== path.length) setPath(livePath);
  }, [livePath, path.length]);

  // Drop selected ids that no longer exist (undo, delete, leaving a compound…).
  useEffect(() => {
    setSelection((s) => {
      if (s?.type === 'clips') {
        const ids = s.ids.filter((id) => findClip(view, id));
        return ids.length === s.ids.length ? s : ids.length ? { type: 'clips', ids } : null;
      }
      if (s?.type === 'transition' && !mainTrack(view).clips.find((c) => c.id === s.id)?.transition_out) return null;
      return s;
    });
  }, [view]);

  // ---- Preview engine
  useEffect(() => {
    const engine = new PreviewEngine(stageRef.current!);
    engine.onPlayingChange = setPlaying;
    engineRef.current = engine;
    engine.setProject(viewRef.current);
    const unsub = playhead.subscribe(() => !engine.playing && engine.sync(playhead.get(), false));
    return () => {
      unsub();
      engine.destroy();
    };
  }, []);
  useEffect(() => engineRef.current?.setProject(view), [view]);

  // ---- Autosave (per-browser convenience; the JSON file is the real save)
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serialize(root));
      } catch {
        /* storage unavailable */
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [root]);

  // ---- Media that the server no longer has (after opening a project)
  const checkMissing = useCallback(async (p: Project) => {
    const ids = Object.values(p.media).filter((m) => m.kind !== 'compound').map((m) => m.id);
    const exists = await Promise.all(ids.map((id) => mediaExists(id).catch(() => false)));
    setMissing(new Set(ids.filter((_, i) => !exists[i])));
  }, []);
  useEffect(() => {
    void checkMissing(rootRef.current);
  }, [checkMissing]);

  // ---- Import
  const importFiles = useCallback(
    async (files: File[], placement?: Placement) => {
      const pl: Placement | undefined = placement && { ...placement };
      for (const file of files) {
        const key = `${file.name}-${Math.random()}`;
        setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
        try {
          const info = await importFile(file, (progress) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress } : x))));
          setUploads((u) => u.filter((x) => x.key !== key));
          const p = rootRef.current;
          // Same content → same id, so it relinks by itself; a changed file with the same name is relinked by name.
          const stale = [...missing].find((id) => id !== info.id && p.media[id]?.name === info.name);
          setMissing((m) => {
            const next = new Set(m);
            next.delete(info.id);
            if (stale) next.delete(stale);
            return next;
          });
          if (stale) {
            updateRoot((cur) => relinkMedia(cur, stale, info));
            notify(`«${info.name}» vuelto a enlazar.`);
          } else if (missing.has(info.id)) {
            notify(`«${info.name}» vuelto a enlazar.`);
          } else {
            const { project: next, trackId } = placeMedia(viewRef.current, info, pl ?? { t: playhead.get() });
            viewRef.current = next;
            apply(next);
            // Several files dropped together go one after another.
            if (pl) {
              const t = next.tracks.find((x) => x.id === trackId);
              if (t?.main) pl.mainIndex = (pl.mainIndex ?? 0) + 1;
              else {
                pl.trackId = trackId;
                pl.newTrack = undefined;
                pl.t += info.duration_us;
              }
            }
          }
        } catch (err) {
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: (err as Error).message } : x)));
          window.setTimeout(() => setUploads((u) => u.filter((x) => x.key !== key)), 6000);
        }
      }
    },
    [apply, missing, notify, updateRoot],
  );

  const addFromBin = useCallback(
    (mediaId: string, placement?: Placement) => {
      const media = rootRef.current.media[mediaId];
      if (!media) return;
      if (missing.has(mediaId)) return notify(`Falta «${media.name}»: vuelve a importarlo.`);
      update((cur) => placeMedia(cur, media, placement ?? { t: playhead.get() }).project);
    },
    [missing, notify, update],
  );

  const removeFromProject = useCallback(
    (mediaId: string) => {
      const p = rootRef.current;
      const media = p.media[mediaId];
      if (!media) return;
      const used = clipsUsingMedia(p, mediaId);
      if (used > 0 && !window.confirm(`«${media.name}» se usa en ${used} clip${used === 1 ? '' : 's'}. ¿Quitarlo del proyecto junto con ${used === 1 ? 'ese clip' : 'esos clips'}?`)) return;
      applyRoot(removeMedia(p, mediaId));
      setMissing((m) => {
        const n = new Set(m);
        n.delete(mediaId);
        return n;
      });
      notify(`«${media.name}» quitado del proyecto. ⌘Z para deshacer.`);
    },
    [applyRoot, notify],
  );

  // ---- Selection helpers
  const selectedIds = selectedClipIds(selection);
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const selectClips = useCallback((ids: string[]) => setSelection(ids.length ? { type: 'clips', ids } : null), []);

  const selectAll = useCallback(() => {
    selectClips(allClips(viewRef.current).filter((c) => !clipLocked(viewRef.current, c.id)).map((c) => c.id));
  }, [selectClips]);

  // ---- Editing commands
  const split = useCallback(() => {
    const t = playhead.get();
    const ids = clipsToSplitMany(viewRef.current, t, selectedRef.current);
    if (!ids.length) return notify('No hay ningún clip desbloqueado bajo el cabezal para cortar.');
    update((cur) => ids.reduce((acc, id) => splitClip(acc, id, t).project, cur));
  }, [notify, update]);

  const removeSelection = useCallback(() => {
    if (!selection) return;
    if (selection.type === 'transition') update((cur) => setTransition(cur, selection.id, null));
    else {
      const locked = selection.ids.filter((id) => clipLocked(viewRef.current, id));
      if (locked.length === selection.ids.length) return notify('Esos clips están en una pista bloqueada.');
      update((cur) => deleteClips(cur, selection.ids));
      if (locked.length) notify(`${locked.length} clip(s) en pistas bloqueadas no se borraron.`);
    }
    setSelection(null);
  }, [notify, selection, update]);

  const separate = useCallback(
    (clipId?: string) => {
      const ids = clipId ? [clipId] : selectedRef.current;
      let next = viewRef.current;
      const created: string[] = [];
      for (const id of ids) {
        const found = findClip(next, id);
        if (!found || found.track.kind !== 'video') continue;
        const r = separateAudio(next, id);
        if (r.audioClipId) {
          next = r.project;
          created.push(r.audioClipId);
        }
      }
      if (!created.length) return notify('Selecciona un clip de vídeo con audio (no separado, no bloqueado, no composición).');
      apply(next);
      selectClips(created);
    },
    [apply, notify, selectClips],
  );

  const unlink = useCallback(
    (clipId: string) => {
      apply(unlinkAudio(viewRef.current, clipId));
      notify('Audio desenlazado: ahora se mueve y recorta por su cuenta.');
    },
    [apply, notify],
  );

  const group = useCallback(() => {
    const next = groupClips(viewRef.current, selectedRef.current);
    if (next === viewRef.current) return notify('Selecciona al menos dos clips desbloqueados para agrupar.');
    apply(next);
    notify('Clips agrupados: se seleccionan y se mueven juntos.');
  }, [apply, notify]);

  const ungroup = useCallback(() => {
    const next = ungroupClips(viewRef.current, selectedRef.current);
    if (next === viewRef.current) return notify('La selección no tiene grupos.');
    apply(next);
    notify('Grupo deshecho.');
  }, [apply, notify]);

  const makeCompound = useCallback(() => {
    const r = createCompound(viewRef.current, selectedRef.current);
    if (r.error || !r.clipId) return notify(r.error ?? 'No se pudo crear la composición.');
    apply(r.project);
    selectClips([r.clipId]);
    notify(
      r.hiddenParts
        ? 'Composición creada. Parte del contenido queda fuera del tramo de la pista principal: alarga la composición por sus bordes para verlo.'
        : 'Composición creada. Doble clic para editar su interior.',
    );
  }, [apply, notify, selectClips]);

  const breakCompound = useCallback(
    (clipId?: string) => {
      const id = clipId ?? selectedRef.current.find((x) => viewRef.current.media[findClip(viewRef.current, x)?.clip.media ?? '']?.kind === 'compound');
      if (!id) return notify('Selecciona una composición.');
      const r = decompose(viewRef.current, id);
      if (r.error) return notify(r.error);
      apply(r.project);
      selectClips(r.ids);
    },
    [apply, notify, selectClips],
  );

  const openCompound = useCallback(
    (clipId: string) => {
      const found = findClip(viewRef.current, clipId);
      const media = found && viewRef.current.media[found.clip.media];
      if (!found || media?.kind !== 'compound') return;
      engineRef.current?.pause();
      outerPlayheads.current.push(playhead.get());
      const inner = Math.max(0, playhead.get() - found.clip.timeline_start_us + found.clip.source.start_us);
      setPath((p) => [...validPath(rootRef.current, p), media.id]);
      setSelection(null);
      playhead.set(inner);
    },
    [],
  );

  const exitCompound = useCallback(() => {
    if (!pathRef.current.length) return;
    engineRef.current?.pause();
    setPath((p) => p.slice(0, -1));
    setSelection(null);
    playhead.set(outerPlayheads.current.pop() ?? 0);
  }, []);

  const trackFlag = useCallback(
    (trackId: string, flag: 'locked' | 'hidden' | 'muted', value: boolean) => {
      apply(setTrackFlag(viewRef.current, trackId, flag, value));
      if (flag === 'locked' && value) {
        const t = viewRef.current.tracks.find((x) => x.id === trackId);
        const inTrack = new Set(t?.clips.map((c) => c.id));
        setSelection((s) => (s?.type === 'clips' ? (s.ids.some((id) => inTrack.has(id)) ? null : s) : s));
      }
    },
    [apply],
  );

  const addTransition = useCallback(
    (videoClipId: string) => {
      const p = viewRef.current;
      if (mainTrack(p).locked) return notify('La pista principal está bloqueada.');
      const d = defaultTransitionFor(p, videoClipId);
      if (d <= 0) return notify('Los clips son demasiado cortos para una transición.');
      apply(setTransition(p, videoClipId, d));
      setSelection({ type: 'transition', id: videoClipId });
    },
    [apply, notify],
  );

  const transitionForSelection = useCallback(() => {
    const clips = mainTrack(viewRef.current).clips;
    const id = selectedRef.current[0];
    let i = id ? clips.findIndex((c) => c.id === id) : -1;
    if (i < 0) i = clips.findIndex((c) => c.timeline_start_us + c.source.duration_us > playhead.get());
    if (i < 0 || i >= clips.length - 1) return notify('Selecciona un clip de la pista principal que tenga otro clip después.');
    addTransition(clips[i].id);
  }, [addTransition, notify]);

  const mark = useCallback(
    (which: 'in' | 'out' | 'clear') => {
      if (pathRef.current.length) return notify('Las marcas de exportación se ponen en el proyecto principal, fuera de la composición.');
      if (which === 'clear') updateRoot((cur) => setRangeMark(setRangeMark(cur, 'in', null), 'out', null));
      else updateRoot((cur) => setRangeMark(cur, which, playhead.get()));
    },
    [notify, updateRoot],
  );

  const zoom = useCallback((factor: number) => setPps((z) => Math.min(MAX_PPS, Math.max(MIN_PPS, z * factor))), []);

  const toggleSnapping = useCallback(() => {
    setSnapping((on) => {
      try {
        localStorage.setItem(SNAP_KEY, on ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !on;
    });
  }, []);

  // ---- Save / open
  const save = useCallback(
    async (saveAs = false) => {
      try {
        fileHandle.current = await saveProject(rootRef.current, fileHandle.current, saveAs);
        setSavedRevision(history.revision);
        notify('Proyecto guardado.');
      } catch (err) {
        notify(`No se pudo guardar: ${(err as Error).message}`);
      }
    },
    [history.revision, notify],
  );

  const open = useCallback(async () => {
    try {
      const result = await openProject();
      if (!result) return;
      engineRef.current?.pause();
      reset(result.project);
      setPath([]);
      fileHandle.current = result.handle;
      setSelection(null);
      playhead.set(0);
      setSavedRevision(-1);
      await checkMissing(result.project);
      notify(`Abierto «${result.project.name}».`);
    } catch (err) {
      notify((err as Error).message);
    }
  }, [checkMissing, notify, reset]);

  const newProject = useCallback(() => {
    if (history.revision !== savedRevision && projectDuration(rootRef.current) > 0 && !window.confirm('¿Empezar un proyecto nuevo? Los cambios sin guardar se perderán.')) return;
    engineRef.current?.pause();
    reset(createProject());
    setPath([]);
    fileHandle.current = null;
    setSelection(null);
    setMissing(new Set());
    playhead.set(0);
  }, [history.revision, reset, savedRevision]);

  // ---- Keyboard shortcuts
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : document.body;
    if (target.closest('input[type=text], textarea, [contenteditable=true]') || exporting || comparing) return;
    const mod = e.metaKey || e.ctrlKey;
    const step = e.shiftKey ? US_PER_S : frameUs(view);
    const seekBy = (d: number) => playhead.set(snapToFrame(view, Math.min(projectDuration(view), Math.max(0, playhead.get() + d))));
    const handled = () => e.preventDefault();
    if (mod && e.code === 'KeyZ') return handled(), e.shiftKey ? redo() : undo();
    if (mod && e.code === 'KeyY') return handled(), redo();
    if (mod && e.code === 'KeyS') return handled(), void save(e.shiftKey);
    if (mod && e.code === 'KeyO') return handled(), void open();
    if (mod && e.code === 'KeyE') return handled(), setExporting(true);
    if (mod && e.code === 'KeyA') return handled(), selectAll();
    if (mod && e.code === 'KeyG') return handled(), e.altKey ? makeCompound() : e.shiftKey ? ungroup() : group();
    if (mod) return;
    if (target.closest('input[type=range]') && e.code.startsWith('Arrow')) return;
    switch (e.code) {
      case 'Space': return handled(), engineRef.current?.toggle();
      case 'KeyS': return handled(), split();
      case 'KeyA': if (e.shiftKey) return handled(), separate(); return;
      case 'KeyI': return handled(), mark('in');
      case 'KeyO': return handled(), mark('out');
      case 'KeyX': return handled(), mark('clear');
      case 'KeyT': return handled(), transitionForSelection();
      case 'KeyN': return handled(), toggleSnapping();
      case 'Delete':
      case 'Backspace': return handled(), removeSelection();
      case 'ArrowLeft': return handled(), seekBy(-step);
      case 'ArrowRight': return handled(), seekBy(step);
      case 'Home': return handled(), playhead.set(0);
      case 'End': return handled(), playhead.set(projectDuration(view));
      case 'Equal':
      case 'NumpadAdd': return handled(), zoom(1.25);
      case 'Minus':
      case 'NumpadSubtract': return handled(), zoom(0.8);
      case 'Escape':
        if (menu) return setMenu(null);
        if (selection) return setSelection(null);
        return exitCompound();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- Drop files anywhere in the window
  const importFilesRef = useRef(importFiles);
  importFilesRef.current = importFiles;
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => isFiles(e) && (depth++, setDragOver(true));
    const leave = (e: DragEvent) => isFiles(e) && --depth <= 0 && (depth = 0, setDragOver(false));
    const over = (e: DragEvent) => isFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      if (e.dataTransfer?.files.length) void importFilesRef.current([...e.dataTransfer.files]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,audio/*,.mkv';
    input.onchange = () => input.files && void importFiles([...input.files]);
    input.click();
  };

  const duration = projectDuration(view);
  const dirty = history.revision !== savedRevision;
  const mediaList = Object.values(root.media).filter((m) => m.kind !== 'compound');
  const selectedVideo = selectedIds.some((id) => findClip(view, id)?.track.kind === 'video');
  const crumbs = livePath.map((id) => root.media[id]?.name ?? 'Composición');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>MyEditor</span>
        </div>
        <input
          className="project-name"
          type="text"
          aria-label="Nombre del proyecto"
          defaultValue={root.name}
          key={root.id}
          onBlur={(e) => e.target.value.trim() && e.target.value !== root.name && applyRoot({ ...root, name: e.target.value.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {dirty && <span className="dirty" title="Cambios sin guardar en archivo (hay copia automática en este navegador)">●</span>}
        <div className="topbar-actions">
          {activeProJobs.length > 0 && (
            <button
              className="pro-chip"
              title="Mejoras Pro en proceso: clic para seleccionar el clip"
              onClick={() => setSelection({ type: 'clips', ids: [activeProJobs[0].clipId] })}
            >
              <span className="pro-chip-bar" style={{ width: `${Math.round(activeProJobs[0].progress * 100)}%` }} />
              <span>
                Mejoras Pro {Math.round(activeProJobs[0].progress * 100)} %{activeProJobs[0].eta_s !== null ? ` · ~${formatEta(activeProJobs[0].eta_s)}` : ''}
                {activeProJobs.length > 1 ? ` (+${activeProJobs.length - 1})` : ''}
              </span>
            </button>
          )}
          <button className="btn ghost" onClick={newProject}>Nuevo</button>
          <button className="btn ghost" onClick={() => void open()} title="Abrir proyecto JSON (⌘O)"><IconOpen /> Abrir</button>
          <button className="btn ghost" onClick={() => void save()} title="Guardar proyecto JSON (⌘S)"><IconSave /> Guardar</button>
          <span className="sep" />
          <button className="icon-btn" onClick={undo} disabled={!history.canUndo} title="Deshacer (⌘Z)" aria-label="Deshacer"><IconUndo /></button>
          <button className="icon-btn" onClick={redo} disabled={!history.canRedo} title="Rehacer (⇧⌘Z)" aria-label="Rehacer"><IconRedo /></button>
          <span className="sep" />
          <button className="btn primary" onClick={() => setExporting(true)} disabled={projectDuration(root) <= 0} title="Exportar MP4 (⌘E)"><IconExport /> Exportar</button>
        </div>
      </header>

      <main className="workspace" style={{ '--bin-w': `${panels.bin}px`, '--insp-w': `${panels.insp}px` } as CSSProperties}>
        <section className="bin">
          <div className="panel-title">
            <h2>Medios</h2>
            <button className="btn small" onClick={pickFiles}><IconImport /> Importar</button>
          </div>
          <div className="bin-list">
            {mediaList.length === 0 && uploads.length === 0 && (
              <button className="bin-empty" onClick={pickFiles}>
                <IconImport width={28} height={28} />
                <strong>Arrastra vídeos y audios aquí</strong>
                <span>o haz clic para elegirlos</span>
              </button>
            )}
            {mediaList.map((m: MediaInfo) => (
              <div
                key={m.id}
                className={`bin-item${missing.has(m.id) ? ' missing' : ''}`}
                draggable={!missing.has(m.id)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => addFromBin(m.id)}
                title={missing.has(m.id) ? 'Falta el archivo en el servidor local: arrástralo otra vez para volver a enlazarlo' : 'Arrastra a la línea de tiempo o haz doble clic para añadir'}
              >
                <div className="bin-thumb">
                  {m.has_video ? <img src={thumbUrl(m.id)} alt="" loading="lazy" /> : <IconWave width={22} height={22} />}
                </div>
                <div className="bin-meta">
                  <span className="bin-name">{m.name}</span>
                  <span className="muted small">
                    {m.has_video ? <IconFilm width={12} height={12} /> : <IconWave width={12} height={12} />} {formatTime(m.duration_us)}
                    {m.has_video && ` · ${m.width}×${m.height}`}
                    {missing.has(m.id) && ' · falta'}
                  </span>
                </div>
                <div className="bin-actions">
                  <button className="icon-btn small" onClick={() => addFromBin(m.id)} aria-label={`Añadir ${m.name} al timeline`} title="Añadir a la línea de tiempo">+</button>
                  <button className="icon-btn small danger" onClick={() => removeFromProject(m.id)} aria-label={`Eliminar ${m.name}`} title="Eliminar del proyecto">
                    <IconTrash width={14} height={14} />
                  </button>
                </div>
              </div>
            ))}
            {uploads.map((u) => (
              <div key={u.key} className={`bin-item uploading${u.error ? ' missing' : ''}`}>
                <div className="bin-meta">
                  <span className="bin-name">{u.name}</span>
                  {u.error ? <span className="error small">{u.error}</span> : (
                    <div className="progress small"><div style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {missing.size > 0 && <p className="warn small">Faltan {missing.size} medio(s). Arrastra los archivos originales para volver a enlazarlos.</p>}
        </section>

        <Splitter
          label="Ancho de Medios"
          side="left"
          width={panels.bin}
          min={PANELS.bin.min}
          max={Math.min(PANELS.bin.max, Math.floor(window.innerWidth * 0.28))}
          defaultWidth={PANELS.bin.def}
          onChange={(bin) => setPanels((w) => ({ ...w, bin }))}
        />

        <section className="viewer">
          <div className="stage-wrap">
            <div className="stage" ref={stageRef}>
              {duration === 0 && <div className="stage-empty">Vista previa</div>}
              {!playing && (
                <TransformBox
                  project={view}
                  clipId={selection?.type === 'clips' && selection.ids.length === 1 ? selection.ids[0] : null}
                  snapping={snapping}
                  preview={preview}
                  apply={apply}
                />
              )}
            </div>
          </div>
          <div className="transport">
            <button className="icon-btn" onClick={() => playhead.set(0)} title="Ir al inicio (Inicio)" aria-label="Ir al inicio"><IconToStart /></button>
            <button className="play-btn" onClick={() => engineRef.current?.toggle()} title="Reproducir / pausar (Espacio)" aria-label={playing ? 'Pausar' : 'Reproducir'}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <Timecode total={duration} />
          </div>
        </section>

        <Splitter
          label="Ancho del panel de edición"
          side="right"
          width={panels.insp}
          min={PANELS.insp.min}
          max={Math.min(PANELS.insp.max, Math.floor(window.innerWidth * 0.42))}
          defaultWidth={PANELS.insp.def}
          onChange={(insp) => setPanels((w) => ({ ...w, insp }))}
        />

        <Inspector
          project={view}
          selection={selection}
          onSelect={setSelection}
          preview={preview}
          apply={apply}
          onSeparateAudio={(id) => separate(id)}
          onUnlink={unlink}
          onDelete={removeSelection}
          onGroup={group}
          onUngroup={ungroup}
          onCompound={makeCompound}
          onDecompose={breakCompound}
          onOpenCompound={openCompound}
          pro={pro}
        />
      </main>

      <section className="editbar">
        {livePath.length > 0 && (
          <div className="crumbs" title="Estás editando el interior de una composición">
            <button className="btn small" onClick={exitCompound} title="Volver (Esc)"><IconBack /> Volver</button>
            <span className="crumb-root">Proyecto</span>
            {crumbs.map((name, i) => (
              <span key={i} className="crumb">› <IconCompound width={13} height={13} /> {name}</span>
            ))}
          </div>
        )}
        <button className="btn ghost" onClick={split} title="Cortar en el cabezal (S)"><IconCut /> Cortar <kbd>S</kbd></button>
        <button className="btn ghost" onClick={removeSelection} disabled={!selection} title="Borrar (⌫)"><IconTrash /> Borrar</button>
        <button className="btn ghost" onClick={() => separate()} disabled={!selectedVideo} title="Separar audio (⇧A)"><IconDetach /> Separar audio</button>
        <button className="btn ghost" onClick={transitionForSelection} title="Transición Mix tras el clip (T)"><IconMix /> Mix</button>
        <span className="sep" />
        <button className="btn ghost" onClick={group} disabled={selectedIds.length < 2} title="Agrupar (⌘G)"><IconGroup /> Agrupar</button>
        <button className="btn ghost" onClick={makeCompound} disabled={!selectedIds.length} title="Crear composición (⌥⌘G)"><IconCompound /> Composición</button>
        <span className="sep" />
        {livePath.length === 0 && (
          <>
            <button className="btn ghost" onClick={() => mark('in')} title="Marcar entrada (I)"><IconMarkIn /> Entrada <kbd>I</kbd></button>
            <button className="btn ghost" onClick={() => mark('out')} title="Marcar salida (O)"><IconMarkOut /> Salida <kbd>O</kbd></button>
            {(root.range.in_us !== null || root.range.out_us !== null) && (
              <button className="btn ghost" onClick={() => mark('clear')} title="Quitar marcas (X)">Quitar tramo</button>
            )}
          </>
        )}
        <span className="spacer" />
        {selectedIds.length > 1 && <span className="sel-count">{selectedIds.length} seleccionados</span>}
        <button
          className={`btn ghost toggle${snapping ? ' on' : ''}`}
          onClick={toggleSnapping}
          aria-pressed={snapping}
          title={`Ajuste magnético ${snapping ? 'activado' : 'desactivado'} (N): encaja clips y cabezal con bordes de clips, cabezal y marcas`}
        >
          <IconMagnet /> Ajuste {snapping ? 'activado' : 'desactivado'} <kbd>N</kbd>
        </button>
        <span className="sep" />
        <button className="icon-btn" onClick={() => zoom(0.8)} aria-label="Alejar" title="Alejar (−)"><IconZoomOut /></button>
        <input
          className="zoom"
          type="range"
          min={Math.log(MIN_PPS)}
          max={Math.log(MAX_PPS)}
          step={0.01}
          value={Math.log(pps)}
          onChange={(e) => setPps(Math.exp(Number(e.target.value)))}
          aria-label="Zoom de la línea de tiempo"
        />
        <button className="icon-btn" onClick={() => zoom(1.25)} aria-label="Acercar" title="Acercar (+)"><IconZoomIn /></button>
      </section>

      <div className={`timeline-wrap${livePath.length ? ' inside' : ''}`}>
        <Timeline
          project={view}
          selection={selection}
          onSelect={setSelection}
          pps={pps}
          setPps={setPps}
          playing={playing}
          snapping={snapping}
          preview={preview}
          apply={apply}
          onAddTransition={addTransition}
          onDropMedia={(id, spot) => addFromBin(id, spot)}
          onDropFiles={(files, spot) => void importFiles(files, spot)}
          onContextMenu={(clipId, x, y) => setMenu({ clipId, x, y })}
          onOpenCompound={openCompound}
          onTrackFlag={trackFlag}
          notify={notify}
        />
      </div>

      {menu && (
        <ClipMenu
          menu={menu}
          project={view}
          selectedIds={selectedIds}
          onClose={() => setMenu(null)}
          onSplit={() => {
            const t = playhead.get();
            update((cur) => splitClip(cur, menu.clipId, t).project);
          }}
          onSeparate={() => separate()}
          onUnlink={() => unlink(menu.clipId)}
          onTransition={() => addTransition(menu.clipId)}
          onGroup={group}
          onUngroup={ungroup}
          onCompound={makeCompound}
          onOpenCompound={() => openCompound(menu.clipId)}
          onDecompose={() => breakCompound(menu.clipId)}
          onDelete={removeSelection}
        />
      )}

      {exporting && <ExportDialog project={root} onClose={() => setExporting(false)} />}
      {comparing && (
        <ProCompare
          key={comparing.after.id}
          after={comparing.after}
          original={comparing.original}
          onClose={() => setComparing(null)}
          fixer={{
            job: pro.jobFor(comparing.clipId),
            apply: (fixes) => {
              const clipId = comparing.clipId;
              startProFix({ clipId, media: comparing.after.id, fixes })
                .then((job) => {
                  proStarts.current.set(job.id, 0); // same range as the current enhanced medium
                  setProJobs((all) => ({ ...all, [job.id]: job }));
                })
                .catch((err: Error) => notify(err.message));
            },
          }}
        />
      )}
      {dragOver && (
        <div className="drop-overlay">
          <IconImport width={40} height={40} />
          <span>Suelta para importar</span>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Timecode({ total }: { total: Us }) {
  const t = usePlayhead();
  return (
    <div className="timecode">
      <span>{formatTime(t, true)}</span>
      <span className="muted"> / {formatTime(total, true)}</span>
    </div>
  );
}

function ClipMenu(props: {
  menu: ContextMenu;
  project: Project;
  selectedIds: string[];
  onClose: () => void;
  onSplit: () => void;
  onSeparate: () => void;
  onUnlink: () => void;
  onTransition: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onCompound: () => void;
  onOpenCompound: () => void;
  onDecompose: () => void;
  onDelete: () => void;
}) {
  const { menu, project, selectedIds } = props;
  const found = findClip(project, menu.clipId);
  const { onClose } = props;
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);
  if (!found) return null;
  const { clip, track } = found;
  const locked = clipLocked(project, clip.id);
  const t = playhead.get();
  const underPlayhead = t > clip.timeline_start_us && t < clip.timeline_start_us + clip.source.duration_us;
  const media = project.media[clip.media];
  const compound = media?.kind === 'compound';
  const main = mainTrack(project).clips;
  const i = main.findIndex((c) => c.id === clip.id);
  const many = selectedIds.length > 1;
  const grouped = selectedIds.some((id) => findClip(project, id)?.clip.group_id);
  const item = (label: string, onClick: () => void, opts: { disabled?: boolean; danger?: boolean; icon?: JSX.Element; kbd?: string } = {}) => (
    <button
      role="menuitem"
      className={`menu-item${opts.danger ? ' danger' : ''}`}
      disabled={opts.disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        onClick();
        onClose();
      }}
    >
      {opts.icon}
      <span>{label}</span>
      {opts.kbd && <kbd>{opts.kbd}</kbd>}
    </button>
  );
  return (
    <div className="menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 330) }}>
      <div className="menu-title">{many ? `${selectedIds.length} clips seleccionados` : media?.name}</div>
      {locked && <div className="menu-note">Pista bloqueada</div>}
      {!many && item('Cortar en el cabezal', props.onSplit, { disabled: !underPlayhead || locked, icon: <IconCut />, kbd: 'S' })}
      {track.kind === 'video' && media?.has_audio && !clip.audio_detached && !compound && item('Separar audio', props.onSeparate, { disabled: locked, icon: <IconDetach />, kbd: '⇧A' })}
      {clip.linked_to && item('Desenlazar del vídeo', props.onUnlink, { disabled: locked, icon: <IconUnlink /> })}
      {!many && track.main && i < main.length - 1 && !clip.transition_out && item('Añadir transición Mix', props.onTransition, { disabled: locked, icon: <IconMix />, kbd: 'T' })}
      {compound && item('Abrir composición', props.onOpenCompound, { icon: <IconCompound />, kbd: 'doble clic' })}
      {compound && item('Descomponer', props.onDecompose, { disabled: locked, icon: <IconCompound /> })}
      {many && item('Agrupar', props.onGroup, { disabled: locked, icon: <IconGroup />, kbd: '⌘G' })}
      {grouped && item('Desagrupar', props.onUngroup, { icon: <IconGroup />, kbd: '⇧⌘G' })}
      {item('Crear composición', props.onCompound, { disabled: locked, icon: <IconCompound />, kbd: '⌥⌘G' })}
      {item(many ? 'Borrar selección' : 'Borrar del timeline', props.onDelete, { danger: true, disabled: locked, icon: <IconTrash />, kbd: '⌫' })}
    </div>
  );
}
