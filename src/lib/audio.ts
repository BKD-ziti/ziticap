import { AudioBufferSink, BufferTarget, Conversion, Mp4OutputFormat, Output, WebMOutputFormat, type Input, type InputAudioTrack } from 'mediabunny';
import { openInput } from './media';
import { isPhoneOrTablet } from './device';

export const SAMPLE_RATE = 16000;
export const PEAKS_PER_SEC = 50;

export interface AudioReport {
  tracks: { codec: string | null; channels: number | null; sampleRate: number | null; decodable: boolean }[];
  usedTrack: number; // 1-based
  method: string;
  channelMode: string;
  /** Speech-level loudness of the source (95th percentile of 50 ms windows), dBFS. */
  levelDb: number;
  peakDb: number;
  gainDb: number;
  silent: boolean;
}

export interface ExtractedAudio {
  pcm: Float32Array; // 16 kHz mono, cleaned and levelled, aligned to the media timeline (t=0 → index 0)
  peaks: Float32Array; // PEAKS_PER_SEC max-abs values for the waveform
  report: AudioReport;
}

/** Second-order RBJ biquad: low-pass (anti-alias before decimation) or high-pass (rumble removal). */
class Biquad {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(rate: number, cutoff: number, q = Math.SQRT1_2, type: 'lp' | 'hp' = 'lp') {
    const w = (2 * Math.PI * cutoff) / rate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    if (type === 'lp') {
      this.b0 = (1 - cos) / 2 / a0;
      this.b1 = (1 - cos) / a0;
      this.b2 = (1 - cos) / 2 / a0;
    } else {
      this.b0 = (1 + cos) / 2 / a0;
      this.b1 = -(1 + cos) / a0;
      this.b2 = (1 + cos) / 2 / a0;
    }
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Streaming resampler: low-pass, then box-average into output bins. */
class Resampler {
  private ratio: number;
  private lp1: Biquad | null;
  private lp2: Biquad | null;
  private n = 0;
  private acc = 0;
  private cnt = 0;
  private bin = 0;
  out: Float32Array;
  len = 0;
  constructor(srcRate: number, expectedSeconds: number) {
    this.ratio = srcRate / SAMPLE_RATE;
    const needsLP = srcRate > SAMPLE_RATE * 1.05;
    this.lp1 = needsLP ? new Biquad(srcRate, 7200) : null;
    this.lp2 = needsLP ? new Biquad(srcRate, 7200) : null;
    this.out = new Float32Array(Math.ceil((expectedSeconds + 2) * SAMPLE_RATE));
  }
  private push(v: number) {
    if (this.len >= this.out.length) {
      const bigger = new Float32Array(Math.ceil(this.out.length * 1.5) + SAMPLE_RATE);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.len++] = v;
  }
  /** Align to a timestamp (pads silence over gaps). */
  seek(seconds: number) {
    const target = Math.round(seconds * SAMPLE_RATE);
    if (target > this.len + SAMPLE_RATE / 100) {
      this.flushBin();
      while (this.len < target) this.push(0);
      this.n = Math.round(target * this.ratio);
      this.bin = target;
    }
  }
  private flushBin() {
    if (this.cnt) this.push(this.acc / this.cnt);
    this.acc = 0;
    this.cnt = 0;
  }
  write(mono: Float32Array) {
    for (let i = 0; i < mono.length; i++) {
      let v = mono[i];
      if (this.lp1) v = this.lp2!.run(this.lp1.run(v));
      const b = Math.floor(this.n / this.ratio);
      if (b !== this.bin) {
        this.flushBin();
        this.bin = b;
      }
      this.acc += v;
      this.cnt++;
      this.n++;
    }
  }
  finish(): Float32Array {
    this.flushBin();
    return this.out.subarray(0, this.len);
  }
}

function computePeaks(pcm: Float32Array): Float32Array {
  const step = SAMPLE_RATE / PEAKS_PER_SEC;
  const peaks = new Float32Array(Math.ceil(pcm.length / step));
  let max = 0;
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    const end = Math.min(pcm.length, (i + 1) * step);
    for (let j = i * step; j < end; j++) {
      const a = Math.abs(pcm[j]);
      if (a > m) m = a;
    }
    peaks[i] = m;
    if (m > max) max = m;
  }
  // Normalise so quiet recordings still show a readable waveform.
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] = Math.min(1, peaks[i] / max);
  return peaks;
}

/**
 * Pick the soundtrack to transcribe. Phones can record several: newer iPhones add a "Spatial Audio"
 * track (APAC) that browsers can't decode next to the normal AAC one. Prefer one we can decode,
 * in a common codec, stereo or mono.
 */
