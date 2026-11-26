/**
 * Export pipeline (WebCodecs via Mediabunny).
 *
 *  Burn-in:  demux → decode each frame → draw frame + captions on a canvas at the source's exact
 *            display resolution → hardware encode → mux. Audio packets are copied bit-for-bit
 *            (no re-encode), frame timestamps are preserved (VFR stays VFR), metadata tags are kept.
 *
 *  Colour: frames are converted on the GPU to BT.709 limited-range 4:2:0 and tagged as such —
 *          the same thing cameras, phones and NLEs deliver — so platforms re-encode them correctly.
 */
import {
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  WebMOutputFormat,
  canEncodeVideo,
  getFirstEncodableVideoCodec,
  type OutputFormat,
  type Target,
  type VideoCodec,
} from 'mediabunny';
import { openInput } from './media';
import { drawCaptions } from './render';
import { ensureFont } from './fonts';
import { Yuv420Converter } from './yuv';
import type { CaptionStyle, Cue, MediaInfo } from './types';

export type ExportQuality = 'match' | 'high' | 'smaller';

export interface ExportOptions {
  quality: ExportQuality;
  onProgress: (p: number, etaSec: number | null) => void;
  signal: AbortSignal;
}

export interface ExportResult {
  file: File;
  codec: string;
  width: number;
  height: number;
  bitrate: number | null;
  notes: string[];
}

export function webCodecsSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

async function makeTarget(ext: string): Promise<{ target: Target; streaming: boolean; finish: (name: string, mime: string) => Promise<File> }> {
  // Disk-backed output (OPFS) keeps memory flat on phones, even for long 4K videos.
  try {
    const root = await navigator.storage.getDirectory();
    // Clear exports from previous sessions.
    for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (name.startsWith('ziticap-export-')) await root.removeEntry(name).catch(() => {});
    }
    const handle = await root.getFileHandle(`ziticap-export-${Date.now()}.${ext}`, { create: true });
    const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    return {
      target: new StreamTarget(writable as unknown as WritableStream, { chunked: true }),
      streaming: true,
      finish: async (name, mime) => {
        const f = await handle.getFile();
        return new File([f], name, { type: mime });
      },
    };
  } catch {
    const target = new BufferTarget();
    return {
      target,
      streaming: false,
      finish: async (name, mime) => new File([target.buffer!], name, { type: mime }),
    };
  }
}

function pickContainer(media: MediaInfo): { kind: 'mp4' | 'webm'; ext: string; mime: string } {
  const c = media.container.toLowerCase();
  if (c.includes('webm')) return { kind: 'webm', ext: 'webm', mime: 'video/webm' };
  return { kind: 'mp4', ext: 'mp4', mime: 'video/mp4' };
}

function makeFormat(kind: 'mp4' | 'webm', streaming: boolean): OutputFormat {
  if (kind === 'webm') return new WebMOutputFormat();
  // Fast Start (moov first) so the file plays instantly when uploaded/streamed.
  return new Mp4OutputFormat({ fastStart: streaming ? 'reserve' : 'in-memory' });
}

/** Estimate a bitrate that matches the source's quality for the chosen codec. */
function targetBitrate(media: MediaInfo, codec: VideoCodec, q: ExportQuality, W: number, H: number): number | null {
  const fps = media.fps && media.fps > 0 ? Math.min(media.fps, 120) : 30;
  // Rough relative efficiency vs H.264.
  const eff: Record<string, number> = { avc: 1, hevc: 0.6, vp9: 0.65, av1: 0.5, vp8: 1.1 };
  const srcEff = eff[media.videoCodec ?? 'avc'] ?? 1;
  const dstEff = eff[codec] ?? 1;
  const bppFloor = q === 'high' ? 0.12 : q === 'smaller' ? 0.035 : 0.075; // bits per pixel per frame for H.264
  const floor = W * H * fps * bppFloor * dstEff;
  if (q === 'smaller') return Math.round(floor);
  if (!media.videoBitrate) return Math.round(floor * 1.4);
  const matched = (media.videoBitrate * dstEff) / srcEff;
  // Captions add hard edges that need a few extra bits to stay crisp.
  const want = q === 'high' ? matched * 1.5 : matched * 1.1;
  return Math.round(Math.min(150e6, Math.max(want, floor)));
}

