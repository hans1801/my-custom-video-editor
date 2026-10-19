// Translate a project into FFmpeg arguments.
// The project is first flattened (shared/flatten.ts) into layers and sounds;
// the same data drives the preview.
//   base           -> color=black for the whole timeline
//   each piece     -> -ss/-t input, crop to its visible part, scale, setpts offset,
//                     overlay at its position with enable= (in layer order; shared/transform.ts)
//   Mix            -> the incoming piece fades its opacity in (fade alpha) over the outgoing one
//   volume/fades   -> volume=XdB + afade (or a volume expression when a fade started before the piece)
//   placement      -> adelay, then amix over a silent base track
//   I/O range      -> trim/atrim on the final streams
//   hidden / muted -> the track adds no picture / no sound

import { type FlatAudio, flatten } from './flatten.ts';
import { effectiveRange, type Project, US_PER_S } from './model.ts';
import { intersect } from './transform.ts';

export type Resolution = '1080p' | '4k';
export type VideoEncoder = 'h264_videotoolbox' | 'libx264';

export const RESOLUTIONS: Record<Resolution, { width: number; height: number; bitrate: string }> = {
  '1080p': { width: 1920, height: 1080, bitrate: '16M' },
  '4k': { width: 3840, height: 2160, bitrate: '45M' },
};

export interface ExportOptions {
  resolution: Resolution;
  useRange: boolean;
  encoder: VideoEncoder;
  outPath: string;
  /** Resolve a media id to an absolute file path. */
  mediaPath: (mediaId: string) => string;
}

export interface ExportPlan {
  args: string[];
  /** Output duration in µs, used for progress. */
  duration_us: number;
  filterGraph: string;
}

const AUDIO_RATE = 48000;
const sec = (us: number) => (us / US_PER_S).toFixed(6);

/** Audio gain chain for one sound: its volume and every fade around it, in the sound's own time. */
function audioGainFilters(a: FlatAudio): string[] {
  const out = [`volume=${a.gain_db.toFixed(2)}dB`];
  const exprParts: string[] = [];
  for (const e of a.envelopes) {
    const inStart = e.a - a.start_us;
    const outEnd = e.b - a.start_us;
    const fullyInside = inStart >= 0 && outEnd <= a.duration_us;
    if (fullyInside) {
      if (e.fin > 0) out.push(`afade=t=in:st=${sec(inStart)}:d=${sec(e.fin)}`);
      if (e.fout > 0) out.push(`afade=t=out:st=${sec(outEnd - e.fout)}:d=${sec(e.fout)}`);
    } else {
      // The fade began before this piece (e.g. inside a trimmed compound): express it directly.
      if (e.fin > 0) exprParts.push(`min(1,max(0,(t-(${sec(inStart)}))/${sec(e.fin)}))`);
      if (e.fout > 0) exprParts.push(`min(1,max(0,((${sec(outEnd)})-t)/${sec(e.fout)}))`);
    }
  }
  if (exprParts.length) out.push('asetnsamples=n=256', `volume=volume='${exprParts.join('*')}':eval=frame`);
  return out;
}