async function rankAudioTracks(input: Input): Promise<{ track: InputAudioTrack; decodable: boolean }[]> {
  const tracks = await input.getAudioTracks();
  const common = ['aac', 'opus', 'mp3', 'flac', 'vorbis', 'pcm-s16', 'pcm-s16be', 'pcm-s24', 'pcm-s24be', 'pcm-s32', 'pcm-f32', 'pcm-u8', 'ulaw', 'alaw', 'ac3', 'eac3'];
  const ranked = await Promise.all(
    tracks.map(async (track, i) => {
      const decodable = await track.canDecode().catch(() => false);
      const codec = track.codec ?? '';
      let channels = 2;
      try {
        channels = track.numberOfChannels;
      } catch {
        /* unknown */
      }
      const score = (decodable ? 100 : 0) + (common.includes(codec) ? 20 : 0) + (channels <= 2 ? 5 : 0) - i * 0.01;
      return { track, decodable, score };
    }),
  );
  return ranked.sort((a, b) => b.score - a.score);
}

/** Decoded audio at 16 kHz: one array per channel (stereo/mono), or one pre-mixed array for surround. */
interface Decoded {
  channels: Float32Array[];
  surround: boolean;
}

/** Stream-decode with WebCodecs: low memory, works on Chrome, Edge, Firefox, Safari 26+. */
async function viaDecoder(track: InputAudioTrack, duration: number, onProgress?: (p: number) => void): Promise<Decoded> {
  const sink = new AudioBufferSink(track);
  let streams: Resampler[] | null = null;
  let surround = false;
  for await (const { buffer, timestamp } of sink.buffers()) {
    const ch = buffer.numberOfChannels;
    if (!streams) {
      surround = ch > 2;
      streams = Array.from({ length: surround ? 1 : ch }, () => new Resampler(buffer.sampleRate, duration));
    }
    if (timestamp >= 0) for (const r of streams) r.seek(timestamp);
    // Skip the part of a buffer that sits before t=0 (priming samples).
    const skip = timestamp < 0 ? Math.min(buffer.length, Math.round(-timestamp * buffer.sampleRate)) : 0;
    if (surround) {
      // Surround: average all channels (dialogue lives in the centre); levelling later restores volume.
      const mix = new Float32Array(buffer.length);
      for (let c = 0; c < ch; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) mix[i] += d[i] / ch;
      }
      streams[0].write(mix.subarray(skip));
    } else {
      for (let c = 0; c < streams.length; c++) streams[c].write(buffer.getChannelData(Math.min(c, ch - 1)).subarray(skip));
    }
    if (duration > 0) onProgress?.(Math.min(1, (timestamp + buffer.duration) / duration));
  }
  if (!streams) throw new Error('NO_AUDIO');
  return { channels: streams.map((r) => r.finish()), surround };
}

async function decodeWithWebAudio(data: ArrayBuffer, duration: number): Promise<Decoded> {
  const OAC = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new OAC(1, Math.max(1, Math.ceil((duration || 1) * SAMPLE_RATE)), SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(data);
  const n = decoded.numberOfChannels;
  if (n <= 2) return { channels: Array.from({ length: n }, (_, c) => decoded.getChannelData(c)), surround: false };
  const mix = new Float32Array(decoded.length);
  for (let c = 0; c < n; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < d.length; i++) mix[i] += d[i] / n;
  }
  return { channels: [mix], surround: true };
}

/**
 * Low-memory fallback: copy just the soundtrack's packets into a small audio-only file
 * (~1 MB per minute for AAC) and let the browser's audio decoder read that.
 * The video itself is never loaded into memory.
 */
async function viaAudioOnlyCopy(input: Input, track: InputAudioTrack, duration: number, onProgress?: (p: number) => void): Promise<Decoded> {
  const webm = track.codec === 'opus' || track.codec === 'vorbis';
  const output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target: new BufferTarget() });
  const conv = await Conversion.init({
    input,
    output,
    showWarnings: false,
    copy: { mode: 'forced' },
    video: { discard: true },
    audio: (t) => (t.id === track.id ? {} : { discard: true }),
  });
  if (!conv.isValid || !conv.utilizedTracks.length) throw new Error('CANNOT_COPY');
  conv.onProgress = (p) => onProgress?.(p * 0.8);
  await conv.execute();
  const buf = output.target.buffer;
  if (!buf) throw new Error('CANNOT_COPY');
  const dec = await decodeWithWebAudio(buf, duration);
  onProgress?.(1);
  return dec;
}

