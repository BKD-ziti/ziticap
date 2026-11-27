import { SAMPLE_RATE, encodeWav, rms, silenceChunks } from './audio';
import type { TranscriptWord } from './types';
import { vocabularyHint } from './vocab';
import { deviceMemoryGB, isIOS, isPhoneOrTablet, updateInflight } from './device';

export interface LocalModel {
  id: string;
  name: string;
  size: string;
  note: string;
  gpuOnly?: boolean;
}

export const LOCAL_MODELS: LocalModel[] = [
  { id: 'Xenova/whisper-tiny', name: 'Tiny', size: '≈ 40 MB', note: 'Fastest. Good for clear speech on older phones.' },
  { id: 'onnx-community/whisper-base_timestamped', name: 'Base', size: '≈ 80 MB', note: 'Balanced speed and accuracy. Recommended on phones.' },
  { id: 'Xenova/whisper-small', name: 'Small', size: '≈ 250 MB', note: 'Noticeably more accurate. Best on laptops and desktops; heavy for phones.' },
  {
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    name: 'Large v3 Turbo',
    size: '≈ 800 MB',
    note: 'Studio-grade accuracy. Needs a GPU (WebGPU) — desktop or recent iPhone/Android.',
    gpuOnly: true,
  },
];

export const LANGUAGES: [string, string][] = [
  ['auto', 'Auto-detect'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['pl', 'Polish'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['tr', 'Turkish'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['vi', 'Vietnamese'],
  ['tl', 'Tagalog'],
  ['sv', 'Swedish'],
  ['el', 'Greek'],
  ['he', 'Hebrew'],
  ['id', 'Indonesian'],
];

export interface TranscribeProgress {
  stage: 'audio' | 'model' | 'transcribe' | 'done';
  /** 0..1 within the stage */
  progress: number;
  label: string;
}

export interface TranscribeRequest {
  pcm: Float32Array;
  engine: 'local' | 'groq' | 'openai';
  model: string;
  device: 'auto' | 'webgpu' | 'wasm';
  language: string;
  prompt: string;
  apiKey?: string;
  onProgress: (p: TranscribeProgress) => void;
  /** Called with newly recognised words as each chunk finishes, so captions appear live. */
  onWords: (words: TranscriptWord[]) => void;
  signal: AbortSignal;
}

let worker: Worker | null = null;
let seq = 0;

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export function disposeWorker() {
  worker?.terminate();
  worker = null;
}

function workerCall<T>(msg: Record<string, unknown>, transfer: Transferable[], onEvent: (e: Record<string, unknown>) => void, done: (e: Record<string, unknown>) => T | undefined, signal: AbortSignal): Promise<T> {
  const w = getWorker();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      // Terminating is the only way to stop an in-flight inference.
      disposeWorker();
      reject(new DOMException('Canceled', 'AbortError'));
    };
    const handler = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown>;
      if (d.type === 'error' && (d.id === undefined || d.id === msg.id)) {
        cleanup();
        reject(new Error(String(d.message)));
        return;
      }
      onEvent(d);
      const r = done(d);
      if (r !== undefined) {
        cleanup();
        resolve(r);
      }
    };
    const cleanup = () => {
      w.removeEventListener('message', handler);
      signal.removeEventListener('abort', onAbort);
    };
    w.addEventListener('message', handler);
    signal.addEventListener('abort', onAbort);
    w.postMessage(msg, transfer);
  });
}