export function buildExport(p: Project, opts: ExportOptions): ExportPlan {
  const { width: W, height: H, bitrate } = RESOLUTIONS[opts.resolution];
  const fps = `${p.fps.num}/${p.fps.den}`;
  const range = effectiveRange(p, opts.useRange);
  const total = range.end;
  if (range.end - range.start <= 0) throw new Error('No hay nada que exportar: la línea de tiempo está vacía.');

  const flat = flatten(p);
  const inRange = (start: number, dur: number) => start < range.end && start + dur > range.start;

  const inputs: string[] = [];
  const filters: string[] = [];
  const inputOf = new Map<string, { index: number; src: number; dur: number }>();
  let inputCount = 0;
  // One input per piece, seeked to its source range (-ss/-t before -i apply to that input only).
  const pushInput = (key: string, media: string, src: number, dur: number) => {
    inputOf.set(key, { index: inputCount++, src, dur });
    inputs.push('-ss', sec(src), '-t', sec(dur), '-i', opts.mediaPath(media));
    return inputCount - 1;
  };

  // ---- Video: black base, then every piece overlaid in layer order.
  filters.push(`color=c=black:s=${W}x${H}:r=${fps},format=yuv420p,settb=AVTB,trim=duration=${sec(total)}[vb0]`);
  let base = 'vb0';
  let n = 0;
  for (const v of flat.video) {
    if (!inRange(v.start_us, v.duration_us)) continue;
    // Only the part that is visible on the canvas: crop the source to it, scale it to its pixel box.
    const { frame } = v.place;
    const vis = intersect(v.place.view, { x: 0, y: 0, w: 1, h: 1 });
    const X0 = Math.round(vis.x * W);
    const Y0 = Math.round(vis.y * H);
    const cw = Math.round((vis.x + vis.w) * W) - X0;
    const ch = Math.round((vis.y + vis.h) * H) - Y0;
    if (cw < 2 || ch < 2) continue;
    const f = (n: number) => n.toFixed(6);
    const fx = (vis.x - frame.x) / frame.w;
    const fy = (vis.y - frame.y) / frame.h;
    const fw = vis.w / frame.w;
    const fh = vis.h / frame.h;
    const whole = fx < 1e-6 && fy < 1e-6 && fw > 1 - 1e-6 && fh > 1 - 1e-6;
    const idx = pushInput(v.key, v.media, v.src_start_us, v.duration_us);
    n++;
    const chain = [
      `[${idx}:v]setpts=PTS-STARTPTS`,
      ...(whole ? [] : [`crop=w=iw*${f(fw)}:h=ih*${f(fh)}:x=iw*${f(fx)}:y=ih*${f(fy)}:exact=1`]),
      `scale=${cw}:${ch}`,
      'setsar=1',
      `fps=${fps}`,
    ];
    if (v.alpha && v.alpha.dur_us > 0) {
      chain.push('format=yuva420p', `fade=t=in:st=${sec(Math.max(0, v.alpha.start_us - v.start_us))}:d=${sec(v.alpha.dur_us)}:alpha=1`);
    } else chain.push('format=yuv420p');
    chain.push('settb=AVTB', `setpts=PTS+${sec(v.start_us)}/TB[p${n}]`);
    filters.push(chain.join(','));
    filters.push(`[${base}][p${n}]overlay=x=${X0}:y=${Y0}:eof_action=pass:format=yuv420:enable='between(t,${sec(v.start_us)},${sec(v.start_us + v.duration_us)})'[vb${n}]`);
    base = `vb${n}`;
  }
  filters.push(`[${base}]format=yuv420p[vfull]`);

  // ---- Audio: every sound placed on a silent base as long as the timeline.
  filters.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${sec(total)}[abase]`);
  const mixInputs = ['[abase]'];
  let j = 0;
  for (const a of flat.audio) {
    if (!inRange(a.start_us, a.duration_us)) continue;
    // Embedded or separated audio reuses its video piece's input (each stream is consumed once).
    const shared = a.videoKey ? inputOf.get(a.videoKey) : undefined;
    const idx = shared && shared.src === a.src_start_us && shared.dur === a.duration_us ? shared.index : pushInput(a.key, a.media, a.src_start_us, a.duration_us);
    const chain = [
      `[${idx}:a]asetpts=PTS-STARTPTS`,
      `aformat=sample_fmts=fltp:sample_rates=${AUDIO_RATE}:channel_layouts=stereo`,
      ...audioGainFilters(a),
      `adelay=delays=${Math.round((a.start_us / US_PER_S) * AUDIO_RATE)}S:all=1[a${j}]`,
    ];
    filters.push(chain.join(','));
    mixInputs.push(`[a${j}]`);
    j++;
  }
  if (mixInputs.length === 1) filters.push('[abase]anull[afull]');
  else filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0:duration=first:dropout_transition=0[afull]`);

  // ---- Export range (I/O) on the finished streams.
  filters.push(`[vfull]trim=start=${sec(range.start)}:end=${sec(range.end)},setpts=PTS-STARTPTS[vout]`);
  filters.push(`[afull]atrim=start=${sec(range.start)}:end=${sec(range.end)},asetpts=PTS-STARTPTS[aout]`);

  const filterGraph = filters.join(';\n');
  const videoCodec =
    opts.encoder === 'h264_videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-profile:v', 'high', '-allow_sw', '1']
      : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high'];

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...inputs,
    '-filter_complex',
    filterGraph,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...videoCodec,
    '-pix_fmt',
    'yuv420p',
    '-r',
    fps,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    String(AUDIO_RATE),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    opts.outPath,
  ];
  return { args, duration_us: range.end - range.start, filterGraph };
}
