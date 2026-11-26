import type { Cue, SegmentOptions, Word } from './types';
import { segmentWords, uid } from './segment';
import { applyFixes, restoreCase } from './vocab';

const MIN = 0.05;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function sortCues(cues: Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Change a cue's in/out points; words are rescaled proportionally so highlights stay in sync. */
export function retimeCue(cue: Cue, start: number, end: number): Cue {
  start = Math.max(0, start);
  if (end - start < MIN) end = start + MIN;
  const oldLen = Math.max(1e-6, cue.end - cue.start);
  const k = (end - start) / oldLen;
  const words = cue.words.map((w) => ({
    ...w,
    start: start + (w.start - cue.start) * k,
    end: start + (w.end - cue.start) * k,
  }));
  return { ...cue, start, end, words: clampWords(words, start, end) };
}

export function moveCue(cue: Cue, delta: number): Cue {
  const d = Math.max(delta, -cue.start);
  return {
    ...cue,
    start: cue.start + d,
    end: cue.end + d,
    words: cue.words.map((w) => ({ ...w, start: w.start + d, end: w.end + d })),
  };
}

function clampWords(words: Word[], start: number, end: number): Word[] {
  return words.map((w) => {
    const s = clamp(w.start, start, end);
    const e = clamp(w.end, s, end);
    return { ...w, start: s, end: e };
  });
}

/** Set one word's start (and optionally end), nudging neighbours so order is preserved. */
export function retimeWord(cue: Cue, index: number, start: number, end?: number): Cue {
  const words = cue.words.map((w) => ({ ...w }));
  const w = words[index];
  if (!w) return cue;
  const len = w.end - w.start;
  w.start = start;
  w.end = end ?? start + len;
  if (w.end <= w.start) w.end = w.start + MIN;
  for (let i = index - 1; i >= 0; i--) {
    if (words[i].end > words[i + 1].start) words[i].end = words[i + 1].start;
    if (words[i].start > words[i].end - 0.01) words[i].start = Math.max(0, words[i].end - MIN);
  }
  for (let i = index + 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].end) {
      const l = words[i].end - words[i].start;
      words[i].start = words[i - 1].end;
      words[i].end = Math.max(words[i].end, words[i].start + Math.min(l, MIN));
    }
  }
  return {
    ...cue,
    words,
    start: Math.min(cue.start, words[0].start),
    end: Math.max(cue.end, words[words.length - 1].end),
  };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

/**
 * Replace a cue's text while keeping as much word timing as possible.
 * Unchanged words keep their timestamps (LCS alignment); new/edited words are
 * interpolated across the time span between their anchored neighbours, weighted by length.
 */
export function retextCue(cue: Cue, text: string): Cue {
  const lines = text.replace(/\r/g, '').split('\n');
  const tokens: { text: string; br: boolean }[] = [];
  lines.forEach((line, li) => {
    const parts = line.split(/\s+/).filter(Boolean);
    parts.forEach((p, pi) => tokens.push({ text: p, br: li < lines.length - 1 && pi === parts.length - 1 }));
  });
  if (!tokens.length) return { ...cue, words: [] };

  const old = cue.words;
  const a = old.map((w) => norm(w.text));
  const b = tokens.map((t) => norm(t.text));
  // LCS table
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] && a[i] !== '' ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const match: (number | null)[] = Array.from({ length: m }, () => null);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && a[i] !== '') {
      match[j] = i;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  // Same word count & no matches → user retyped words one-for-one; keep positional timing.
  if (n === m && !match.some((x) => x !== null)) for (let k = 0; k < m; k++) match[k] = k;

  const words: Word[] = tokens.map((t, k) => {
    const mi = match[k];
    if (mi !== null) return { ...old[mi], text: t.text, br: t.br || undefined };
    return { id: uid(), text: t.text, start: NaN, end: NaN, br: t.br || undefined };
  });

  // Fill unanchored runs.
  let k = 0;
  while (k < words.length) {
    if (!Number.isNaN(words[k].start)) {
      k++;
      continue;
    }
    let e = k;
    while (e < words.length && Number.isNaN(words[e].start)) e++;
    const runEnd = e;
    // Too little room (a word squeezed between two tight words)? Borrow time from the neighbours.
    const room = () => (e < words.length ? words[e].start : cue.end) - (k > 0 ? words[k - 1].end : cue.start);
    while (room() < 0.14 * (e - k) && (k > 0 || e < words.length)) {
      if (k > 0) k--;
      if (room() >= 0.14 * (e - k)) break;
      if (e < words.length) e++;
    }
    const from = k > 0 ? words[k - 1].end : cue.start;
    const to = e < words.length ? words[e].start : cue.end;
    const span = Math.max(to - from, MIN * (e - k));
    const total = words.slice(k, e).reduce((s, w) => s + w.text.length + 1, 0);
    let t = from;
    for (let q = k; q < e; q++) {
      const len = (span * (words[q].text.length + 1)) / total;
      words[q].start = t;
      words[q].end = t + len;
      t += len;
    }
    k = Math.max(e, runEnd);
  }
  const start = Math.min(cue.start, words[0].start);
  const end = Math.max(cue.end, words[words.length - 1].end);
  return { ...cue, start, end, words };
}