async function transcribeLocal(req: TranscribeRequest): Promise<void> {
  const files = new Map<string, { loaded: number; total: number }>();
  req.onProgress({ stage: 'model', progress: 0, label: 'Loading speech model…' });
  let device = '';
  try {
    await loadModel();
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const msg = (e as Error).message || '';
    if (/fetch|network|load|404|403/i.test(msg) || !navigator.onLine)
      throw new Error('Couldn’t download the speech model. Check your connection and try again — it’s a one-time download, then it works offline.');
    throw e;
  }
  async function loadModel() {
  await workerCall(
    { type: 'load', model: req.model, device: req.device, lowMemory: isPhoneOrTablet() || (deviceMemoryGB() ?? 8) <= 4, preferCpu: isIOS() },
    [],
    (e) => {
      if (e.type === 'progress' && e.file && typeof e.total === 'number' && e.total > 0) {
        files.set(String(e.file), { loaded: Number(e.loaded ?? 0), total: Number(e.total) });
        let l = 0;
        let t = 0;
        files.forEach((f) => {
          l += f.loaded;
          t += f.total;
        });
        req.onProgress({ stage: 'model', progress: t ? l / t : 0, label: `Downloading model (first time only) · ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB` });
      }
      if (e.type === 'progress' && e.status === 'ready') req.onProgress({ stage: 'model', progress: 1, label: 'Warming up…' });
      if (e.type === 'notice') console.info(e.message);
      if (e.type === 'device') updateInflight({ device: e.device, dtype: e.dtype }, true);
    },
    (e) => (e.type === 'ready' ? ((device = String(e.device)), true) : undefined),
    req.signal,
  );
  }

  const chunks = silenceChunks(req.pcm, 28, 5);
  const skipped: { start: number; end: number }[] = [];
  let found = 0;
  const total = req.pcm.length;
  const t0 = performance.now();
  for (let i = 0; i < chunks.length; i++) {
    if (req.signal.aborted) throw new DOMException('Canceled', 'AbortError');
    const c = chunks[i];
    const done = c.start / total;
    const elapsed = (performance.now() - t0) / 1000;
    const eta = done > 0.02 ? (elapsed / done) * (1 - done) : NaN;
    req.onProgress({
      stage: 'transcribe',
      progress: done,
      label: `Transcribing on this device (${device === 'webgpu' ? 'GPU' : 'CPU'}) · ${Math.round(done * 100)}%${Number.isFinite(eta) ? ` · ~${Math.ceil(eta)}s left` : ''}`,
    });
    // Skip near-silent chunks; Whisper tends to invent text ("Thank you.") on silence.
    if (rms(req.pcm, c.start, c.end) < 0.004) {
      skipped.push(c);
      continue;
    }
    await runChunk(c);
  }
  // Heard nothing at all? Listen again to everything that was skipped as "silence" (never to pure digital silence).
  if (!found && skipped.length) {
    const retry = skipped.filter((c) => rms(req.pcm, c.start, c.end) > 1e-4);
    for (let i = 0; i < retry.length; i++) {
      if (req.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      req.onProgress({ stage: 'transcribe', progress: i / retry.length, label: `Listening more closely · ${Math.round((i / retry.length) * 100)}%` });
      await runChunk(retry[i]);
    }
  }
  req.onProgress({ stage: 'done', progress: 1, label: 'Done' });

  async function runChunk(c: { start: number; end: number }) {
    const audio = req.pcm.slice(c.start, c.end);
    const id = ++seq;
    const res = await workerCall<{ words: TranscriptWord[] }>(
      { type: 'run', id, audio, language: req.language, model: req.model },
      [audio.buffer],
      () => {},
      (e) => (e.type === 'result' && e.id === id ? { words: e.words as TranscriptWord[] } : undefined),
      req.signal,
    );
    const offset = c.start / SAMPLE_RATE;
    const chunkEnd = c.end / SAMPLE_RATE;
    found += res.words.length;
    req.onWords(
      res.words.map((w) => ({
        text: w.text,
        start: Math.min(chunkEnd, w.start + offset),
        end: Math.min(chunkEnd, w.end + offset),
      })),
    );
  }
}

const PROVIDERS = {
  groq: { base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', maxBytes: 24e6 },
  openai: { base: 'https://api.openai.com/v1', model: 'whisper-1', maxBytes: 24e6 },
} as const;

function nrm(s: string) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Word arrays from the API come without punctuation; borrow it back from the segment text. */
function punctuate(words: { word: string; start: number; end: number }[], text: string): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  let ti = 0;
  return words.map((w) => {
    const target = nrm(w.word);
    for (let k = ti; k < Math.min(tokens.length, ti + 4); k++) {
      if (nrm(tokens[k]) === target) {
        ti = k + 1;
        return { text: tokens[k], start: w.start, end: w.end };
      }
    }
    return { text: w.word.trim(), start: w.start, end: w.end };
  });
}

async function transcribeCloud(req: TranscribeRequest): Promise<void> {
  const p = PROVIDERS[req.engine as 'groq' | 'openai'];
  if (!req.apiKey) throw new Error('Add your API key in Settings first.');
  // 16-bit mono WAV = 32 KB/s → ~12 minutes per request under the 25 MB limit.
  const maxSec = Math.floor(p.maxBytes / (SAMPLE_RATE * 2)) - 10;
  const chunks = silenceChunks(req.pcm, maxSec, 10);
  const skipped: { start: number; end: number }[] = [];
  let found = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    req.onProgress({ stage: 'transcribe', progress: i / chunks.length, label: `Transcribing with ${req.engine === 'groq' ? 'Groq' : 'OpenAI'} · part ${i + 1} of ${chunks.length}` });
    if (rms(req.pcm, c.start, c.end) < 0.002) {
      skipped.push(c);
      continue;
    }
    await sendChunk(c);
  }
  if (!found && skipped.length) {
    const retry = skipped.filter((c) => rms(req.pcm, c.start, c.end) > 1e-4);
    for (let i = 0; i < retry.length; i++) {
      req.onProgress({ stage: 'transcribe', progress: i / retry.length, label: `Listening more closely · part ${i + 1} of ${retry.length}` });
      await sendChunk(retry[i]);
    }
  }
  req.onProgress({ stage: 'done', progress: 1, label: 'Done' });

  async function sendChunk(c: { start: number; end: number }) {
    const wav = encodeWav(req.pcm.subarray(c.start, c.end));
    const form = new FormData();
    form.append('file', wav, 'audio.wav');
    form.append('model', p.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    if (req.language && req.language !== 'auto') form.append('language', req.language);
    // Spelling hints: the user's notes plus every auto-correct target (e.g. "BKDziti").
    const hint = [vocabularyHint(), req.prompt.trim()].filter(Boolean).join('. ');
    if (hint) form.append('prompt', hint.slice(0, 800));

    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(`${p.base}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${req.apiKey}` },
          body: form,
          signal: req.signal,
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new Error(`Couldn't reach ${req.engine === 'groq' ? 'Groq' : 'OpenAI'}. Check your connection (and that no content blocker is stopping the request).`);
      }
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
    if (!res || !res.ok) {
      let msg = `${res?.status ?? ''}`;
      try {
        const j = await res!.json();
        msg = j.error?.message ?? msg;
      } catch {
        /* ignore */
      }
      if (res?.status === 401) msg = 'That API key was rejected. Double-check it in Settings.';
      throw new Error(`Transcription failed: ${msg}`);
    }
    const json = await res.json();
    const offset = c.start / SAMPLE_RATE;
    const segText = (json.segments ?? []).map((s: { text: string }) => s.text).join(' ') || json.text || '';
    let words: TranscriptWord[];
    if (Array.isArray(json.words) && json.words.length) words = punctuate(json.words, segText);
    else {
      words = (json.segments ?? []).flatMap((s: { text: string; start: number; end: number }) => {
        const parts = s.text.trim().split(/\s+/);
        const step = (s.end - s.start) / Math.max(1, parts.length);
        return parts.map((t, k) => ({ text: t, start: s.start + k * step, end: s.start + (k + 1) * step }));
      });
    }
    found += words.length;
    req.onWords(words.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })));
  }
}

export async function transcribe(req: TranscribeRequest): Promise<void> {
  if (req.engine === 'local') return transcribeLocal(req);
  return transcribeCloud(req);
}
