// End-to-end check with generated media only (no user files):
//   2 test clips (testsrc + tone, 10 s) -> import through the real server API ->
//   cut, separate audio, Mix 0.5 s, I/O range of 5 s -> export -> ffprobe.
// Everything it creates lives in a temporary workspace that is deleted at the end.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allClips,
  audioTracks,
  clipEnd,
  createProject,
  findClip,
  type MediaInfo,
  overlayTracks,
  parseProject,
  projectDuration,
  type Project,
  pruneEmptyTracks,
  videoTrack,
} from '../shared/model.ts';
import { createCompound, decompose, getView, setView } from '../shared/compound.ts';
import {
  addClipFromMedia,
  deleteClip,
  deleteClips,
  groupClips,
  moveClip,
  moveSet,
  setTrackFlag,
  ungroupClips,
  removeMedia,
  separateAudio,
  setRangeMark,
  setClipTransform,
  setTransition,
  splitClip,
  trimClip,
  unlinkAudio,
} from '../shared/ops.ts';
import { run } from '../server/ffmpeg.ts';
import { IDENTITY } from '../shared/transform.ts';

const PORT = 5199;
const API = `http://127.0.0.1:${PORT}/api`;
const S = 1_000_000;

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('El servidor no arrancó');
}

async function importFile(path: string, name: string): Promise<MediaInfo> {
  const res = await fetch(`${API}/media?name=${encodeURIComponent(name)}`, { method: 'PUT', body: await readFile(path) });
  if (!res.ok) throw new Error(`import ${name}: ${await res.text()}`);
  return (await res.json()) as MediaInfo;
}

async function exportProject(project: Project, resolution: '1080p' | '4k', useRange: boolean): Promise<string> {
  const res = await fetch(`${API}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, resolution, useRange, fileName: 'smoke' }),
  });
  const { id, error } = (await res.json()) as { id?: string; error?: string };
  if (!id) throw new Error(`export: ${error}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const job = (await (await fetch(`${API}/export/${id}`)).json()) as { status: string; error?: string; path: string };
    if (job.status === 'done') return job.path;
    if (job.status !== 'running') throw new Error(`export ${job.status}: ${job.error}`);
  }
}

async function probe(path: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  const data = JSON.parse(stdout) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', path, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-']);
  const meanDb = Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1] ?? '-999');
  return { duration: Number(data.format.duration), video, audio, meanDb };
}