function energy(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 2) s += a[i] * a[i];
  return s;
}

/**
 * Fold channels to mono without losing the voice. A plain L+R average cancels speech when the two
 * channels are out of phase (a common mic/recorder quirk); in that case use the stronger channel.
 */
function toMono(dec: Decoded): { mono: Float32Array; mode: string } {
  const [a, b] = dec.channels;
  if (dec.surround) return { mono: a, mode: 'surround mix' };
  if (!b) return { mono: a, mode: 'mono' };
  const eA = energy(a);
  const eB = energy(b);
  const n = Math.min(a.length, b.length);
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = (a[i] + b[i]) * 0.5;
  const eMix = energy(mix);
  const eMax = Math.max(eA, eB);
  if (eMax > 0 && eMix < 0.25 * eMax) return { mono: eA >= eB ? a : b, mode: eA >= eB ? 'left channel (stereo cancelled)' : 'right channel (stereo cancelled)' };
  if (eMax > 0 && Math.min(eA, eB) < 0.01 * eMax) return { mono: eA >= eB ? a : b, mode: eA >= eB ? 'left channel only' : 'right channel only' };
  return { mono: mix, mode: 'stereo mix' };
}

const WIN = Math.floor(0.05 * SAMPLE_RATE);

/** Speech-level loudness: 95th percentile of 50 ms window RMS (ignores pauses and silence). */
function speechLevel(pcm: Float32Array): { p95: number; peak: number } {
  const n = Math.floor(pcm.length / WIN);
  if (!n) return { p95: 0, peak: 0 };
  const w = new Float32Array(n);
  let peak = 0;
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = k * WIN; i < (k + 1) * WIN; i++) {
      const v = pcm[i];
      s += v * v;
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
    }
    w[k] = Math.sqrt(s / WIN);
  }
  w.sort();
  return { p95: w[Math.min(n - 1, Math.floor(n * 0.95))], peak };
}

const db = (v: number) => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -120);

/**
 * Clean up for speech recognition: a 90 Hz high-pass removes rumble, wind, hum and DC offset;
 * then the level is brought up to a consistent speech loudness (up to +40 dB) with a soft limiter.
 */
function cleanUp(pcm: Float32Array): { pcm: Float32Array; levelDb: number; peakDb: number; gainDb: number; silent: boolean } {
  // 6th-order high-pass at 90 Hz: speech intelligibility lives above it, rumble and hum below.
  const hp = [0, 1, 2].map(() => new Biquad(SAMPLE_RATE, 90, Math.SQRT1_2, 'hp'));
  for (let i = 0; i < pcm.length; i++) pcm[i] = hp[2].run(hp[1].run(hp[0].run(pcm[i])));
  const { p95, peak } = speechLevel(pcm);
  const silent = p95 < 1e-5;
  const target = 0.1; // ≈ −20 dBFS speech level
  const gain = silent ? 1 : Math.min(100, Math.max(1, target / p95));
  if (gain > 1.0001) {
    for (let i = 0; i < pcm.length; i++) {
      let v = pcm[i] * gain;
      // Soft knee above 0.8 so boosted peaks never clip harshly.
      const av = v < 0 ? -v : v;
      if (av > 0.8) v = Math.sign(v) * (0.8 + 0.2 * Math.tanh((av - 0.8) / 0.2));
      pcm[i] = v;
    }
  }
  return { pcm, levelDb: db(p95), peakDb: db(peak), gainDb: db(gain), silent };
}

