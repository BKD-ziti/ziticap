/**
 * Custom vocabulary: names and brands the speech model can't know.
 *
 * - Auto-corrections run on every transcript ("Big Ziti", "Big ZD", "BKD Ziti" → "BKDziti").
 * - Their spellings are protected: ALL-CAPS styles and case tools never turn "BKDziti" into "BKDZITI".
 * - Cloud engines also get them as a spelling hint up front.
 */
import { uid } from './segment';

export interface FixRule {
  id: string;
  /** What the transcript might say. Comma-separated alternatives. */
  from: string;
  /** How it should be written — exactly this casing. */
  to: string;
  enabled: boolean;
  builtin?: boolean;
}

export const BRAND = 'BKDziti';

/**
 * Everything Whisper tends to hear when someone says "BKDziti" (pronounced "big ziti"):
 * big ziti / big zeety / big zitty / big ZD / big Z.D. / big Z D / BKD ziti / B.K.D. ziti / bkdziti / bigziti …
 */
const BRAND_PATTERN =
  "(?:b\\.?\\s?k\\.?\\s?d\\.?|big|bk|b\\.?\\s?k\\.?)[\\s.\\-]*(?:d[\\s.\\-]*)?(?:z(?:iti|itti|itty|eety|eeti|eti|ity|itee|iddy|iti)|z\\.?\\s?d\\.?|zd|zee\\s?dee|zee\\s?d)";

export const DEFAULT_RULES: FixRule[] = [
  { id: 'brand', from: 'Big Ziti, Big ZD, BKD Ziti, B.K.D. Ziti', to: BRAND, enabled: true, builtin: true },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ruleSource(r: FixRule): string {
  if (r.builtin && r.id === 'brand') return BRAND_PATTERN;
  const alts = r.from
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => a.split(/\s+/).map(esc).join('[\\s\\-]*'));
  return alts.length ? `(?:${alts.join('|')})` : '';
}

/** Whole-word regex for a rule; group 1 = possessive ('s) to keep. */
export function ruleRegex(r: FixRule): RegExp | null {
  const src = ruleSource(r);
  if (!src) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${src}((?:['’]s)?)(?![\\p{L}\\p{N}])`, 'giu');
}

// ---------------- shared, settings-backed state ----------------

let rules: FixRule[] = DEFAULT_RULES;
export function setRules(r: FixRule[]) {
  rules = r;
}
export function getRules() {
  return rules;
}
export function newRule(): FixRule {
  return { id: uid('r'), from: '', to: '', enabled: true };
}

/** Spellings that must keep their exact casing (anything with mixed case, like "BKDziti"). */
export function protectedTerms(): string[] {
  const out = rules.filter((r) => r.enabled && r.to.trim()).map((r) => r.to.trim());
  return out.filter((t) => t !== t.toUpperCase() || /\d/.test(t));
}

/** Uppercase, but keep protected spellings (BKDziti stays BKDziti). */
export function upper(text: string): string {
  let out = text.toUpperCase();
  for (const t of protectedTerms())
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(['’]s)?(?![\\p{L}\\p{N}])`, 'giu'), (_m, poss?: string) => t + (poss ? poss.toLowerCase() : ''));
  return out;
}

/** Restore protected spellings after any case change. */
export function restoreCase(text: string): string {
  let out = text;
  for (const t of protectedTerms()) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(?![\\p{L}\\p{N}])`, 'giu'), t);
  return out;
}

/** Spelling hint for cloud engines (Whisper "prompt"). */
export function vocabularyHint(): string {
  return Array.from(new Set(rules.filter((r) => r.enabled && r.to.trim()).map((r) => r.to.trim()))).join(', ');
}

// ---------------- applying to timed words ----------------

interface TimedWord {
  id?: string;
  text: string;
  start: number;
  end: number;
  br?: boolean;
}

/**
 * Apply every enabled rule across a word sequence. Matches may span several words
 * ("big" + "ziti") — they're merged into one word spanning the original time.
 */
export function applyFixes<T extends TimedWord>(words: T[], list: FixRule[] = rules): T[] {
  let cur = words;
  for (const r of list) {
    if (!r.enabled || !r.to.trim()) continue;
    const re = ruleRegex(r);
    if (!re) continue;
    // Joined text with a map from char offset → word index.
    let text = '';
    const startOf: number[] = [];
    cur.forEach((w, i) => {
      if (i) text += ' ';
      startOf.push(text.length);
      text += w.text;
    });
    const wordAt = (off: number) => {
      let lo = 0;
      let hi = startOf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (startOf[mid] <= off) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const matches = [...text.matchAll(re)];
    if (!matches.length) continue;
    const out: T[] = [];
    let i = 0;
    for (const m of matches) {
      const a = wordAt(m.index!);
      const b = wordAt(m.index! + m[0].length - 1);
      if (a < i) continue; // overlapping, already consumed
      while (i < a) out.push(cur[i++]);
      const first = cur[a];
      const last = cur[b];
      const before = first.text.slice(0, m.index! - startOf[a]);
      const after = last.text.slice(m.index! + m[0].length - startOf[b]);
      const replacement = before + r.to.trim() + (m[1] ?? '') + after;
      const parts = replacement.split(/\s+/).filter(Boolean);
      const span = last.end - first.start;
      const total = parts.reduce((s, p) => s + p.length, 0) || 1;
      let t = first.start;
      parts.forEach((p, k) => {
        const len = (span * p.length) / total;
        out.push({ ...first, id: k === 0 ? first.id : uid(), text: p, start: t, end: k === parts.length - 1 ? last.end : t + len, br: k === parts.length - 1 ? last.br : undefined });
        t += len;
      });
      i = b + 1;
    }
    while (i < cur.length) out.push(cur[i++]);
    cur = out;
  }
  return cur;
}