const tmp = await mkdtemp(join(tmpdir(), 'myeditor-smoke-'));
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, MYEDITOR_WORKSPACE: join(tmp, 'workspace'), MYEDITOR_PORT: String(PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  // 1. Two 10 s test clips with a tone.
  const clipA = join(tmp, 'prueba-a.mp4');
  const clipB = join(tmp, 'prueba-b.mp4');
  const gen = (out: string, src: string, freq: number) =>
    run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', `${src}=size=1280x720:rate=30:duration=10`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=10:sample_rate=48000`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  await Promise.all([gen(clipA, 'testsrc', 440), gen(clipB, 'testsrc2', 660)]);
  const toneFile = join(tmp, 'tono.wav');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6:sample_rate=48000', toneFile]);
  await waitForServer();

  // 2. Import through the API, exactly as the browser does.
  const a = await importFile(clipA, 'prueba-a.mp4');
  const b = await importFile(clipB, 'prueba-b.mp4');
  check('Importar 2 clips', a.has_video && a.has_audio && Math.abs(a.duration_us - 10 * S) < 100_000, `${a.duration_us} µs`);

  // 3. Edit with the same operations the UI uses.
  let p = createProject('smoke');
  p = addClipFromMedia(p, a, 0).project;
  p = addClipFromMedia(p, b, 0).project;
  const firstId = videoTrack(p).clips[0].id;
  p = splitClip(p, firstId, 4 * S).project; // cut A at 4 s
  check('Cortar en 4 s', videoTrack(p).clips.length === 3 && videoTrack(p).clips[0].source.duration_us === 4 * S);

  const [, aRight, bClip] = videoTrack(p).clips;
  p = separateAudio(p, aRight.id).project;
  p = separateAudio(p, bClip.id).project;
  check('Separar audio', audioTracks(p)[0].clips.length === 2 && videoTrack(p).clips[1].audio_detached === true);

  p = setTransition(p, aRight.id, 500_000);
  check('Mix de 0,5 s', videoTrack(p).clips[1].transition_out?.duration_us === 500_000);
  check('Duración total 19,5 s', projectDuration(p) === 19.5 * S, `${projectDuration(p)} µs`);

  p = setRangeMark(p, 'in', 4 * S);
  p = setRangeMark(p, 'out', 9 * S); // timeline: A1 0–4, A2 4–10, B 9.5–19.5 (Mix overlaps 9.5–10)
  check('Tramo I/O de 5 s', p.range.out_us! - p.range.in_us! === 5 * S);

  // 4. Export the 5 s range at 1080p and check it.
  const outRange = await exportProject(p, '1080p', true);
  const r = await probe(outRange);
  check('Tramo exportado dura 5 s', Math.abs(r.duration - 5) < 0.05, `${r.duration.toFixed(3)} s`);
  check('Tramo tiene audio AAC', r.audio?.codec_name === 'aac', r.audio?.codec_name ?? 'sin audio');
  check('El audio no es silencio', r.meanDb > -40, `mean ${r.meanDb} dB`);
  check('Vídeo 1920x1080 H.264', r.video?.width === 1920 && r.video?.height === 1080 && r.video?.codec_name === 'h264');

  // 5. A range that contains the Mix transition (8 s – 13 s), and the full project in 4K.
  const pMix = setRangeMark(setRangeMark(p, 'in', 8 * S), 'out', 13 * S);
  const m = await probe(await exportProject(pMix, '1080p', true));
  check('Tramo con la transición dura 5 s y tiene audio', Math.abs(m.duration - 5) < 0.05 && m.meanDb > -40, `${m.duration.toFixed(3)} s, ${m.meanDb} dB`);

  const full = await probe(await exportProject(p, '4k', false));
  check('Proyecto completo en 4K dura 19,5 s', Math.abs(full.duration - 19.5) < 0.05, `${full.duration.toFixed(3)} s`);
  check('4K es 3840x2160', full.video?.width === 3840 && full.video?.height === 2160);

  // 6. Save / open JSON round trip, then trim and delete (pure edits, no render).
  const reopened = parseProject(JSON.parse(JSON.stringify(p, null, 2)));
  check('Guardar y abrir JSON conserva el proyecto', JSON.stringify(reopened.tracks) === JSON.stringify(p.tracks) && JSON.stringify(reopened.media) === JSON.stringify(p.media));
  const bId = videoTrack(p).clips[2].id;
  const trimmed = trimClip(p, bId, 'end', -2 * S);
  check('Recortar el final de B 2 s', projectDuration(trimmed) === 17.5 * S, `${projectDuration(trimmed)} µs`);
  const aRightId = videoTrack(p).clips[1].id;
  const trimmedLinked = trimClip(p, allClips(p).find((c) => c.linked_to === aRightId)!.id, 'start', 1 * S);
  check('Recortar el audio separado recorta también su vídeo', videoTrack(trimmedLinked).clips[1].source.start_us === 5 * S && audioTracks(trimmedLinked)[0].clips[0].source.start_us === 5 * S);
  const deleted = deleteClip(p, videoTrack(p).clips[0].id);
  check('Borrar el primer clip cierra el hueco', videoTrack(deleted).clips[0].timeline_start_us === 0 && projectDuration(deleted) === 15.5 * S, `${projectDuration(deleted)} µs`);

  // 7. Multi-track editing (magnetic main track + free secondary tracks).
  {
    let q = createProject('pistas');
    q = addClipFromMedia(q, a, 0).project; // main: A 0–10
    q = addClipFromMedia(q, b, 0).project; // main: B 10–20
    const [qa, qb] = videoTrack(q).clips;
    const reordered = moveClip(q, qb.id, { kind: 'main', index: 0 });
    check('Reordenar la pista principal (B antes que A)', videoTrack(reordered).clips[0].id === qb.id && videoTrack(reordered).clips[1].timeline_start_us === 10 * S);

    const toOverlay = pruneEmptyTracks(moveClip(q, qb.id, { kind: 'new-track', trackKind: 'video', at: 3 * S }));
    const ov = overlayTracks(toOverlay);
    check('Mover B a una pista de vídeo nueva (superpuesta)', ov.length === 1 && ov[0].clips[0].timeline_start_us === 3 * S);
    check('La pista principal se cierra sola al sacar B', videoTrack(toOverlay).clips.length === 1 && projectDuration(toOverlay) === 13 * S, `${projectDuration(toOverlay)} µs`);

    const backToMain = moveClip(toOverlay, qb.id, { kind: 'main', index: 0 });
    check('Volver a meter B en la principal (intercalar al inicio)', videoTrack(pruneEmptyTracks(backToMain)).clips[0].id === qb.id && overlayTracks(pruneEmptyTracks(backToMain)).length === 0);

    const toAudio = moveClip(q, qa.id, { kind: 'new-track', trackKind: 'audio', at: 0 });
    check('Un vídeo no puede ir a una pista de audio', toAudio === q);

    // Audio clips on secondary tracks: no ripple, overlaps go to a new track.
    let r2 = addClipFromMedia(q, { ...a, id: 'tono-audio', name: 'tono.wav', has_video: false }, 2 * S);
    const tone1 = r2.clipId;
    r2 = addClipFromMedia(r2.project, { ...a, id: 'tono-audio', name: 'tono.wav', has_video: false }, 15 * S);
    const tone2 = r2.clipId;
    let w = r2.project;
    check('Dos audios sin solaparse comparten pista', audioTracks(w)[0].clips.length === 2);
    const overlapping = addClipFromMedia(w, { ...a, id: 'tono-audio', name: 'tono.wav', has_video: false }, 5 * S);
    check('Un audio que se solaparía va a una pista nueva', audioTracks(overlapping.project).length === 2);
    const afterDelete = deleteClip(w, tone1);
    check('Borrar en pista secundaria no desplaza nada', findClip(afterDelete, tone2)!.clip.timeline_start_us === 15 * S && projectDuration(afterDelete) === 25 * S);
    const delMain = deleteClip(w, qa.id);
    check('Borrar en la principal arrastra los audios asociados al clip siguiente', findClip(delMain, tone2)!.clip.timeline_start_us === 5 * S && findClip(delMain, tone1)!.clip.timeline_start_us === 2 * S);
    const trimmedFree = trimClip(w, tone1, 'end', 10 * S);
    check('Recortar un audio libre se detiene en el siguiente clip', clipEnd(findClip(trimmedFree, tone1)!.clip) === 12 * S);
    const movedFree = moveClip(w, tone2, { kind: 'track', trackId: audioTracks(w)[0].id, at: 4 * S });
    check('Mover un audio encima de otro lo lleva a una pista nueva', audioTracks(movedFree).length === 2 && findClip(movedFree, tone2)!.clip.timeline_start_us === 4 * S);

    // Separated audio: linked, can change track, unlink makes it free.
    const sep = separateAudio(w, qb.id);
    w = sep.project;
    const linkedTrack = findClip(w, sep.audioClipId!)!.track;
    check('El audio separado va a la primera pista con hueco', linkedTrack.kind === 'audio' && findClip(w, sep.audioClipId!)!.clip.timeline_start_us === 10 * S);
    const linkedMoved = moveClip(w, sep.audioClipId!, { kind: 'track', trackId: audioTracks(w)[0].id, at: 0 });
    check('El audio enlazado no se mueve en el tiempo', findClip(linkedMoved, sep.audioClipId!)!.clip.timeline_start_us === 10 * S);
    const freed = moveClip(unlinkAudio(w, sep.audioClipId!), sep.audioClipId!, { kind: 'new-track', trackKind: 'audio', at: 1 * S });
    check('Desenlazado, el audio se mueve libremente', findClip(freed, sep.audioClipId!)!.clip.timeline_start_us === 1 * S);

    const noMedia = removeMedia(w, b.id);
    check('Eliminar un medio quita sus clips (y su audio separado)', !noMedia.media[b.id] && allClips(noMedia).every((c) => c.media !== b.id));

    // A v1 project (two fixed tracks) still opens.
    const v1 = { ...JSON.parse(JSON.stringify(q)), schema_version: 1, tracks: [{ id: 'video', kind: 'video', clips: videoTrack(q).clips }, { id: 'audio', kind: 'audio', clips: [] }] };
    const migrated = parseProject(v1);
    check('Abrir un proyecto v1 lo migra (pista principal)', migrated.schema_version === 3 && videoTrack(migrated).id === 'video' && videoTrack(migrated).clips.length === 2);

    // Export with an overlay: B on top of A from 3 s to 13 s.
    const withOverlay = await exportProject(toOverlay, '1080p', false);
    const ovExport = await probe(withOverlay);
    check('Exportar con pista superpuesta dura 13 s y tiene audio', Math.abs(ovExport.duration - 13) < 0.05 && ovExport.meanDb > -40, `${ovExport.duration.toFixed(3)} s`);
    const mainOnly = await exportProject(deleteClip(toOverlay, qb.id), '1080p', false);
    /** PSNR (dB) between the frames of two files at time t; Infinity when identical. */
    const psnr = async (f1: string, f2: string, t: number) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-ss', String(t), '-i', f1, '-ss', String(t), '-i', f2, '-frames:v', '1', '-lavfi', 'psnr', '-f', 'null', '-']);
      const m = /average:(inf|[\d.]+)/.exec(stderr);
      return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : -1;
    };
    const same = async (f1: string, f2: string, t: number) => (await psnr(f1, f2, t)) > 40;
    /** PSNR of one 200×200 box of two frames. */
    const psnrBox = async (f1: string, f2: string, t: number, x: number, y: number) => {
      const box = `crop=200:200:${x}:${y}`;
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-ss', String(t), '-i', f1, '-ss', String(t), '-i', f2, '-frames:v', '1', '-lavfi', `[0:v]${box}[a];[1:v]${box}[b];[a][b]psnr`, '-f', 'null', '-']);
      const m = /average:(inf|[\d.]+)/.exec(stderr);
      return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : -1;
    };
    check('La pista superpuesta se ve encima de la principal', !(await same(withOverlay, mainOnly, 5)) && (await same(withOverlay, mainOnly, 1)));

    // 8. Linkage, multi-selection, groups, compounds and track controls.
    const tone = await importFile(toneFile, 'tono.wav');
    let L = createProject('enlaces');
    L = addClipFromMedia(L, a, 0).project; // A 0–10
    L = addClipFromMedia(L, b, 0).project; // B 10–20
    L = addClipFromMedia(L, a, 0).project; // C 20–30
    const [A, B, C] = videoTrack(L).clips;
    const put = (proj: Project, at: number) => {
      const r = addClipFromMedia(proj, tone, at * S);
      return { proj: r.project, id: r.clipId };
    };
    let r8 = put(L, 2); // Y 2–8: only over A
    const Y = r8.id;
    r8 = put(r8.proj, 19); // X 19–25: 1 s over B, 5 s over C → belongs to C although it starts before it
    const X = r8.id;
    r8 = put(r8.proj, 35); // Z 35–41: over nothing → independent
    const Z = r8.id;
    L = r8.proj;
    const at = (proj: Project, id: string) => findClip(proj, id)!.clip.timeline_start_us / S;

    const movedC = moveSet(L, [C.id], C.id, { kind: 'main', index: 1, at: 10 * S }); // A, C, B
    check('Mover un clip principal arrastra lo que se solapa con él aunque empiece antes', at(movedC, X) === 9, `X en ${at(movedC, X)} s`);
    check('…sin mover lo asociado a otros clips ni lo independiente', at(movedC, Y) === 2 && at(movedC, Z) === 35);

    const trimmedA = trimClip(L, A.id, 'end', -2 * S);
    check('Recortar un clip principal: sus asociados se quedan', at(trimmedA, Y) === 2);
    check('…y los asociados a los clips siguientes se desplazan con ellos', at(trimmedA, X) === 17 && at(trimmedA, Z) === 35, `X ${at(trimmedA, X)} s`);

    const lockedAudio = setTrackFlag(L, findClip(L, X)!.track.id, 'locked', true);
    const trimmedLocked = trimClip(lockedAudio, A.id, 'end', -2 * S);
    check('Una pista bloqueada no se desplaza con el ripple', at(trimmedLocked, X) === 19);
    check('Un clip bloqueado no se borra ni se mueve', deleteClips(lockedAudio, [X]) === lockedAudio && moveSet(lockedAudio, [X], X, { kind: 'track', trackId: findClip(L, X)!.track.id, at: 0 }) === lockedAudio);

    const multi = moveSet(L, [Y, Z], Y, { kind: 'track', trackId: findClip(L, Y)!.track.id, at: 4 * S });
    check('Mover varios clips seleccionados a la vez', at(multi, Y) === 4 && at(multi, Z) === 37);
    const block = moveSet(L, [A.id, B.id], A.id, { kind: 'main', index: 1, at: 29 * S });
    check('Mover un bloque de clips principales (orden C, A, B)', videoTrack(block).clips.map((c) => c.id).join() === [C.id, A.id, B.id].join());

    const grouped = groupClips(L, [Y, Z]);
    const movedGroup = moveSet(grouped, [Y], Y, { kind: 'track', trackId: findClip(L, Y)!.track.id, at: 3 * S });
    check('Un grupo se mueve junto aunque se arrastre un solo clip', at(movedGroup, Y) === 3 && at(movedGroup, Z) === 36);
    const ungrouped = ungroupClips(movedGroup, [Y]);
    check('Desagrupar devuelve la independencia', at(moveSet(ungrouped, [Y], Y, { kind: 'track', trackId: findClip(L, Y)!.track.id, at: 0 }), Z) === 36);

    // Compound: A + Y become one clip; the picture and the sound must not change.
    const before = await exportProject(L, '1080p', false);
    const comp = createCompound(L, [A.id, Y]);
    check('Crear composición con un clip principal y un audio', Boolean(comp.clipId) && videoTrack(comp.project).clips.length === 3 && !findClip(comp.project, Y) && projectDuration(comp.project) === projectDuration(L));
    const afterComp = await exportProject(comp.project, '1080p', false);
    check('La composición se exporta igual que los clips originales', (await same(afterComp, before, 1)) && (await same(afterComp, before, 15)), `PSNR ${(await psnr(afterComp, before, 1)).toFixed(1)} dB`);
    const pc = await probe(afterComp);
    check('…con su audio', Math.abs(pc.duration - projectDuration(L) / S) < 0.05 && pc.meanDb > -40, `${pc.duration.toFixed(2)} s, ${pc.meanDb} dB`);

    const cid = findClip(comp.project, comp.clipId!)!.clip.media;
    const inside = getView(comp.project, [cid]);
    const editedInside = setView(comp.project, [cid], trimClip(inside, A.id, 'end', -4 * S));
    // Inside: A trimmed to 6 s; the inner audio (2–8 s) now sets the length: 8 s.
    check('Editar dentro de la composición se refleja fuera', comp.project.media[cid].duration_us === 10 * S && editedInside.media[cid].duration_us === 8 * S && videoTrack(editedInside).clips[0].source.duration_us === 8 * S);
    const back = decompose(comp.project, comp.clipId!);
    check('Descomponer recupera los clips originales en su sitio', videoTrack(back.project).clips[0].timeline_start_us === 0 && back.ids.length === 2 && !back.project.compounds?.[cid]);
    const afterBack = await exportProject(back.project, '1080p', false);
    check('…y se exporta igual que antes', await same(afterBack, before, 1));
    const hiddenTail = createCompound(L, [A.id, X]); // X (19–25) sticks out of A's 0–10 block
    const restored = decompose(hiddenTail.project, hiddenTail.clipId!);
    const xBack = allClips(restored.project).find((c) => c.media === tone.id && c.timeline_start_us === 19 * S);
    check('Descomponer devuelve entero un audio que quedó oculto en parte', hiddenTail.hiddenParts === true && xBack?.source.duration_us === 6 * S);

    // Hidden / muted tracks.
    const hidden = setTrackFlag(toOverlay, overlayTracks(toOverlay)[0].id, 'hidden', true);
    check('Ocultar la pista superpuesta la quita de la exportación', await same(await exportProject(hidden, '1080p', false), mainOnly, 5));
    let onlyTone = createProject('silencio');
    onlyTone = addClipFromMedia(onlyTone, tone, 0).project;
    const mutedTone = setTrackFlag(onlyTone, audioTracks(onlyTone)[0].id, 'muted', true);
    const loud = await probe(await exportProject(onlyTone, '1080p', false));
    const silent = await probe(await exportProject(mutedTone, '1080p', false));
    check('Silenciar una pista quita su sonido sin tocar el volumen de los clips', loud.meanDb > -40 && silent.meanDb < -80 && findClip(mutedTone, audioTracks(onlyTone)[0].clips[0].id)!.clip.gain_db === 0, `${loud.meanDb} → ${silent.meanDb} dB`);

    // 9. Position, scale and crop (shared/transform.ts).
    /** Mean brightness (0–255) of a 40×40 box at (x, y) of the frame at t. */
    const luma = async (file: string, t: number, x: number, y: number) => {
      const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=40:40:${x}:${y},signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-']);
      return Number(/YAVG=([\d.]+)/.exec(stderr)?.[1] ?? -1);
    };
    const dark = (v: number) => v >= 0 && v < 24;
    let solo = createProject('transform');
    solo = addClipFromMedia(solo, a, 0).project;
    const soloId = videoTrack(solo).clips[0].id;
    const plain = await exportProject(solo, '1080p', false);
    const half = await exportProject(setClipTransform(solo, soloId, { ...IDENTITY, scale: 0.5 }), '1080p', false);
    // testsrc's first column is black and its last one white: measure the top-right corner.
    const corner = [await luma(plain, 2, 1860, 20), await luma(half, 2, 1860, 20), await luma(half, 2, 940, 520)];
    check('Escala 50 %: la imagen se encoge al centro', !dark(corner[0]) && dark(corner[1]) && !dark(corner[2]), corner.map((v) => v.toFixed(0)).join(' / '));
    const moved = await exportProject(setClipTransform(solo, soloId, { ...IDENTITY, scale: 0.5, x: 0.25 }), '1080p', false);
    check('Posición: 25 % a la derecha', dark(await luma(moved, 2, 500, 520)) && !dark(await luma(moved, 2, 1420, 520)));
    const cropped = await exportProject(setClipTransform(solo, soloId, { ...IDENTITY, crop: { left: 0.5, right: 0, top: 0, bottom: 0 } }), '1080p', false);
    check('Recorte izquierdo 50 %: la mitad izquierda queda vacía y la derecha no se mueve', dark(await luma(cropped, 2, 300, 520)) && (await psnrBox(cropped, plain, 2, 1200, 300)) > 35);
    const overlaySmall = (() => {
      const ov = overlayTracks(toOverlay)[0].clips[0].id;
      return setClipTransform(toOverlay, ov, { ...IDENTITY, scale: 0.4, x: 0.25, y: 0.25 });
    })();
    const pip = await exportProject(overlaySmall, '1080p', false);
    check('Una superpuesta pequeña deja ver la principal alrededor (sin bordes negros)', (await psnrBox(pip, mainOnly, 5, 100, 100)) > 35 && !(await same(pip, mainOnly, 5)));
    const split = splitClip(setClipTransform(solo, soloId, { ...IDENTITY, scale: 0.7 }), soloId, 3 * S).project;
    check('Cortar conserva la transformación en las dos partes', videoTrack(split).clips.every((c) => c.transform?.scale === 0.7));
    check('Guardar y abrir JSON conserva la transformación', parseProject(JSON.parse(JSON.stringify(split))).tracks[0].clips[1].transform?.scale === 0.7);
    // A compound's transform applies to everything inside and survives taking it apart.
    const cmp = createCompound(toOverlay, [videoTrack(toOverlay).clips[0].id, overlayTracks(toOverlay)[0].clips[0].id]);
    const cmpT = setClipTransform(cmp.project, cmp.clipId!, { x: -0.1, y: 0.05, scale: 0.6, crop: { left: 0.1, right: 0, top: 0.2, bottom: 0 } });
    const cmpFile = await exportProject(cmpT, '1080p', false);
    const apart = decompose(cmpT, cmp.clipId!);
    const apartFile = await exportProject(apart.project, '1080p', false);
    check('Escalar una composición encoge todo su contenido', dark(await luma(cmpFile, 5, 1860, 1020)) && !dark(await luma(cmpFile, 5, 700, 560)));
    check('Descomponer una composición transformada se ve igual', (await same(cmpFile, apartFile, 1)) && (await same(cmpFile, apartFile, 5)), `PSNR ${(await psnr(cmpFile, apartFile, 5)).toFixed(1)} dB`);
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.kill('SIGTERM');
  await rm(tmp, { recursive: true, force: true });
  console.log(`Archivos de prueba borrados (${tmp}).`);
}

console.log(failures ? `\n${failures} comprobación(es) fallaron` : '\nTodo OK');
process.exit(failures ? 1 : 0);
