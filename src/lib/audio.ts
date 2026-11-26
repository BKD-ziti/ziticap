import { AudioBufferSink } from 'mediabunny';
import { openInput } from './media';

export const SAMPLE_RATE = 16000;
export const PEAKS_PER_SEC = 50;

export interface ExtractedAudio {
  pcm: Float32Array; // 16 kHz mono, aligned to the media timeline (t=0 → index 0)
  peaks: Float32Array; // PEAKS_PER_SEC max-abs values for the waveform
}

/** Second-order low-pass (RBJ biquad) used as the anti-alias filter before decimation. */
class Biquad {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(rate: number, cutoff: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * cutoff) / rate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = (1 - cos) / 2 / a0;
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

async function viaMediabunny(file: Blob, duration: number, onProgress?: (p: number) => void): Promise<Float32Array> {
  const input = openInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('NO_AUDIO');
    if (!(await track.canDecode())) throw new Error('CANNOT_DECODE');
    const sink = new AudioBufferSink(track);
    let rs: Resampler | null = null;
    for await (const { buffer, timestamp } of sink.buffers()) {
      if (!rs) rs = new Resampler(buffer.sampleRate, duration);
      if (timestamp >= 0) rs.seek(timestamp);
      const ch = buffer.numberOfChannels;
      let mono: Float32Array;
      if (ch === 1) mono = buffer.getChannelData(0);
      else {
        mono = new Float32Array(buffer.length);
        for (let c = 0; c < ch; c++) {
          const d = buffer.getChannelData(c);
          for (let i = 0; i < d.length; i++) mono[i] += d[i] / ch;
        }
      }
      // Skip the part of a buffer that sits before t=0 (priming samples).
      if (timestamp < 0) {
        const skip = Math.min(mono.length, Math.round(-timestamp * buffer.sampleRate));
        mono = mono.subarray(skip);
      }
      rs.write(mono);
      if (duration > 0) onProgress?.(Math.min(1, (timestamp + buffer.duration) / duration));
    }
    if (!rs) throw new Error('NO_AUDIO');
    return rs.finish();
  } finally {
    input.dispose();
  }
}

async function viaWebAudio(file: Blob, duration: number): Promise<Float32Array> {
  const data = await file.arrayBuffer();
  const OAC = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new OAC(1, Math.max(1, Math.ceil((duration || 1) * SAMPLE_RATE)), SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(data);
  const out = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / decoded.numberOfChannels;
  }
  return out;
}

/** Decode the soundtrack to 16 kHz mono — what Whisper expects. Streams, so memory stays low. */
export async function extractAudio(file: Blob, duration: number, onProgress?: (p: number) => void): Promise<ExtractedAudio> {
  let pcm: Float32Array;
  try {
    pcm = await viaMediabunny(file, duration, onProgress);
  } catch (e) {
    if ((e as Error).message === 'NO_AUDIO') throw new Error('This video has no audio track to transcribe.');
    pcm = await viaWebAudio(file, duration);
  }
  return { pcm, peaks: computePeaks(pcm) };
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
