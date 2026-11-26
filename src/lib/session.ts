// Project lifecycle: create from a file, reopen, transcribe. Glue between libs and UI.
import { extractAudio } from './audio';
import { loadMedia, loadPeaks, loadProject, loadSettings, saveMedia, savePeaks, saveProject } from './db';
import { probe } from './media';
import { DEFAULT_STYLE_PRESET, segmentPreset, stylePreset } from './presets';
import { finalizeTiming, normalizeWords, segmentWords } from './segment';
import { editor, setBusy, setCues, updateProject } from './store';
import { transcribe } from './transcribe';
import type { Project, TranscriptWord } from './types';
import { uid } from './segment';

let pcm: { id: string; data: Float32Array } | null = null;

export const toastStore = { show: (_msg: string, _err?: boolean) => {} };

function setFile(file: File | null) {
  const s = editor.get();
  if (s.url) URL.revokeObjectURL(s.url);
  editor.set({ ...editor.get(), file, url: file ? URL.createObjectURL(file) : null });
}

export async function createProject(file: File): Promise<void> {
  const media = await probe(file);
  const preset = stylePreset(DEFAULT_STYLE_PRESET);
  const settings = loadSettings();
  const project: Project = {
    id: uid('p'),
    name: media.name.replace(/\.[^.]+$/, ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    media,
    cues: [],
    style: { ...preset.style },
    segment: { ...segmentPreset(preset.segment).options },
    stylePreset: preset.id,
    segmentPreset: preset.segment,
    language: settings.language,
  };
  pcm = null;
  editor.set({ project, file: null, url: null, peaks: null, selectedId: null, busy: null, past: [], future: [] });
  setFile(file);
  await saveProject(project);
  const stored = await saveMedia(project.id, file);
  if (!stored) toastStore.show('Storage is full — this project will need the video re-selected next time.');
  void prepareAudio();
}

export async function openProject(id: string): Promise<'ok' | 'need-file'> {
  const project = await loadProject(id);
  if (!project) throw new Error('Project not found');
  pcm = null;
  editor.set({ project, file: null, url: null, peaks: null, selectedId: null, busy: null, past: [], future: [] });
  const [file, peaks] = await Promise.all([loadMedia(id), loadPeaks(id)]);
  if (peaks) editor.set({ ...editor.get(), peaks });
  if (!file) return 'need-file';
  setFile(file);
  if (!peaks) void prepareAudio();
  return 'ok';
}

/** Re-attach the source video to a project whose media wasn't stored. */
export async function relinkFile(file: File) {
  const p = editor.get().project;
  if (!p) return;
  const media = await probe(file);
  if (p.media && Math.abs(media.duration - p.media.duration) > 1) toastStore.show('Heads up: this video’s length differs from the original.');
  updateProject((pr) => ({ ...pr, media }));
  setFile(file);
  void saveMedia(p.id, file);
  void prepareAudio();
}

export function closeProject() {
  setFile(null);
  pcm = null;
  editor.set({ project: null, file: null, url: null, peaks: null, selectedId: null, busy: null, past: [], future: [] });
}

async function getPcm(): Promise<Float32Array> {
  const s = editor.get();
  if (!s.project || !s.file) throw new Error('No video loaded');
  if (pcm && pcm.id === s.project.id) return pcm.data;
  setBusy({ kind: 'audio', progress: 0, label: 'Reading audio…' });
  try {
    const { pcm: data, peaks } = await extractAudio(s.file, s.project.media?.duration ?? 0, (p) =>
      setBusy({ kind: 'audio', progress: p, label: `Reading audio · ${Math.round(p * 100)}%` }),
    );
    pcm = { id: s.project.id, data };
    editor.set({ ...editor.get(), peaks });
    void savePeaks(s.project.id, peaks);
    return data;
  } finally {
    if (editor.get().busy?.kind === 'audio') setBusy(null);
  }
}

export async function prepareAudio() {
  try {
    await getPcm();
  } catch (e) {
    toastStore.show((e as Error).message, true);
  }
}

let abort: AbortController | null = null;

export function cancelTranscription() {
  abort?.abort();
}

export async function runTranscription(language: string) {
  const s = editor.get();
  if (!s.project) return;
  const settings = loadSettings();
  abort = new AbortController();
  const signal = abort.signal;
  updateProject((p) => ({ ...p, language }));
  try {
    const data = await getPcm();
    const raw: TranscriptWord[] = [];
    const duration = editor.get().project?.media?.duration;
    let lastFlush = 0;
    const flush = () => {
      const pr = editor.get().project;
      if (!pr) return;
      const words = normalizeWords(raw, duration);
      editor.set({ ...editor.get(), project: { ...pr, cues: segmentWords(words, pr.segment, duration) } });
    };
    setBusy({ kind: 'transcribe', progress: 0, label: 'Starting…' });
    await transcribe({
      pcm: data,
      engine: settings.engine,
      model: settings.localModel,
      device: settings.device,
      language,
      prompt: settings.prompt,
      apiKey: settings.engine === 'groq' ? settings.groqKey : settings.engine === 'openai' ? settings.openaiKey : undefined,
      signal,
      onProgress: (p) => setBusy({ kind: 'transcribe', progress: p.progress, label: p.label }),
      onWords: (w) => {
        raw.push(...w);
        // Show captions as they arrive (throttled).
        if (performance.now() - lastFlush > 300) {
          lastFlush = performance.now();
          flush();
        }
      },
    });
    const pr = editor.get().project!;
    const words = normalizeWords(raw, duration);
    const cues = finalizeTiming(segmentWords(words, pr.segment, duration), pr.segment, duration);
    // Reset to the pre-transcription state so a single undo restores it, then apply.
    editor.set({ ...editor.get(), project: { ...pr, cues: s.project.cues } });
    setCues(cues);
    toastStore.show(cues.length ? `Transcribed ${words.length} words into ${cues.length} captions.` : 'No speech found in this video.');
  } catch (e) {
    const pr = editor.get().project;
    if ((e as Error).name === 'AbortError') {
      if (pr) editor.set({ ...editor.get(), project: { ...pr, cues: s.project.cues } });
      toastStore.show('Transcription canceled.');
    } else {
      console.error(e);
      toastStore.show((e as Error).message || 'Transcription failed', true);
    }
  } finally {
    setBusy(null);
    abort = null;
  }
}
