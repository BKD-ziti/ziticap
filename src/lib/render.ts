/**
 * Caption renderer shared by the live preview and the export pipeline.
 * Everything is laid out in *video pixel* units, so what you see in the editor
 * is exactly what gets burned into the file, at any resolution or orientation.
 */
import type { CaptionStyle, Cue, Word } from './types';
import { protectedTerms, upper } from './vocab';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface LWord {
  word: Word;
  text: string;
  x: number; // relative to line start
  w: number;
}
interface LLine {
  words: LWord[];
  width: number;
}
export interface Layout {
  lines: LLine[];
  px: number;
  lineH: number;
  space: number;
  baselineOffset: number;
  blockW: number;
  blockH: number;
  top: number;
  regionLeft: number;
  regionRight: number;
}

export function fontString(style: CaptionStyle, px: number): string {
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${px.toFixed(2)}px "${style.fontFamily}", "Inter", system-ui, sans-serif`;
}

export function fontPx(style: CaptionStyle, W: number, H: number): number {
  return Math.max(6, style.fontSize * Math.min(W, H));
}

function setSpacing(ctx: Ctx, style: CaptionStyle, px: number) {
  const c = ctx as Ctx & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${(style.letterSpacing * px).toFixed(2)}px`;
}

const layoutCache = new Map<string, Layout>();
let cacheKeyStyle = '';

function styleKey(style: CaptionStyle, W: number, H: number) {
  return [protectedTerms().join(','), style.fontFamily, style.fontWeight, style.italic, style.fontSize, style.uppercase, style.maxWidth, style.lineHeight, style.letterSpacing, style.positionY, style.align, style.boxPadding, W, H].join('|');
}

