import type { Cue, SegmentOptions, TranscriptWord, Word } from './types';

let counter = 0;
export function uid(prefix = 'w'): string {
  counter = (counter + 1) % 1e9;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const SENTENCE_END = /[.!?…。！？]["')\]]*$/;
// Words that belong with what follows — never leave them dangling at the end of a caption.
const DANGLING = /^(a|an|the|to|of|in|on|at|by|for|with|from|and|or|but|so|if|my|your|our|their|his|her|its|this|that|these|those|is|are|was|i|we|you|they|he|she|it's|i'm|we're|you're|el|la|los|las|un|una|de|y|le|les|des|et|der|die|das|und)$/i;
const CLAUSE_END = /[,;:—–]["')\]]*$/;

export function cueText(cue: Cue): string {
  return cue.words.map((w) => w.text).join(' ');
}

/** Text with explicit line breaks (as authored by the user) preserved as "\n". */
export function cueTextWithBreaks(cue: Cue): string {
  let out = '';
  cue.words.forEach((w, i) => {
    out += w.text;
    if (i < cue.words.length - 1) out += w.br ? '\n' : ' ';
  });
  return out;
}

/** Clean up raw ASR tokens: trim, drop empties, fix non-monotonic or zero-length timing. */
export function normalizeWords(raw: TranscriptWord[], duration?: number): Word[] {
  const words: Word[] = [];
  for (const r of raw) {
    const text = r.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let start = Number.isFinite(r.start) ? r.start : words.length ? words[words.length - 1].end : 0;
    let end = Number.isFinite(r.end) ? r.end : start + 0.3;
    // Pure punctuation tokens attach to the previous word.
    if (/^[^\p{L}\p{N}]+$/u.test(text) && words.length) {
      const prev = words[words.length - 1];
      prev.text += text;
      prev.end = Math.max(prev.end, end);
      continue;
    }
    if (words.length) start = Math.max(start, words[words.length - 1].start + 0.01);
    if (end <= start) end = start + 0.12;
    if (duration && end > duration) end = Math.max(start + 0.05, duration);
    words.push({ id: uid(), text, start, end });
  }
  // Whisper sometimes gives a word a huge span before a pause; cap it so highlights stay honest.
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const maxLen = Math.max(0.6, w.text.length * 0.12);
    if (w.end - w.start > maxLen + 1.2) {
      const next = words[i + 1];
      if (!next || next.start - w.end > -0.01) w.start = Math.max(w.start, w.end - maxLen);
    }
  }
  return words;
}

function lineLength(words: Word[]): number {
  return words.reduce((n, w, i) => n + w.text.length + (i ? 1 : 0), 0);
}

/**
 * Group words into captions. Rules, in priority order:
 *  1. A long pause always breaks.
 *  2. Never exceed max characters (lines × chars), max words, or max duration.
 *  3. Prefer breaking after sentence punctuation, then after clauses once the caption is reasonably full.
 */
export function segmentWords(words: Word[], opt: SegmentOptions, duration?: number): Cue[] {
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const capacity = opt.maxChars * opt.maxLines;

  const flush = () => {
    if (!cur.length) return;
    cues.push({ id: uid('c'), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = { ...words[i], br: false };
    if (cur.length) {
      const last = cur[cur.length - 1];
      const gap = w.start - last.end;
      const wouldLen = lineLength([...cur, w]);
      const wouldDur = w.end - cur[0].start;
      const fill = lineLength(cur) / capacity;
      const natural = gap >= opt.pauseSplit || SENTENCE_END.test(last.text) || (CLAUSE_END.test(last.text) && fill >= 0.45);
      const forced = wouldLen > capacity || (opt.maxWords > 0 && cur.length >= opt.maxWords) || wouldDur > opt.maxDuration;
      if (natural) flush();
      else if (forced) {
        // Carry a dangling function word ("the", "to", "my"…) over to the next caption.
        let carry: Word[] = [];
        while (cur.length > 1 && carry.length < 2 && DANGLING.test(cur[cur.length - 1].text) && w.start - cur[cur.length - 1].end < opt.pauseSplit) {
          carry = [cur.pop()!, ...carry];
        }
        flush();
        cur = carry;
      }
    }
    cur.push(w);
    // Single word longer than capacity still gets its own caption.
  }
  flush();
  return finalizeTiming(cues, opt, duration);
}

/** Enforce min duration, close flicker gaps, and prevent overlaps. */
export function finalizeTiming(cues: Cue[], opt: SegmentOptions, duration?: number): Cue[] {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    c.start = c.words[0]?.start ?? c.start;
    c.end = Math.max(c.end, c.words[c.words.length - 1]?.end ?? c.end);
    const limit = next ? next.words[0]?.start ?? next.start : duration ?? c.end + 5;
    if (c.end - c.start < opt.minDuration) c.end = Math.min(c.start + opt.minDuration, limit);
    if (next) {
      const nextStart = next.words[0]?.start ?? next.start;
      const gap = nextStart - c.end;
      if (gap > 0 && gap < opt.closeGaps) c.end = nextStart;
      if (c.end > nextStart) c.end = nextStart;
    }
    if (duration !== undefined) c.end = Math.min(c.end, duration);
    if (c.end <= c.start) c.end = c.start + 0.05;
  }
  return cues;
}

/** Balanced line breaking for subtitle-file export (text-only, no measuring). */
export function wrapForFile(cue: Cue, maxChars: number, maxLines: number): string {
  if (cue.words.some((w) => w.br)) return cueTextWithBreaks(cue);
  const text = cueText(cue);
  if (text.length <= maxChars || maxLines < 2) return text;
  // Choose the split point that best balances two lines (bottom-heavy preferred, like broadcast).
  const words = cue.words.map((w) => w.text);
  let best = -1;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    if (a.length > maxChars * 1.15 || b.length > maxChars * 1.15) continue;
    let score = Math.abs(a.length - b.length);
    if (a.length > b.length) score += 2;
    if (CLAUSE_END.test(words[i - 1])) score -= 6;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return text;
  return words.slice(0, best).join(' ') + '\n' + words.slice(best).join(' ');
}
