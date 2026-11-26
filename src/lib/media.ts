import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { MediaInfo } from './types';

export function openInput(file: Blob): Input {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

/** Read everything we need to know about the source so export can match it exactly. */
export async function probe(file: File): Promise<MediaInfo> {
  const input = openInput(file);
  try {
    const format = await input.getFormat();
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error('This file has no video track.');
    const duration = await input.computeDuration();
    let fps: number | null = null;
    let videoBitrate: number | null = null;
    try {
      const stats = await video.computePacketStats(600);
      if (Number.isFinite(stats.averagePacketRate)) fps = Math.round(stats.averagePacketRate * 100) / 100;
      if (Number.isFinite(stats.averageBitrate)) videoBitrate = Math.round(stats.averageBitrate);
    } catch {
      /* stats are a nicety */
    }
    let hdr = false;
    try {
      hdr = await video.hasHighDynamicRange();
    } catch {
      /* ignore */
    }
    return {
      name: file.name,
      size: file.size,
      mime: file.type || format.mimeType,
      duration,
      width: video.displayWidth,
      height: video.displayHeight,
      codedWidth: video.codedWidth,
      codedHeight: video.codedHeight,
      rotation: video.rotation,
      fps,
      videoCodec: video.codec,
      audioCodec: audio?.codec ?? null,
      videoBitrate,
      hasAudio: !!audio,
      container: format.name,
      hdr,
    };
  } finally {
    input.dispose();
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatTime(t: number, withMs = true): string {
  if (!Number.isFinite(t)) t = 0;
  const neg = t < 0;
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t * 1000) % 1000);
  const core = `${h ? h + ':' : ''}${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
  return (neg ? '-' : '') + core + (withMs ? '.' + String(Math.floor(ms / 10)).padStart(2, '0') : '');
}

/** Parse "1:02.5", "62.5", "00:01:02,500" → seconds. Returns NaN if invalid. */
export function parseTime(s: string): number {
  const clean = s.trim().replace(',', '.');
  if (!clean) return NaN;
  const parts = clean.split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
