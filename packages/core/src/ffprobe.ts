import { spawnSync } from 'node:child_process';

/**
 * Dependency-free ffprobe helpers: no imports from other @etvideo/core modules
 * (only node:child_process). media.ts already imports addClip from
 * tracks/operations.ts, so tracks/operations.ts importing probeRecordingMedia
 * back from media.ts would be circular; both import it from here instead.
 */
export function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function fpsFromStream(video: any): number {
  const fpsText = video.avg_frame_rate || video.r_frame_rate || '0/1';
  const [num, den] = String(fpsText).split('/').map(Number);
  return den ? num / den : Number(fpsText) || 0;
}

export type RecordingProbe = {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  video?: { width: number; height: number; fps: number; codec?: string; pixelFormat?: string };
  audio?: { sampleRate?: number; channels?: number; codec?: string };
};

export function probeRecordingMedia(filePath: string): RecordingProbe {
  const stdout = run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  const audio = data.streams?.find((s: any) => s.codec_type === 'audio');
  const durationSec = Number(data.format?.duration || video?.duration || audio?.duration || 0);
  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    video: video ? { width: Number(video.width || 0), height: Number(video.height || 0), fps: fpsFromStream(video), codec: video.codec_name || undefined, pixelFormat: video.pix_fmt || undefined } : undefined,
    audio: audio ? { sampleRate: audio.sample_rate ? Number(audio.sample_rate) : undefined, channels: audio.channels ? Number(audio.channels) : undefined, codec: audio.codec_name || undefined } : undefined
  };
}