const SAFE_KEY = 'ziticap:safe-audio';
/** After a crash while reading audio, start with the lighter method next time. */
export function preferSafeAudio(on: boolean) {
  try {
    if (on) localStorage.setItem(SAFE_KEY, '1');
    else localStorage.removeItem(SAFE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Decode the soundtrack to clean 16 kHz mono — what Whisper expects — without ever loading the whole
 * video into memory. Every soundtrack is considered: if the first one is silent (screen recorders and
 * some exports add an empty track), the loudest one wins.
 */
export async function extractAudio(file: Blob, duration: number, onProgress?: (p: number) => void): Promise<ExtractedAudio> {
  const input = openInput(file);
  try {
    const ranked = await rankAudioTracks(input);
    if (!ranked.length) throw new Error('This video has no audio track to transcribe.');
    let safeFirst = false;
    try {
      safeFirst = localStorage.getItem(SAFE_KEY) === '1';
    } catch {
      /* ignore */
    }
    const all = await input.getAudioTracks();
    const trackInfo = all.map((t) => {
      const r = ranked.find((x) => x.track === t);
      let channels: number | null = null;
      let sampleRate: number | null = null;
      try {
        channels = t.numberOfChannels;
        sampleRate = t.sampleRate;
      } catch {
        /* unknown */
      }
      return { codec: t.codec ?? null, channels, sampleRate, decodable: !!r?.decodable };
    });
    const limit = isPhoneOrTablet() ? 120e6 : 800e6;
    const errors: string[] = [];
    let best: { mono: Float32Array; mode: string; method: string; trackIdx: number; p95: number } | null = null;

    for (const cand of ranked) {
      const methods: [string, () => Promise<Decoded>][] = [];
      const decoder: [string, () => Promise<Decoded>] = ['stream decoder', () => viaDecoder(cand.track, duration, onProgress)];
      const copy: [string, () => Promise<Decoded>] = ['audio-only copy', () => viaAudioOnlyCopy(input, cand.track, duration, onProgress)];
      if (cand.decodable && !safeFirst) methods.push(decoder, copy);
      else if (cand.decodable) methods.push(copy, decoder);
      else methods.push(copy);
      if (all.length === 1 && file.size <= limit) methods.push(['whole-file decode', async () => decodeWithWebAudio(await file.arrayBuffer(), duration)]);
      for (const [method, run] of methods) {
        try {
          const { mono, mode } = toMono(await run());
          const { p95 } = speechLevel(mono);
          if (!best || p95 > best.p95) best = { mono, mode, method, trackIdx: all.indexOf(cand.track), p95 };
          if (p95 > 3e-4) break; // real sound — no need to try another method for this track
        } catch (e) {
          errors.push(`${method}: ${(e as Error)?.message ?? String(e)}`);
        }
      }
      if (best && best.p95 > 3e-4) break; // found a track with sound
    }
    if (!best) {
      console.warn('[ziticap] audio extraction failed:', errors);
      throw new Error(`This browser can’t read this video’s audio (${ranked[0].track.codec ?? 'unknown format'}). Try a current Safari/Chrome, or export the clip as “Most Compatible” and try again.`);
    }
    const cleaned = cleanUp(best.mono);
    const report: AudioReport = {
      tracks: trackInfo,
      usedTrack: best.trackIdx + 1,
      method: best.method,
      channelMode: best.mode,
      levelDb: cleaned.levelDb,
      peakDb: cleaned.peakDb,
      gainDb: cleaned.gainDb,
      silent: cleaned.silent,
    };
    console.info('[ziticap] audio', JSON.stringify(report));
    try {
      localStorage.setItem('ziticap:lastaudio', JSON.stringify(report));
    } catch {
      /* ignore */
    }
    return { pcm: cleaned.pcm, peaks: computePeaks(cleaned.pcm), report };
  } finally {
    input.dispose();
  }
}

/** RMS of a range — used to skip silent chunks (prevents Whisper "hallucinations"). */
export function rms(pcm: Float32Array, start = 0, end = pcm.length): number {
  let s = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / n);
}

/**
 * Split audio into chunks no longer than `maxSec`, cutting at the quietest moment
 * inside the last `searchSec` of each window so words are never sliced in half.
 */
export function silenceChunks(pcm: Float32Array, maxSec: number, searchSec = 6): { start: number; end: number }[] {
  const maxN = Math.floor(maxSec * SAMPLE_RATE);
  const win = Math.floor(0.05 * SAMPLE_RATE); // 50 ms energy windows
  const chunks: { start: number; end: number }[] = [];
  let pos = 0;
  while (pos < pcm.length) {
    if (pcm.length - pos <= maxN) {
      chunks.push({ start: pos, end: pcm.length });
      break;
    }
    const searchFrom = pos + maxN - Math.floor(searchSec * SAMPLE_RATE);
    let bestAt = pos + maxN;
    let best = Infinity;
    for (let s = Math.max(pos + win, searchFrom); s + win <= pos + maxN; s += win / 2) {
      const e = rms(pcm, s, s + win);
      if (e < best) {
        best = e;
        bestAt = s + win / 2;
      }
    }
    chunks.push({ start: pos, end: Math.floor(bestAt) });
    pos = Math.floor(bestAt);
  }
  return chunks;
}

/** 16-bit PCM WAV encoder for cloud upload. */
export function encodeWav(pcm: Float32Array, rate = SAMPLE_RATE): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  let o = 44;
  for (let i = 0; i < pcm.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
