/**
 * Export pipeline (WebCodecs via Mediabunny).
 *
 *  Direct path (normal): decode → blend captions straight into the frame's own YUV planes
 *  (see composite.ts) → hardware encode → mux. The picture is never round-tripped through RGB,
 *  the output carries the input's colour space (matrix, range, primaries, transfer — HDR included),
 *  resolution, rotation metadata and frame timestamps. Audio packets are copied bit-for-bit.
 *
 *  Compatibility path (unusual decoder output): draw on a canvas, convert on the GPU using the
 *  source's matrix and range, tag with the source's colour space.
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
  VideoSampleSink,
  VideoSampleSource,
  type ConversionVideoOptions,
  type OutputFormat,
  type Target,
  type VideoCodec,
} from 'mediabunny';
import { openInput } from './media';
import { captionRect, drawCaptions, visibleCue } from './render';
import { YuvCompositor, compositeSupported } from './composite';
import { ensureFont } from './fonts';
import { Yuv420Converter } from './yuv';
import { YuvScaler, scalerSupported, targetSize, type OutputResolution } from './scale';
import type { CaptionStyle, Cue, MediaInfo } from './types';

export type ExportQuality = 'match' | 'high' | 'smaller';

export interface ExportOptions {
  quality: ExportQuality;
  /** Internal: retry through the RGB path. */
  forceRgb?: boolean;
  /** Output size. 'original' keeps the source size; 1080p/4K resize, always keeping the aspect ratio. */
  resolution?: OutputResolution;
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

type TargetInfo = { target: Target; streaming: boolean; kind: string; finish: (name: string, mime: string) => Promise<File> };

/**
 * Where the exported file is written. Disk-backed (OPFS) output keeps memory flat on phones,
 * even for long 4K videos:
 *  1. FileSystemWritableFileStream — Chrome/Edge/Android, Firefox, Safari 26+.
 *  2. A worker with a sync access handle — Safari/iOS 15.2–18.
 *  3. In memory — last resort.
 */
async function makeTarget(ext: string): Promise<TargetInfo> {
  let root: FileSystemDirectoryHandle | null = null;
  const name = `ziticap-export-${Date.now()}.${ext}`;
  try {
    root = await navigator.storage.getDirectory();
    // Clear exports from previous sessions.
    for await (const [n] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (n.startsWith('ziticap-export-')) await root.removeEntry(n).catch(() => {});
    }
  } catch {
    root = null;
  }
  const fromDisk = (handle: FileSystemFileHandle) => async (fileName: string, mime: string) => {
    const f = await handle.getFile();
    return new File([f], fileName, { type: mime });
  };

  if (root) {
    try {
      const handle = await root.getFileHandle(name, { create: true });
      const createWritable = (handle as FileSystemFileHandle & { createWritable?: () => Promise<FileSystemWritableFileStream> }).createWritable;
      if (typeof createWritable !== 'function') throw new Error('no createWritable');
      const writable = await createWritable.call(handle);
      return { target: new StreamTarget(writable as unknown as WritableStream, { chunked: true }), streaming: true, kind: 'opfs', finish: fromDisk(handle) };
    } catch {
      /* try the worker path */
    }
    try {
      const worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' });
      const call = (msg: unknown, transfer: Transferable[] = []) =>
        new Promise<void>((resolve, reject) => {
          worker.onmessage = (e) => (e.data?.ok ? resolve() : reject(new Error(e.data?.error ?? 'write failed')));
          worker.onerror = (e) => reject(new Error(e.message));
          worker.postMessage(msg, transfer);
        });
      await call({ type: 'open', name });
      const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
        write: (chunk) => {
          const data = chunk.data.slice(); // own the bytes so they can be transferred
          return call({ type: 'write', data, position: chunk.position }, [data.buffer]);
        },
        close: async () => {
          await call({ type: 'close' });
          worker.terminate();
        },
        abort: () => worker.terminate(),
      });
      const handle = await root.getFileHandle(name);
      return { target: new StreamTarget(writable, { chunked: true }), streaming: true, kind: 'opfs-worker', finish: fromDisk(handle) };
    } catch {
      /* fall back to memory */
    }
  }
  const target = new BufferTarget();
  return { target, streaming: false, kind: 'memory', finish: async (fileName, mime) => new File([target.buffer!], fileName, { type: mime }) };
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
  // When resizing, scale the source's bitrate with the pixel count (sub-linearly: detail doesn't grow 1:1).
  const pxRatio = (W * H) / Math.max(1, media.width * media.height);
  const sizeK = Math.pow(pxRatio, 0.75);
  const fps = media.fps && media.fps > 0 ? Math.min(media.fps, 120) : 30;
  // Rough relative efficiency vs H.264.
  const eff: Record<string, number> = { avc: 1, hevc: 0.6, vp9: 0.65, av1: 0.5, vp8: 1.1 };
  const srcEff = eff[media.videoCodec ?? 'avc'] ?? 1;
  const dstEff = eff[codec] ?? 1;
  const bppFloor = q === 'high' ? 0.12 : q === 'smaller' ? 0.035 : 0.075; // bits per pixel per frame for H.264
  const floor = W * H * fps * bppFloor * dstEff;
  if (q === 'smaller') return Math.round(floor);
  if (!media.videoBitrate) return Math.round(floor * 1.4);
  const matched = ((media.videoBitrate * dstEff) / srcEff) * sizeK;
  // Captions add hard edges that need a few extra bits to stay crisp.
  const want = q === 'high' ? matched * 1.5 : matched * 1.1;
  return Math.round(Math.min(150e6, Math.max(want, floor)));
}

