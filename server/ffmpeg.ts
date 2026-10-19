import { spawn } from 'node:child_process';
import type { MediaInfo } from '../shared/model.ts';
import type { VideoEncoder } from '../shared/exportGraph.ts';

export const FFMPEG = process.env.MYEDITOR_FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.MYEDITOR_FFPROBE ?? 'ffprobe';

export function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function detectEncoder(): Promise<VideoEncoder> {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders']);
  return /\bh264_videotoolbox\b/.test(stdout) ? 'h264_videotoolbox' : 'libx264';
}

export async function ffmpegVersion(): Promise<string> {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-version']);
  return stdout.split('\n')[0] ?? 'desconocida';
}

interface ProbeStream {
  codec_type: string;
  width?: number;
  height?: number;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

export async function probe(path: string): Promise<Omit<MediaInfo, 'id' | 'name' | 'file'>> {
  const { code, stdout, stderr } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  if (code !== 0) throw new Error(`FFmpeg no reconoce este archivo: ${stderr.trim().split('\n').pop() ?? ''}`);
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: ProbeStream[] };
  const streams = data.streams ?? [];
  // Cover art in audio files shows up as a video stream; ignore attached pictures by requiring a real duration below.
  const video = streams.find((s) => s.codec_type === 'video' && (s.width ?? 0) > 0);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('No se pudo leer la duración del archivo.');
  let width = video?.width ?? 0;
  let height = video?.height ?? 0;
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const isAudioFile = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(path);
  return {
    duration_us: Math.round(duration * 1_000_000),
    has_video: Boolean(video) && !isAudioFile,
    has_audio: Boolean(audio),
    width,
    height,
  };
}

export async function makeThumbnail(input: string, output: string, durationUs: number): Promise<void> {
  const at = Math.min(1, durationUs / 2_000_000).toFixed(3);
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-ss', at, '-i', input, '-frames:v', '1', '-vf', 'scale=-2:96', '-q:v', '4', output]);
}

export async function makeWaveform(input: string, output: string): Promise<void> {
  await run(FFMPEG, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-filter_complex',
    'aformat=channel_layouts=mono,showwavespic=s=4000x120:colors=white:scale=sqrt',
    '-frames:v',
    '1',
    output,
  ]);
}
