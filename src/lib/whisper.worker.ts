/// <reference lib="webworker" />
// On-device speech recognition. Runs Whisper (ONNX) via Transformers.js in a worker
// so the editor stays smooth. Models are cached by the browser after the first download.
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

type ASR = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;

let asr: ASR | null = null;
let loadedKey = '';
let activeDevice: 'webgpu' | 'wasm' = 'wasm';
let wordMode = true;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function hasWebGPU(): Promise<{ ok: boolean; f16: boolean }> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    if (!gpu) return { ok: false, f16: false };
    const adapter = await gpu.requestAdapter();
    return { ok: !!adapter, f16: !!adapter?.features.has('shader-f16') };
  } catch {
    return { ok: false, f16: false };
  }
}

async function load(model: string, device: 'auto' | 'webgpu' | 'wasm', lowMemory: boolean, preferCpu: boolean) {
  const gpu = await hasWebGPU();
  // "Auto" uses the GPU where it's reliable. On iPhone/iPad, Safari's WebGPU can crash the whole tab
  // while setting up a speech model, so Auto means CPU there (slower, but stable).
  let dev: 'webgpu' | 'wasm' = device === 'wasm' ? 'wasm' : device === 'webgpu' ? 'webgpu' : gpu.ok && !preferCpu ? 'webgpu' : 'wasm';
  const large = /large|turbo/.test(model);
  const big = large || /small|medium/.test(model);
  // Weight precision decides download size *and* peak memory. A full 32-bit encoder for Small is ~350 MB,
  // which is enough to make a phone kill the tab. Use 16-bit on GPUs that support it; on phones without
  // that, use the compact 8-bit CPU build instead.
  let dtype: Record<string, string>;
  if (dev === 'webgpu' && gpu.f16) dtype = { encoder_model: 'fp16', decoder_model_merged: 'q4' };
  else if (dev === 'webgpu' && !(lowMemory && big)) dtype = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  else {
    dev = 'wasm';
    dtype = { encoder_model: 'q8', decoder_model_merged: 'q8' };
  }
  if (lowMemory && large && !(dev === 'webgpu' && gpu.f16))
    throw new Error('Large v3 Turbo is too big for this device’s memory. Use Base or Small here, or Groq in Settings for the large model in the cloud.');
  const key = `${model}|${dev}`;
  if (asr && loadedKey === key) {
    post({ type: 'ready', device: activeDevice });
    return;
  }
  // Tell the page which processor is about to be used, so a crash report can name it.
  post({ type: 'device', device: dev, dtype });
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
    post({ type: 'progress', ...p });
  };
  try {
    asr = (await pipeline('automatic-speech-recognition', model, { device: dev, dtype, progress_callback } as never)) as unknown as ASR;
    activeDevice = dev;
  } catch (e) {
    if (dev === 'webgpu' && !(lowMemory && large)) {
      // Some GPUs/drivers fail to compile the graph — fall back to CPU (WASM).
      post({ type: 'notice', message: 'GPU unavailable for this model, using CPU instead.' });
      asr = (await pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        progress_callback,
      } as never)) as unknown as ASR;
      activeDevice = 'wasm';
    } else throw e;
  }
  loadedKey = `${model}|${activeDevice}`;
  wordMode = true;
  post({ type: 'ready', device: activeDevice });
}

interface OutWord { text: string; start: number; end: number }

/** Spread words of a segment across its span, weighted by length (fallback when word timing is unavailable). */
function distribute(text: string, start: number, end: number): OutWord[] {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const total = parts.reduce((s, p) => s + p.length + 1, 0) || 1;
  let t = start;
  return parts.map((p) => {
    const len = ((end - start) * (p.length + 1)) / total;
    const w = { text: p, start: t, end: t + len };
    t += len;
    return w;
  });
}

function plausible(words: OutWord[], dur: number): boolean {
  if (!words.length) return true;
  const bad = words.filter((w) => !Number.isFinite(w.start) || w.start > dur + 1 || w.end < w.start).length;
  const distinct = new Set(words.map((w) => w.start.toFixed(2))).size;
  return bad / words.length < 0.2 && (words.length < 4 || distinct > words.length * 0.4);
}

async function run(id: number, audio: Float32Array, language: string, model: string) {
  if (!asr) throw new Error('Model not loaded');
  const dur = audio.length / 16000;
  const english = /\.en\b/.test(model);
  const opts: Record<string, unknown> = { task: 'transcribe' };
  if (!english && language && language !== 'auto') opts.language = language;

  let words: OutWord[] = [];
  let text = '';
  if (wordMode) {
    try {
      const out = await asr(audio, { ...opts, return_timestamps: 'word' });
      text = out.text;
      words = (out.chunks ?? []).map((c) => ({
        text: c.text,
        start: c.timestamp[0] ?? 0,
        end: c.timestamp[1] ?? Math.min(dur, (c.timestamp[0] ?? 0) + 0.3),
      }));
      if (!plausible(words, dur)) words = [];
    } catch (e) {
      // Model export lacks cross-attentions → no word timing. Use segment timing instead.
      wordMode = false;
      post({ type: 'notice', message: 'Word timing unavailable for this model; using phrase timing.' });
      console.warn(e);
    }
  }
  if (!words.length) {
    const out = await asr(audio, { ...opts, return_timestamps: true });
    text = out.text;
    const segs = out.chunks?.length ? out.chunks : [{ text: out.text, timestamp: [0, dur] as [number, number] }];
    words = segs.flatMap((s) => distribute(s.text, s.timestamp[0] ?? 0, Math.min(dur, s.timestamp[1] ?? dur)));
  }
  post({ type: 'result', id, text, words });
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'load') await load(m.model, m.device ?? 'auto', !!m.lowMemory, !!m.preferCpu);
    else if (m.type === 'run') await run(m.id, m.audio, m.language, m.model);
  } catch (e) {
    post({ type: 'error', id: m.id, message: (e as Error)?.message ?? String(e) });
  }
};
