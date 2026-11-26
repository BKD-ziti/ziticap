import { useEffect, useRef, useState } from 'preact/hooks';
import type { Cue, Project } from './types';
import { saveProject } from './db';
import { sortCues } from './edit';

export class Store<T> {
  private v: T;
  private subs = new Set<(v: T) => void>();
  constructor(v: T) {
    this.v = v;
  }
  get(): T {
    return this.v;
  }
  set(v: T | ((prev: T) => T)) {
    this.v = typeof v === 'function' ? (v as (p: T) => T)(this.v) : v;
    this.subs.forEach((s) => s(this.v));
  }
  subscribe(fn: (v: T) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export function useStore<T, S = T>(store: Store<T>, select: (v: T) => S = (v) => v as unknown as S): S {
  const [, force] = useState(0);
  const sel = useRef(select);
  sel.current = select;
  const last = useRef<S>(select(store.get()));
  last.current = select(store.get());
  useEffect(
    () =>
      store.subscribe((v) => {
        const next = sel.current(v);
        if (!Object.is(next, last.current)) {
          last.current = next;
          force((n) => n + 1);
        }
      }),
    [store],
  );
  return last.current;
}

// ---------------- Editor state ----------------

export interface EditorState {
  project: Project | null;
  file: File | null;
  url: string | null;
  peaks: Float32Array | null;
  selectedId: string | null;
  busy: null | { kind: 'transcribe' | 'export' | 'audio'; progress: number; label: string };
  past: Cue[][];
  future: Cue[][];
}

export const editor = new Store<EditorState>({
  project: null,
  file: null,
  url: null,
  peaks: null,
  selectedId: null,
  busy: null,
  past: [],
  future: [],
});

/** High-frequency playhead time lives in its own store so typing never stutters during playback. */
export const playhead = new Store<number>(0);
export const playing = new Store<boolean>(false);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirtySince = 0;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  dirtySince = 0;
  const p = editor.get().project;
  if (p) void saveProject({ ...p, updatedAt: Date.now() });
}
/** Debounced autosave that never waits more than ~1.5 s during continuous editing. */
function scheduleSave() {
  const now = Date.now();
  if (!dirtySince) dirtySince = now;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, now - dirtySince > 1500 ? 0 : 300);
}
// Phones can kill a backgrounded tab at any time — persist the moment we're hidden.
if (typeof document !== 'undefined') {
  const flush = () => {
    if (saveTimer !== undefined) saveNow();
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  window.addEventListener('pagehide', flush);
}

export function updateProject(fn: (p: Project) => Project) {
  editor.set((s) => (s.project ? { ...s, project: fn(s.project) } : s));
  scheduleSave();
}

let lastCoalesce = '';
let lastCoalesceAt = 0;

/**
 * Replace cues, recording undo history. Rapid edits with the same `coalesce` key
 * (e.g. dragging a handle) collapse into one undo step.
 */
export function setCues(next: Cue[], coalesce = '') {
  const s = editor.get();
  if (!s.project) return;
  const now = performance.now();
  const merge = coalesce && coalesce === lastCoalesce && now - lastCoalesceAt < 1200;
  lastCoalesce = coalesce;
  lastCoalesceAt = now;
  const past = merge ? s.past : [...s.past.slice(-199), s.project.cues];
  editor.set({ ...s, past, future: [], project: { ...s.project, cues: sortCues(next) } });
  scheduleSave();
}

export function updateCue(id: string, fn: (c: Cue) => Cue, coalesce = '') {
  const p = editor.get().project;
  if (!p) return;
  setCues(p.cues.map((c) => (c.id === id ? fn(c) : c)), coalesce);
}

export function undo() {
  const s = editor.get();
  if (!s.project || !s.past.length) return;
  const prev = s.past[s.past.length - 1];
  editor.set({ ...s, past: s.past.slice(0, -1), future: [s.project.cues, ...s.future], project: { ...s.project, cues: prev } });
  lastCoalesce = '';
  scheduleSave();
}

export function redo() {
  const s = editor.get();
  if (!s.project || !s.future.length) return;
  const [next, ...rest] = s.future;
  editor.set({ ...s, future: rest, past: [...s.past, s.project.cues], project: { ...s.project, cues: next } });
  lastCoalesce = '';
  scheduleSave();
}

export function select(id: string | null) {
  editor.set((s) => ({ ...s, selectedId: id }));
}

export function setBusy(busy: EditorState['busy']) {
  editor.set((s) => ({ ...s, busy }));
}

// The active <video> element registers itself here so any control can seek/play.
let videoEl: HTMLVideoElement | null = null;
export function registerVideo(v: HTMLVideoElement | null) {
  videoEl = v;
}
export function getVideo() {
  return videoEl;
}
export function seek(t: number) {
  if (!videoEl) return;
  const d = videoEl.duration || Infinity;
  const tt = Math.max(0, Math.min(t, d - 0.001));
  videoEl.currentTime = tt;
  playhead.set(tt);
}
export function togglePlay() {
  if (!videoEl) return;
  if (videoEl.paused) void videoEl.play();
  else videoEl.pause();
}
/** Play just this range, then stop — for checking a single caption. */
export function playRange(start: number, end: number) {
  if (!videoEl) return;
  const v = videoEl;
  seek(start);
  void v.play();
  const stop = () => {
    if (v.currentTime >= end - 0.02) {
      v.pause();
      v.removeEventListener('timeupdate', stop);
    }
  };
  v.addEventListener('timeupdate', stop);
  const off = () => {
    v.removeEventListener('timeupdate', stop);
    v.removeEventListener('pause', off);
  };
  v.addEventListener('pause', off);
}
