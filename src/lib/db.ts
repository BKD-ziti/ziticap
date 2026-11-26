// Tiny IndexedDB wrapper: projects autosave locally, nothing leaves the device.
import type { Project } from './types';
import { DEFAULT_RULES, setRules, type FixRule } from './vocab';

const DB = 'ziticap';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      if (!db.objectStoreNames.contains('peaks')) db.createObjectStore('peaks');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= open());

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const saveProject = (p: Project) =>
  tx('projects', 'readwrite', (s) => s.put(p)).catch((e) => console.warn('[ziticap] autosave failed', e));
export const loadProject = (id: string) => tx<Project | undefined>('projects', 'readonly', (s) => s.get(id));
export const listProjects = () =>
  tx<Project[]>('projects', 'readonly', (s) => s.getAll()).then((ps) => ps.sort((a, b) => b.updatedAt - a.updatedAt));
export async function deleteProject(id: string) {
  await tx('projects', 'readwrite', (s) => s.delete(id));
  await tx('media', 'readwrite', (s) => s.delete(id)).catch(() => {});
  await tx('peaks', 'readwrite', (s) => s.delete(id)).catch(() => {});
}

/** Store the source video so a project reopens instantly. Fails quietly when storage is full. */
export async function saveMedia(id: string, file: File): Promise<boolean> {
  try {
    await navigator.storage?.persist?.();
    await tx('media', 'readwrite', (s) => s.put(file, id));
    return true;
  } catch {
    return false;
  }
}
export const loadMedia = (id: string) => tx<File | undefined>('media', 'readonly', (s) => s.get(id)).catch(() => undefined);
export const savePeaks = (id: string, peaks: Float32Array) => tx('peaks', 'readwrite', (s) => s.put(peaks, id)).catch(() => undefined);
export const loadPeaks = (id: string) => tx<Float32Array | undefined>('peaks', 'readonly', (s) => s.get(id)).catch(() => undefined);

// Small settings live in localStorage.
export interface Settings {
  engine: 'local' | 'groq' | 'openai';
  localModel: string;
  device: 'auto' | 'webgpu' | 'wasm';
  groqKey: string;
  openaiKey: string;
  language: string;
  prompt: string;
  /** Auto-corrections applied to every transcript (names, brands). */
  fixes: FixRule[];
}

const DEFAULTS: Settings = {
  engine: 'local',
  localModel: 'onnx-community/whisper-base_timestamped',
  device: 'auto',
  groqKey: '',
  openaiKey: '',
  language: 'auto',
  prompt: '',
  fixes: DEFAULT_RULES,
};

export function loadSettings(): Settings {
  let s: Settings;
  try {
    s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ziticap:settings') || '{}') };
  } catch {
    s = { ...DEFAULTS };
  }
  // The BKDziti rule always exists (it can be switched off, not deleted).
  if (!Array.isArray(s.fixes)) s.fixes = DEFAULT_RULES;
  if (!s.fixes.some((r) => r.builtin)) s.fixes = [...DEFAULT_RULES, ...s.fixes];
  setRules(s.fixes);
  return s;
}
export function saveSettings(s: Settings) {
  setRules(s.fixes);
  try {
    localStorage.setItem('ziticap:settings', JSON.stringify(s));
  } catch {
    /* private mode */
  }
}