export async function exportVideo(file: File, media: MediaInfo, cues: Cue[], style: CaptionStyle, opts: ExportOptions): Promise<ExportResult> {
  try {
    return await exportOnce(file, media, cues, style, opts);
  } catch (e) {
    // An unusual decoder output on this device? Retry once through the universal RGB path.
    if ((e as Error).name === 'AbortError' || opts.forceRgb || opts.signal.aborted) throw e;
    console.warn('[ziticap] direct export failed, retrying via RGB path', e);
    const res = await exportOnce(file, media, cues, style, { ...opts, forceRgb: true });
    res.notes.push('Used the compatibility pipeline on this device.');
    return res;
  }
}

async function exportOnce(file: File, media: MediaInfo, cues: Cue[], style: CaptionStyle, opts: ExportOptions): Promise<ExportResult> {
  if (!webCodecsSupported()) throw new Error('This browser can’t encode video. Use a current Chrome, Edge, Safari (iOS 17+), or Firefox.');
  const cont = pickContainer(media);
  const { target, streaming, finish, kind: targetKind } = await makeTarget(cont.ext);
  console.info(`[ziticap] writing export to ${targetKind}`);
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
    const firstTs = await input.getFirstTimestamp().catch(() => 0);
    const trackCS = await vTrack.getColorSpace().catch(() => ({}) as VideoColorSpaceInit);
    const rotation = vTrack.rotation;
    const flip = await vTrack.getFlip().catch(() => false);
    const par = vTrack.pixelAspectRatio;

    // Look at one decoded frame to learn the decoder's pixel format and colour interpretation.
    let probeFormat: string | null = null;
    let probeCS: VideoColorSpaceInit = {};
    let probeW = vTrack.codedWidth;
    let probeH = vTrack.codedHeight;
    try {
      const s = await new VideoSampleSink(vTrack).getSample(await vTrack.getFirstTimestamp());
      if (s) {
        probeFormat = s.format;
        probeCS = { ...s.colorSpace } as VideoColorSpaceInit;
        probeW = s.visibleRect.width;
        probeH = s.visibleRect.height;
        s.close();
      }
    } catch (e) {
      console.warn('[ziticap] frame probe failed', e);
    }
    // Colour tags to write: the input's own, with any gaps filled the way players fill them
    // (the decoder's YUV interpretation if it gave one; otherwise BT.709 for HD, BT.601 for SD).
    const yuvProbe = !!probeFormat && !/^(RGB|BGR)/.test(probeFormat);
    const sd = Math.min(vTrack.displayWidth, vTrack.displayHeight) < 720;
    const fallbackCS: VideoColorSpaceInit = sd
      ? { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false }
      : { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
    const pick = <K extends keyof VideoColorSpaceInit>(k: K) =>
      (trackCS[k] ?? (yuvProbe ? probeCS[k] : undefined) ?? fallbackCS[k] ?? null) as VideoColorSpaceInit[K];
    const tags: VideoColorSpaceInit = { primaries: pick('primaries'), transfer: pick('transfer'), matrix: pick('matrix'), fullRange: pick('fullRange') ?? false };
    if (!trackCS.primaries && !trackCS.matrix && !trackCS.transfer) notes.push(`Source had no colour tags; output is labelled with the colour space it decodes as (${tags.matrix}), so it looks identical.`);
    console.info(`[ziticap] source frames: ${probeFormat ?? 'opaque'} ${probeW}×${probeH}, rotation ${rotation}, colour ${JSON.stringify(trackCS)}`);

    // Output display size (resolution preset, aspect ratio preserved).
    const [DW, DH] = targetSize(vTrack.displayWidth, vTrack.displayHeight, opts.resolution ?? 'original');
    const resized = DW !== vTrack.displayWidth || DH !== vTrack.displayHeight;
    const quarter = rotation === 90 || rotation === 270;
    // Direct path: composite in the source's own YUV planes (exact colour space, rotation kept as metadata).
    const direct =
      !opts.forceRgb &&
      compositeSupported(probeFormat) &&
      (!resized || scalerSupported(probeFormat)) &&
      !flip &&
      par.num === par.den &&
      probeW % 2 === 0 &&
      probeH % 2 === 0;
    // Encoded frame size: coded (pre-rotation) size on the direct path, display size on the RGB path.
    let W = direct ? (resized ? (quarter ? DH : DW) : probeW) : DW;
    let H = direct ? (resized ? (quarter ? DW : DH) : probeH) : DH;
    if (W % 2) W -= 1;
    if (H % 2) H -= 1;
    if (resized) notes.push(`${DW * DH > vTrack.displayWidth * vTrack.displayHeight ? 'Upscaled' : 'Downscaled'} from ${vTrack.displayWidth}×${vTrack.displayHeight} to ${DW}×${DH} (bicubic); captions are rendered natively at the new size.`);

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
    if (!codec)
      throw new Error(
        resized
          ? `This device can’t encode ${DW}×${DH} video. Choose “Original” resolution, or export on a newer phone or a computer.`
          : `This device can’t encode ${W}×${H} video. Try a desktop browser.`,
      );
    if (media.videoCodec && codec !== media.videoCodec) notes.push(`Re-encoded as ${codec.toUpperCase()} (this browser can’t encode ${media.videoCodec.toUpperCase()}).`);

    let shift: number | null = null;
    const timeOf = (s: VideoSample) => {
      if (shift === null) shift = firstTs > 0.1 && s.timestamp < firstTs - 0.05 ? firstTs : 0;
      return s.timestamp + shift;
    };
    const quality = bitrate ? new Quality({ bitrate, bitrateMode: 'variable' }) : new Quality('high');

    if (direct) {
      // Tag output exactly like the input; fill unknowns from the decoder only for the caption colour maths.
      // An untagged file is shown by browsers and phones using the decoder's assumption (BT.709 for HD,
      // BT.601 for SD). Encoders can't write "unspecified" (they'd silently substitute and convert), so we
      // label the output with exactly the colour space the source is decoded and displayed in.
      const mathCs: VideoColorSpaceInit = { ...probeCS, ...Object.fromEntries(Object.entries(trackCS).filter(([, v]) => v != null)) };
      const comp = new YuvCompositor(resized ? 'I420' : probeFormat!, W, H, rotation, tags, mathCs);
      const scaler = resized ? new YuvScaler(probeFormat!, probeW, probeH, W, H) : null;
      if (scaler && probeFormat && /P1[02]/.test(probeFormat))
        notes.push(`${media.hdr ? 'HDR' : 'High bit-depth'} colour space kept (${[tags.primaries, tags.transfer].filter(Boolean).join(' / ') || 'as source'}); encoded at 8-bit, the depth this browser can encode.`);
      // Untouched frames can only skip the copy if the file is fully tagged and the decoder reports the same tags.
      // (For untagged files, decoders report defaults but treat frames as "unspecified", which encoders then convert.)
      const fullyTagged = !!(trackCS.primaries && trackCS.transfer && trackCS.matrix && trackCS.fullRange != null);
      const sameTags = (cs: VideoColorSpaceInit) =>
        fullyTagged &&
        (cs.primaries ?? null) === tags.primaries && (cs.transfer ?? null) === tags.transfer && (cs.matrix ?? null) === tags.matrix && !!cs.fullRange === !!tags.fullRange;
      if (comp.downconvert) notes.push(`${media.hdr ? 'HDR' : 'High bit-depth'} colour space kept (${[tags.primaries, tags.transfer].filter(Boolean).join(' / ') || 'as source'}); encoded at 8-bit, the depth this browser can encode.`);
      console.info(`[ziticap] export ${W}x${H} rot ${rotation} ${codec} @ ${bitrate ?? 'auto'} bps · direct ${probeFormat} compositing · tags ${JSON.stringify(tags)}`);
      // Mediabunny would re-render rotated frames through RGB if we used a per-frame callback, so the video
      // track is driven here directly: decode → composite in YUV → encode, keeping the input's rotation matrix.
      // WebM: start the timeline at the true first timestamp (slightly negative with Opus pre-skip) so every
      // audio packet can be copied instead of re-encoding the first one; video is offset to match.
      // MP4 represents encoder priming with an edit list, so its timeline starts at 0 as usual.
      const trimStart = cont.kind === 'webm' ? firstTs : Math.max(0, firstTs);
      const stats = await vTrack.computePacketStats().catch(() => null);
      const vSource = new VideoSampleSource({ codec, quality });
      output.addVideoTrack(vSource, {
        transformationMatrix: await vTrack.getTransformationMatrix(),
        maximumPacketCount: (stats?.packetCount ?? Math.ceil(media.duration * 240)) + 64,
      });
      const conversion = await Conversion.init({ input, output, composable: true, showWarnings: false, tracks: 'all', video: { discard: true }, audio: {}, trim: { start: trimStart } });
      if (media.hasAudio && !conversion.utilizedTracks.some((t) => t.type === 'audio')) {
        throw new Error('This browser can’t carry over the audio of this file, so the export was stopped (no silent videos!). Try Chrome or update iOS.');
      }
      const tags0 = await input.getMetadataTags().catch(() => null);
      if (tags0) {
        const { creationTime: _drop, ...rest } = tags0 as Record<string, unknown>;
        void _drop;
        output.setMetadataTags(rest);
      }
      comp.timestampOffsetUs = -Math.round(trimStart * 1e6);
      let canceled = false;
      const onAbort = () => {
        canceled = true;
        void conversion.cancel();
      };
      opts.signal.addEventListener('abort', onAbort);
      const start = performance.now();
      await output.start();
      const timing = { scale: 0, composite: 0, encode: 0, frames: 0 };
      const videoTask = (async () => {
        const sink = new VideoSampleSink(vTrack);
        for await (const sample of sink.samples()) {
          try {
            if (canceled) throw new DOMException('Canceled', 'AbortError');
            if (sample.timestamp + sample.duration <= trimStart) continue;
            const t = timeOf(sample);
            const draw = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
              const cue = visibleCue(sorted, t);
              if (!cue) return null;
              drawCaptions(ctx, DW, DH, t, sorted, style);
              return captionRect(ctx, cue, style, DW, DH);
            };
            let frame: VideoFrame | null;
            if (scaler) {
              const t0 = performance.now();
              const buf = await scaler.scale(sample);
              const t1 = performance.now();
              frame = comp.frameFromBuffer(buf, scaler.layout, sample.microsecondTimestamp, sample.microsecondDuration, DW, DH, draw);
              timing.scale += t1 - t0;
              timing.composite += performance.now() - t1;
            } else {
              frame = await comp.composite(sample, DW, DH, draw);
              if (!frame && (trimStart !== 0 || !sameTags(sample.colorSpace as VideoColorSpaceInit))) frame = await comp.copyFrame(sample);
            }
            const te = performance.now();
            if (frame) {
              const out = new VideoSample(frame);
              await vSource.add(out);
              out.close();
            } else await vSource.add(sample);
            timing.encode += performance.now() - te;
            timing.frames++;
            const p = Math.min(0.999, (sample.timestamp - trimStart) / Math.max(0.001, media.duration));
            opts.onProgress(p, p > 0.03 ? ((performance.now() - start) / 1000 / p) * (1 - p) : null);
          } finally {
            sample.close();
          }
        }
        vSource.close();
      })();
      try {
        await Promise.all([videoTask, conversion.execute()]);
      } catch (e) {
        canceled = true;
        void conversion.cancel();
        throw canceled && opts.signal.aborted ? new DOMException('Canceled', 'AbortError') : e;
      } finally {
        opts.signal.removeEventListener('abort', onAbort);
      }
      await output.finalize();
      const per = (v: number) => (v / Math.max(1, timing.frames)).toFixed(1);
      console.info(`[ziticap] ${timing.frames} frames · per frame: scale ${per(timing.scale)} ms, captions ${per(timing.composite)} ms, encode wait ${per(timing.encode)} ms`);
      const name = `${baseName}-captioned.${cont.ext}`;
      return { file: await finish(name, cont.mime), codec, width: DW, height: DH, bitrate, notes };
    } else {
      // RGB fallback: draw the frame on a canvas, then convert on the GPU using the source's matrix and range.
      if (W !== DW || H !== DH) notes.push(`Trimmed 1px to ${W}×${H} (encoders require even dimensions).`);
      // (The canvas draw below also performs any 1080p/4K resize.)
      const tr = trackCS.transfer as string | null | undefined;
      const hdr = media.hdr || tr === 'pq' || tr === 'hlg';
      const canvas: OffscreenCanvas | HTMLCanvasElement =
        typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      if (!ctx) throw new Error('Canvas unavailable.');
      ctx.imageSmoothingQuality = 'high';
      const outCS: VideoColorSpaceInit = hdr ? { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } : tags;
      if (hdr) notes.push('HDR source on this browser: exported in standard dynamic range (BT.709).');
      let yuv: Yuv420Converter | null = null;
      if (Yuv420Converter.supported(W, H)) {
        try {
          yuv = new Yuv420Converter(W, H, outCS);
          if (!yuv.selfTest()) yuv = null;
        } catch {
          yuv = null;
        }
      }
      if (!yuv) notes.push('Colour tags could not be matched exactly on this browser.');
      console.info(`[ziticap] export ${W}x${H} ${codec} @ ${bitrate ?? 'auto'} bps · RGB path · ${yuv ? 'GPU YUV ' + JSON.stringify(outCS) : 'canvas'}`);
      const videoOptions: ConversionVideoOptions = {
        codec,
        quality,
        forceTranscode: true,
        allowTransformationMetadata: false,
        processedWidth: W,
        processedHeight: H,
        process: (sample) => {
          const t = timeOf(sample);
          sample.drawWithFit(ctx, { fit: 'fill' });
          drawCaptions(ctx, W, H, t, sorted, style);
          if (yuv) return new VideoSample(yuv.convert(canvas, sample.microsecondTimestamp, sample.microsecondDuration));
          return canvas;
        },
      };

    const conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      tracks: 'all',
      video: (track) => (track.id === vTrack.id ? videoOptions : { discard: true }),
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
    return { file: await finish(name, cont.mime), codec, width: DW, height: DH, bitrate, notes };
    }
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
