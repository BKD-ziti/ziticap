import type { CaptionStyle, Cue, Word } from './types';
import { cueText, uid, wrapForFile } from './segment';
import { upper } from './vocab';

function ts(t: number, sep: ',' | '.'): string {
  t = Math.max(0, t);
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

export interface FileOptions {
  maxChars: number;
  maxLines: number;
  uppercase?: boolean;
}

const tx = (s: string, o: FileOptions) => (o.uppercase ? upper(s) : s);

export function toSRT(cues: Cue[], o: FileOptions): string {
  return cues
    .filter((c) => c.words.length)
    .map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${tx(wrapForFile(c, o.maxChars, o.maxLines), o)}\n`)
    .join('\n');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** WebVTT. With `words`, inline timestamps are emitted so players can do karaoke-style highlighting. */
export function toVTT(cues: Cue[], o: FileOptions & { words?: boolean }): string {
  const body = cues
    .filter((c) => c.words.length)
    .map((c) => {
      let text: string;
      if (o.words) {
        text = c.words
          .map((w, i) => (i === 0 ? '' : `<${ts(w.start, '.')}>`) + esc(tx(w.text, o)) + (i < c.words.length - 1 ? (w.br ? '\n' : ' ') : ''))
          .join('');
      } else text = esc(tx(wrapForFile(c, o.maxChars, o.maxLines), o));
      return `${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function toTXT(cues: Cue[]): string {
  // Paragraphs at long pauses read far better than one wall of text.
  const out: string[] = [];
  let para: string[] = [];
  cues.forEach((c, i) => {
    para.push(cueText(c));
    const next = cues[i + 1];
    if (!next || next.start - c.end > 1.5) {
      out.push(para.join(' '));
      para = [];
    }
  });
  return out.join('\n\n') + '\n';
}

function assColor(css: string, alpha = 1): string {
  let r = 255, g = 255, b = 255, a = alpha;
  const hex = css.match(/^#([0-9a-f]{6})$/i);
  const rgba = css.match(/rgba?\(([^)]+)\)/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else if (rgba) {
    const p = rgba[1].split(',').map((x) => parseFloat(x));
    [r, g, b] = p;
    if (p[3] !== undefined) a = p[3] * alpha;
  }
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
  return `&H${h(255 - a * 255)}${h(b)}${h(g)}${h(r)}`;
}

function assTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * Advanced SubStation Alpha — keeps font, colours, outline, position and
 * word-by-word karaoke (\k) so editors like Premiere, DaVinci & Aegisub get close to the look.
 */
export function toASS(cues: Cue[], style: CaptionStyle, W: number, H: number): string {
  const px = Math.round(style.fontSize * Math.min(W, H));
  const outline = style.boxEnabled ? Math.round(style.boxPadding * px * 0.5) : Math.round(style.strokeWidth * px);
  const borderStyle = style.boxEnabled ? 3 : 1;
  const marginV = Math.round((1 - style.positionY) * H - px * 0.6);
  const karaoke = style.highlight === 'karaoke' || style.highlight === 'color';
  const primary = karaoke ? assColor(style.highlightColor) : assColor(style.textColor);
  const secondary = assColor(style.textColor);
  const back = style.boxEnabled ? assColor(style.boxColor, style.boxOpacity) : assColor(style.shadowColor);
  const outlineCol = style.boxEnabled ? assColor(style.boxColor, style.boxOpacity) : assColor(style.strokeColor);
  const header = `[Script Info]
; Made with ZitiCap by BKDziti
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${px},${primary},${secondary},${outlineCol},${back},${style.fontWeight >= 600 ? -1 : 0},${style.italic ? -1 : 0},0,0,100,100,${(style.letterSpacing * px).toFixed(1)},0,${borderStyle},${outline},${Math.round(style.shadowOffset * px)},${style.align === 'left' ? 1 : style.align === 'right' ? 3 : 2},${Math.round(W * (1 - style.maxWidth) / 2)},${Math.round(W * (1 - style.maxWidth) / 2)},${Math.max(0, marginV)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues
    .filter((c) => c.words.length)
    .map((c) => {
      const words = c.words.map((w: Word, i) => {
        const text = (style.uppercase ? upper(w.text) : w.text).replace(/[{}]/g, '');
        const k = karaoke ? `{\\k${Math.max(1, Math.round(((c.words[i + 1]?.start ?? c.end) - (i === 0 ? c.start : w.start)) * 100))}}` : '';
        return k + text + (i < c.words.length - 1 ? (w.br ? '\\N' : ' ') : '');
      });
      return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${words.join('')}`;
    });
  return header + lines.join('\n') + '\n';
}

// ---------- Import ----------

function parseTs(s: string): number {
  const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return NaN;
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function cueFromText(start: number, end: number, text: string): Cue {
  const clean = text.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
  const lines = clean.split('\n');
  const tokens: { t: string; br: boolean }[] = [];
  lines.forEach((l, li) => {
    const parts = l.split(/\s+/).filter(Boolean);
    parts.forEach((p, pi) => tokens.push({ t: p, br: li < lines.length - 1 && pi === parts.length - 1 }));
  });
  const total = tokens.reduce((s, t) => s + t.t.length + 1, 0) || 1;
  let t = start;
  const words: Word[] = tokens.map((tk) => {
    const len = ((end - start) * (tk.t.length + 1)) / total;
    const w: Word = { id: uid(), text: tk.t, start: t, end: t + len, br: tk.br || undefined };
    t += len;
    return w;
  });
  return { id: uid('c'), start, end, words };
}

/** Parse SRT or WebVTT text into cues. */
export function parseSubtitles(text: string): Cue[] {
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const start = parseTs(a);
    const end = parseTs(z);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const body = lines.slice(ti + 1).join('\n');
    if (!body.trim()) continue;
    cues.push(cueFromText(start, Math.max(end, start + 0.1), body));
  }
  return cues.sort((x, y) => x.start - y.start);
}