export async function exportVideo(file: File, media: MediaInfo, cues: Cue[], style: CaptionStyle, opts: ExportOptions): Promise<ExportResult> {
  if (!webCodecsSupported()) throw new Error('This browser can’t encode video. Use a current Chrome, Edge, Safari (iOS 17+), or Firefox.');
  const cont = pickContainer(media);
  const { target, streaming, finish } = await makeTarget(cont.ext);
  const output = new Output({ format: makeFormat(cont.kind, streaming), target });
  const input = openInput(file);
  const notes: string[] = [];
  const baseName = media.name.replace(/\.[^.]+$/, '');
  let wakeLock: { release(): Promise<void> } | null = null;
  try {
    wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
  } catch {
    /* optional */
  }

  try {
    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) throw new Error('No video track found.');
    const sorted = [...cues].sort((a, b) => a.start - b.start);

    // ---------- Burn-in ----------
    await ensureFont(style, sorted);
    let W = vTrack.displayWidth;
    let H = vTrack.displayHeight;
    // 4:2:0 encoders need even dimensions.
    if (W % 2) W -= 1;
    if (H % 2) H -= 1;

    const supported = output.format.getSupportedVideoCodecs();
    const preferred: VideoCodec[] = [];
    if (media.videoCodec && supported.includes(media.videoCodec as VideoCodec)) preferred.push(media.videoCodec as VideoCodec);
    const fallbacks: VideoCodec[] = cont.kind === 'webm' ? ['vp9', 'av1', 'vp8'] : ['avc', 'hevc', 'av1', 'vp9'];
    for (const c of fallbacks) if (supported.includes(c) && !preferred.includes(c)) preferred.push(c);

    let codec: VideoCodec | null = null;
    let bitrate: number | null = null;
    for (const c of preferred) {
      const br = targetBitrate(media, c, opts.quality, W, H);
      if (await canEncodeVideo(c, { width: W, height: H, quality: br ? new Quality({ bitrate: br }) : new Quality('high') })) {
        codec = c;
        bitrate = br;
        break;
      }
    }
    if (!codec) {
      codec = await getFirstEncodableVideoCodec(preferred, { width: W, height: H });
      bitrate = codec ? targetBitrate(media, codec, opts.quality, W, H) : null;
    }
    if (!codec) throw new Error(`This device can’t encode ${W}×${H} video. Try a desktop browser.`);
    if (media.videoCodec && codec !== media.videoCodec) notes.push(`Re-encoded as ${codec.toUpperCase()} (this browser can’t encode ${media.videoCodec.toUpperCase()}).`);
    if (media.hdr) notes.push('HDR source: exported in standard dynamic range (SDR).');
    if (W !== vTrack.displayWidth || H !== vTrack.displayHeight) notes.push(`Trimmed 1px to ${W}×${H} (encoders require even dimensions).`);

    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    if (!ctx) throw new Error('Canvas unavailable.');
    ctx.imageSmoothingQuality = 'high';

    // Standard BT.709 TV-range output (what cameras deliver), converted on the GPU.
    let yuv: Yuv420Converter | null = null;
    if (Yuv420Converter.supported(W, H)) {
      try {
        yuv = new Yuv420Converter(W, H);
        if (!yuv.selfTest()) yuv = null;
      } catch {
        yuv = null;
      }
    }

    console.info(`[ziticap] export ${W}x${H} ${codec} @ ${bitrate ?? 'auto'} bps, pixel path: ${yuv ? 'BT.709 I420 (GPU)' : 'RGB canvas'}`);
    const firstTs = await input.getFirstTimestamp().catch(() => 0);
    let shift: number | null = null;

    const conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      tracks: 'all',
      video: (track) =>
        track.id === vTrack.id
          ? {
              codec,
              quality: bitrate ? new Quality({ bitrate, bitrateMode: 'variable' }) : new Quality('high'),
              forceTranscode: true,
              allowTransformationMetadata: false,
              processedWidth: W,
              processedHeight: H,
              process: (sample) => {
                if (shift === null) shift = firstTs > 0.1 && sample.timestamp < firstTs - 0.05 ? firstTs : 0;
                sample.drawWithFit(ctx, { fit: 'fill' });
                drawCaptions(ctx, W, H, sample.timestamp + shift, sorted, style);
                if (yuv) return new VideoSample(yuv.convert(canvas, sample.microsecondTimestamp, sample.microsecondDuration));
                return canvas;
              },
            }
          : { discard: true },
      // Audio is copied untouched whenever the container allows it.
      audio: {},
    });
    if (!conversion.isValid) throw new Error('This file can’t be converted: ' + conversion.discardedTracks.map((d) => d.reason).join(', '));
    if (media.hasAudio && !conversion.utilizedTracks.some((t) => t.type === 'audio')) {
      throw new Error('This browser can’t carry over the audio of this file, so the export was stopped (no silent videos!). Try Chrome or update iOS.');
    }
    const start = performance.now();
    conversion.onProgress = (p) => opts.onProgress(p, p > 0.03 ? ((performance.now() - start) / 1000 / p) * (1 - p) : null);
    const onAbort = () => void conversion.cancel();
    opts.signal.addEventListener('abort', onAbort);
    await conversion.execute();
    opts.signal.removeEventListener('abort', onAbort);
    const name = `${baseName}-captioned.${cont.ext}`;
    return { file: await finish(name, cont.mime), codec, width: W, height: H, bitrate, notes };
  } catch (e) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    if (e instanceof ConversionCanceledError) throw new DOMException('Canceled', 'AbortError');
    throw e;
  } finally {
    input.dispose();
    wakeLock?.release().catch(() => {});
  }
}

/** Save a file: native share sheet on phones (→ "Save Video" to Photos), download elsewhere. */
export async function saveFile(file: File, preferShare: boolean): Promise<'shared' | 'downloaded'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (preferShare && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: file.name });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}

export function downloadText(text: string, name: string, mime = 'text/plain') {
  const file = new File([text], name, { type: `${mime};charset=utf-8` });
  void saveFile(file, false);
}