function wrap(items: LWord[], space: number, maxW: number): LWord[][] {
  const lines: LWord[][] = [];
  let line: LWord[] = [];
  let width = 0;
  for (const it of items) {
    const add = line.length ? space + it.w : it.w;
    if (line.length && width + add > maxW) {
      lines.push(line);
      line = [];
      width = 0;
    }
    line.push(it);
    width += line.length > 1 ? space + it.w : it.w;
    if (it.word.br) {
      lines.push(line);
      line = [];
      width = 0;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

export function layoutCue(ctx: Ctx, cue: Cue, style: CaptionStyle, W: number, H: number): Layout {
  const sk = styleKey(style, W, H);
  if (sk !== cacheKeyStyle) {
    layoutCache.clear();
    cacheKeyStyle = sk;
  }
  const key = cue.id + ':' + cue.words.map((w) => w.text + (w.br ? '\n' : '')).join(' ');
  const hit = layoutCache.get(key);
  if (hit) return hit;

  const px = fontPx(style, W, H);
  ctx.font = fontString(style, px);
  setSpacing(ctx, style, px);
  const space = ctx.measureText(' ').width + style.letterSpacing * px;
  const items: LWord[] = cue.words.map((word) => {
    const text = style.uppercase ? upper(word.text) : word.text;
    return { word, text, x: 0, w: ctx.measureText(text).width };
  });
  const maxW = Math.max(px * 2, style.maxWidth * W);
  let lines = wrap(items, space, maxW);
  // Balance: find the narrowest width that keeps the same line count, so lines look even.
  if (lines.length > 1 && !cue.words.some((w) => w.br)) {
    let lo = Math.max(...items.map((i) => i.w));
    let hi = maxW;
    for (let iter = 0; iter < 14 && hi - lo > 1; iter++) {
      const mid = (lo + hi) / 2;
      if (wrap(items, space, mid).length <= lines.length) hi = mid;
      else lo = mid;
    }
    lines = wrap(items, space, hi);
  }
  const outLines: LLine[] = lines.map((ws) => {
    let x = 0;
    const words = ws.map((it, i) => {
      if (i) x += space;
      const lw = { ...it, x };
      x += it.w;
      return lw;
    });
    return { words, width: x };
  });
  const m = ctx.measureText('HÁgy');
  const asc = m.actualBoundingBoxAscent || px * 0.75;
  const desc = m.actualBoundingBoxDescent || px * 0.2;
  const lineH = px * style.lineHeight;
  const blockW = Math.max(...outLines.map((l) => l.width));
  const blockH = lineH * outLines.length;
  const pad = style.boxEnabled ? style.boxPadding * px : 0;
  const margin = Math.min(W, H) * 0.04;
  let top = style.positionY * H - blockH / 2;
  top = Math.min(Math.max(top, margin + pad), H - margin - pad - blockH);
  const regionLeft = (W - maxW) / 2;
  const layout: Layout = {
    lines: outLines,
    px,
    lineH,
    space,
    baselineOffset: (asc - desc) / 2,
    blockW,
    blockH,
    top,
    regionLeft,
    regionRight: regionLeft + maxW,
  };
  if (layoutCache.size > 400) layoutCache.clear();
  layoutCache.set(key, layout);
  return layout;
}

function lineX(layout: Layout, line: LLine, style: CaptionStyle, W: number): number {
  if (style.align === 'left') return layout.regionLeft;
  if (style.align === 'right') return layout.regionRight - line.width;
  return (W - line.width) / 2;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function activeWordIndex(cue: Cue, t: number): number {
  let idx = -1;
  for (let i = 0; i < cue.words.length; i++) if (cue.words[i].start <= t + 1e-4) idx = i;
  return idx;
}

function withAlpha(color: string, a: number): string {
  if (a >= 1) return color;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

/** Find cue to show at time t (last one that started, if overlapping). Cues must be sorted. */
export function visibleCue(cues: Cue[], t: number): Cue | null {
  let found: Cue | null = null;
  for (const c of cues) {
    if (c.start > t) break;
    if (t < c.end) found = c;
  }
  return found;
}

export function drawCaptions(ctx: Ctx, W: number, H: number, t: number, cues: Cue[], style: CaptionStyle) {
  const cue = visibleCue(cues, t);
  if (!cue || !cue.words.length) return;
  drawCue(ctx, W, H, t, cue, style);
}

export function drawCue(ctx: Ctx, W: number, H: number, t: number, cue: Cue, style: CaptionStyle) {
  const L = layoutCue(ctx, cue, style, W, H);
  const { px } = L;
  const sinceIn = t - cue.start;
  const untilOut = cue.end - t;

  // Cue-level animation
  let alpha = 1;
  let scale = 1;
  let dy = 0;
  if (style.animation === 'pop') {
    const p = clamp01(sinceIn / 0.16);
    scale = 0.82 + 0.18 * easeOutBack(p);
  } else if (style.animation === 'fade') {
    alpha = Math.min(clamp01(sinceIn / 0.15), clamp01(untilOut / 0.1));
  } else if (style.animation === 'rise') {
    const p = easeOut(clamp01(sinceIn / 0.2));
    alpha = p;
    dy = (1 - p) * px * 0.35;
  }
  if (alpha <= 0) return;

  const active = activeWordIndex(cue, t);
  const cx = W / 2;
  const cy = L.top + L.blockH / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + dy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  ctx.font = fontString(style, px);
  setSpacing(ctx, style, px);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const reveal = style.highlight === 'reveal';
  const visible = (gi: number) => !reveal || gi <= active;

  // Precompute word positions
  type P = { lw: LWord; x: number; y: number; gi: number; wScale: number; wDy: number; wAlpha: number };
  const placed: P[] = [];
  let gi = 0;
  L.lines.forEach((line, li) => {
    const x0 = lineX(L, line, style, W);
    const yMid = L.top + li * L.lineH + L.lineH / 2;
    for (const lw of line.words) {
      let wScale = 1;
      let wDy = 0;
      let wAlpha = 1;
      const isActive = gi === active && style.highlight !== 'none';
      if (isActive && style.animation === 'pop' && (style.highlight === 'color' || style.highlight === 'box')) {
        const p = clamp01((t - lw.word.start) / 0.14);
        wScale = 1 + 0.07 * (p < 1 ? easeOutBack(p) : 1) - 0.04 * clamp01((t - lw.word.start - 0.14) / 0.1);
      }
      if (reveal) {
        const p = easeOut(clamp01((t - lw.word.start) / 0.16));
        wAlpha = p;
        if (style.animation === 'rise' || style.animation === 'pop') wDy = (1 - p) * px * 0.3;
      }
      placed.push({ lw, x: x0 + lw.x, y: yMid + L.baselineOffset, gi, wScale, wDy, wAlpha });
      gi++;
    }
  });

  // 1) Background boxes
  if (style.boxEnabled) {
    const pad = style.boxPadding * px;
    const padY = pad * 0.55;
    ctx.fillStyle = withAlpha(style.boxColor, style.boxOpacity);
    if (style.boxPerLine) {
      L.lines.forEach((line, li) => {
        const lineWords = placed.filter((p) => line.words.includes(p.lw) && visible(p.gi));
        if (!lineWords.length) return;
        const x0 = lineWords[0].x;
        const last = lineWords[lineWords.length - 1];
        const x1 = last.x + last.lw.w;
        const y = L.top + li * L.lineH;
        roundRect(ctx, x0 - pad, y - padY + L.lineH * 0.02, x1 - x0 + pad * 2, L.lineH + padY * 2 - L.lineH * 0.04, style.boxRadius * px);
        ctx.fill();
      });
    } else {
      const vis = placed.filter((p) => visible(p.gi));
      if (vis.length) {
        const x0 = Math.min(...vis.map((p) => p.x));
        const x1 = Math.max(...vis.map((p) => p.x + p.lw.w));
        roundRect(ctx, x0 - pad, L.top - padY, x1 - x0 + pad * 2, L.blockH + padY * 2, style.boxRadius * px);
        ctx.fill();
      }
    }
  }

  // 2) Active-word box highlight
  if (style.highlight === 'box' && active >= 0) {
    const p = placed[active];
    if (p) {
      const padX = px * 0.16;
      const padY = px * 0.1;
      const h = px * 1.02 + padY * 2;
      const cxw = p.x + p.lw.w / 2;
      const cyw = p.y - L.baselineOffset;
      const w = (p.lw.w + padX * 2) * p.wScale;
      const hh = h * p.wScale;
      ctx.fillStyle = style.highlightColor;
      roundRect(ctx, cxw - w / 2, cyw - hh / 2, w, hh, px * 0.22);
      ctx.fill();
    }
  }

  const drawWord = (p: P, pass: 'stroke' | 'fill') => {
    if (!visible(p.gi)) return;
    const { lw } = p;
    ctx.save();
    if (p.wAlpha < 1) ctx.globalAlpha = alpha * p.wAlpha;
    if (p.wScale !== 1 || p.wDy) {
      const ox = p.x + lw.w / 2;
      const oy = p.y - L.baselineOffset;
      ctx.translate(ox, oy + p.wDy);
      ctx.scale(p.wScale, p.wScale);
      ctx.translate(-ox, -oy);
    }
    if (pass === 'stroke') {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = style.strokeWidth * px * 2;
      ctx.strokeText(lw.text, p.x, p.y);
    } else {
      const isActive = p.gi === active;
      let color = style.textColor;
      if (style.highlight === 'color' && isActive) color = style.highlightColor;
      if (style.highlight === 'box' && isActive) color = style.highlightTextColor;
      if (style.highlight === 'karaoke' && p.gi < active) color = style.highlightColor;
      ctx.fillStyle = color;
      ctx.fillText(lw.text, p.x, p.y);
      if (style.highlight === 'karaoke' && isActive) {
        const w = lw.word;
        const prog = clamp01((t - w.start) / Math.max(0.05, w.end - w.start));
        ctx.save();
        ctx.beginPath();
        ctx.rect(p.x - px, p.y - px * 1.5, px + lw.w * prog, px * 3);
        ctx.clip();
        ctx.fillStyle = style.highlightColor;
        ctx.fillText(lw.text, p.x, p.y);
        ctx.restore();
      }
    }
    ctx.restore();
  };

  // 3) Shadows + strokes first (so a word's shadow never darkens its neighbour's fill)
  const hasStroke = style.strokeWidth > 0;
  const hasShadow = style.shadowBlur > 0 || style.shadowOffset > 0;
  if (hasShadow) {
    ctx.shadowColor = style.shadowColor;
    ctx.shadowBlur = style.shadowBlur * px;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = style.shadowOffset * px;
  }
  if (hasStroke) {
    for (const p of placed) {
      if (style.highlight === 'box' && p.gi === active) continue;
      drawWord(p, 'stroke');
    }
  } else if (hasShadow) {
    for (const p of placed) {
      if (style.highlight === 'box' && p.gi === active) continue;
      drawWord(p, 'fill');
    }
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // 4) Fills
  for (const p of placed) drawWord(p, 'fill');
  ctx.restore();
}

/** Bounding box of the caption block for hit-testing (drag-to-position in the preview). */
export function cueBounds(ctx: Ctx, cue: Cue, style: CaptionStyle, W: number, H: number) {
  const L = layoutCue(ctx, cue, style, W, H);
  const pad = (style.boxEnabled ? style.boxPadding : 0.15) * L.px;
  return { x: (W - L.blockW) / 2 - pad, y: L.top - pad, w: L.blockW + pad * 2, h: L.blockH + pad * 2 };
}

/**
 * Generous display-space bounds of everything drawCue paints for this cue (glyphs, outline,
 * shadow, boxes, pop/rise animation), used to limit work when compositing into video planes.
 */
export function captionRect(ctx: Ctx, cue: Cue, style: CaptionStyle, W: number, H: number) {
  const L = layoutCue(ctx, cue, style, W, H);
  const px = L.px;
  const extra = px * (0.5 + style.strokeWidth * 2 + style.shadowBlur * 2 + style.shadowOffset + (style.boxEnabled ? style.boxPadding * 1.2 : 0));
  const grow = 0.12; // animation scale headroom
  const left = Math.min(L.regionLeft, (W - L.blockW) / 2) - L.blockW * grow - extra;
  const right = Math.max(L.regionRight, (W + L.blockW) / 2) + L.blockW * grow + extra;
  const top = L.top - L.blockH * grow - extra - px * 0.4;
  const bottom = L.top + L.blockH * (1 + grow) + extra + px * 0.4;
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  return { x, y, w: Math.min(W, Math.ceil(right)) - x, h: Math.min(H, Math.ceil(bottom)) - y };
}