/** Split a cue before word `index`. Returns the two halves. */
export function splitCueAtWord(cue: Cue, index: number): [Cue, Cue] | null {
  if (index <= 0 || index >= cue.words.length) return null;
  const left = cue.words.slice(0, index).map((w) => ({ ...w }));
  const right = cue.words.slice(index).map((w) => ({ ...w }));
  left[left.length - 1].br = undefined;
  const mid = right[0].start;
  return [
    { id: cue.id, start: cue.start, end: Math.max(left[left.length - 1].end, Math.min(mid, cue.end)), words: left },
    { id: uid('c'), start: mid, end: cue.end, words: right },
  ];
}

/** Split at a time: the first word starting at or after `t` begins the second cue. */
export function splitCueAtTime(cue: Cue, t: number): [Cue, Cue] | null {
  let idx = cue.words.findIndex((w) => w.start >= t - 0.02);
  if (idx <= 0) idx = Math.round(cue.words.length / 2);
  return splitCueAtWord(cue, idx);
}

export function mergeCues(a: Cue, b: Cue): Cue {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return {
    id: first.id,
    start: Math.min(first.start, second.start),
    end: Math.max(first.end, second.end),
    words: [...first.words.map((w) => ({ ...w })), ...second.words.map((w) => ({ ...w }))],
  };
}

/** Create a new cue at `t`, sized to fit the gap available. */
export function makeCueAt(cues: Cue[], t: number, duration: number, text = 'New caption'): Cue {
  const sorted = sortCues(cues);
  const next = sorted.find((c) => c.start > t);
  const end = Math.min(t + 1.5, next ? next.start : duration || t + 1.5);
  const e = end - t < 0.3 ? t + 0.6 : end;
  const parts = text.split(/\s+/).filter(Boolean);
  const step = (e - t) / parts.length;
  return {
    id: uid('c'),
    start: t,
    end: e,
    words: parts.map((p, i) => ({ id: uid(), text: p, start: t + i * step, end: t + (i + 1) * step })),
  };
}

export function shiftAll(cues: Cue[], delta: number): Cue[] {
  return cues.map((c) => moveCue(c, delta));
}

export interface ReplaceOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

function buildRegex(find: string, o: ReplaceOptions): RegExp {
  const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = o.wholeWord ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc;
  return new RegExp(body, o.caseSensitive ? 'gu' : 'giu');
}

export function countMatches(cues: Cue[], find: string, o: ReplaceOptions): number {
  if (!find) return 0;
  const re = buildRegex(find, o);
  return cues.reduce((n, c) => n + (c.words.map((w) => w.text).join(' ').match(re)?.length ?? 0), 0);
}

export function replaceAll(cues: Cue[], find: string, replacement: string, o: ReplaceOptions): Cue[] {
  if (!find) return cues;
  const re = buildRegex(find, o);
  return cues.map((c) => {
    const text = c.words.map((w, i) => w.text + (i < c.words.length - 1 ? (w.br ? '\n' : ' ') : '')).join('');
    re.lastIndex = 0;
    if (!re.test(text)) return c;
    re.lastIndex = 0;
    return retextCue(c, text.replace(re, replacement));
  });
}

/** Re-group every word into fresh captions using new segmentation rules. */
export function reflow(cues: Cue[], opt: SegmentOptions, duration?: number): Cue[] {
  const words = sortCues(cues).flatMap((c) => c.words.map((w) => ({ ...w, br: undefined })));
  return segmentWords(words, opt, duration);
}

export function cueAtTime(cues: Cue[], t: number): Cue | undefined {
  // Cues are kept sorted; small arrays so a linear scan is fine and robust.
  for (const c of cues) if (t >= c.start && t < c.end) return c;
  return undefined;
}

export function changeCase(cues: Cue[], mode: 'upper' | 'lower' | 'sentence'): Cue[] {
  return cues.map((c) => {
    const words = c.words.map((w, i) => {
      let text = w.text;
      if (mode === 'upper') text = text.toUpperCase();
      else if (mode === 'lower') text = text.toLowerCase();
      else {
        text = text.toLowerCase();
        const prev = c.words[i - 1];
        if (i === 0 || (prev && /[.!?]["')\]]*$/.test(prev.text))) text = text.charAt(0).toUpperCase() + text.slice(1);
        text = text.replace(/\bi\b/g, 'I').replace(/\bi'/g, "I'");
      }
      return { ...w, text: restoreCase(text) };
    });
    return { ...c, words };
  });
}

/** Re-run the custom-vocabulary auto-corrections over existing captions. */
export function fixVocabulary(cues: Cue[]): Cue[] {
  return cues.map((c) => {
    const words = applyFixes(c.words);
    return words === c.words ? c : { ...c, words };
  });
}

/** Remove common filler words ("um", "uh", ...). Their time is absorbed by neighbours. */
export function removeFillers(cues: Cue[]): Cue[] {
  const fillers = /^(um+|uh+|erm+|er|ah+|hmm+|mm+|uh-huh)[,.!?]*$/i;
  return cues
    .map((c) => ({ ...c, words: c.words.filter((w) => !fillers.test(w.text)) }))
    .filter((c) => c.words.length > 0);
}
