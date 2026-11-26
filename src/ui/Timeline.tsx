import { useEffect, useRef } from 'preact/hooks';
import { PEAKS_PER_SEC } from '../lib/audio';
import { moveCue, retimeCue } from '../lib/edit';
import { editor, playhead, playing, seek, select, setCues, useStore } from '../lib/store';
import type { Cue } from '../lib/types';
import { cueText } from '../lib/segment';
import { IZoomIn, IZoomOut } from './icons';

const RULER = 18;
const EDGE = 10; // px hit zone for cue edges

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pan'; startX: number; startScroll: number; moved: boolean; t: number }
  | { kind: 'move' | 'start' | 'end'; id: string; orig: Cue; t0: number; moved: boolean; cues: Cue[] }
  | { kind: 'word'; id: string; index: number; orig: Cue; cues: Cue[] }
  | { kind: 'pinch'; d0: number; pps0: number; center: number };

/** Canvas timeline: waveform, caption blocks (drag to move, drag edges to retime), word boundaries when zoomed. */
export function Timeline() {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cues = useStore(editor, (s) => s.project?.cues ?? []);
  const selectedId = useStore(editor, (s) => s.selectedId);
  const peaks = useStore(editor, (s) => s.peaks);
  const duration = useStore(editor, (s) => s.project?.media?.duration ?? 0);
  const view = useRef({ pps: 80, scroll: 0, width: 0, height: 0 }); // pixels per second, scroll in seconds
  const state = useRef({ cues, selectedId, peaks, duration });
  state.current = { cues, selectedId, peaks, duration };
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const hover = useRef<string>('');

  const tToX = (t: number) => (t - view.current.scroll) * view.current.pps;
  const xToT = (x: number) => x / view.current.pps + view.current.scroll;
  const clampScroll = () => {
    const v = view.current;
    const visible = v.width / v.pps;
    v.scroll = Math.max(0, Math.min(v.scroll, Math.max(0, state.current.duration - visible * 0.5)));
  };

  const draw = () => {
    const c = canvas.current;
    if (!c) return;
    const v = view.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (c.width !== Math.round(v.width * dpr) || c.height !== Math.round(v.height * dpr)) {
      c.width = Math.round(v.width * dpr);
      c.height = Math.round(v.height * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);
    const { cues, selectedId, peaks, duration } = state.current;
    const t0 = v.scroll;
    const t1 = xToT(v.width);
    const trackTop = RULER;
    const trackH = v.height - RULER;
    const waveH = Math.round(trackH * 0.42);
    const cueTop = trackTop + waveH + 4;
    const cueH = trackH - waveH - 10;

    // Beyond the end of media
    if (duration) {
      const xe = tToX(duration);
      if (xe < v.width) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(xe, 0, v.width - xe, v.height);
      }
    }

    // Ruler
    ctx.fillStyle = '#1d1b19';
    ctx.fillRect(0, 0, v.width, RULER);
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const major = steps.find((s) => s * v.pps >= 70) ?? 600;
    const minor = steps.find((s) => s * v.pps >= 12) ?? major;
    ctx.strokeStyle = '#3a352f';
    ctx.fillStyle = '#a69e91';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(tToX(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 6 : 12);
      ctx.lineTo(x, RULER);
      if (isMajor) {
        const m = Math.floor(t / 60);
        const s = t % 60;
        const label = major < 1 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
        ctx.fillText(label, x + 4, 8);
      }
    }
    ctx.stroke();

    // Waveform
    if (peaks && peaks.length) {
      ctx.fillStyle = 'rgba(246,235,214,0.28)';
      const mid = trackTop + waveH / 2 + 2;
      const half = waveH / 2 - 2;
      const step = 1; // one bar per css px
      for (let x = 0; x < v.width; x += step) {
        const ta = xToT(x);
        const tb = xToT(x + step);
        const ia = Math.max(0, Math.floor(ta * PEAKS_PER_SEC));
        const ib = Math.min(peaks.length, Math.ceil(tb * PEAKS_PER_SEC));
        let m = 0;
        for (let i = ia; i < ib; i++) if (peaks[i] > m) m = peaks[i];
        if (ib <= ia && ia < peaks.length) m = peaks[ia];
        const h = Math.max(0.5, Math.sqrt(m) * half);
        ctx.fillRect(x, mid - h, Math.max(1, step - 0.3), h * 2);
      }
    }

    // Cues
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    for (const c of cues) {
      if (c.end < t0 || c.start > t1) continue;
      const x = tToX(c.start);
      const w = Math.max(2, (c.end - c.start) * v.pps);
      const sel = c.id === selectedId;
      ctx.fillStyle = sel ? '#e5482f' : '#3a2620';
      ctx.strokeStyle = sel ? '#ff8a70' : '#6b3b2f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x + 0.5, cueTop + 0.5, w - 1, cueH - 1, 6);
      else ctx.rect(x + 0.5, cueTop + 0.5, w - 1, cueH - 1);
      ctx.fill();
      ctx.stroke();
      // Edge grips on the selected cue
      if (sel && w > 24) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x + 3, cueTop + cueH / 2 - 8, 2, 16);
        ctx.fillRect(x + w - 5, cueTop + cueH / 2 - 8, 2, 16);
      }
      // Word boundaries when zoomed in on the selected cue
      if (sel && v.pps >= 110) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let i = 1; i < c.words.length; i++) {
          const wx = Math.round(tToX(c.words[i].start)) + 0.5;
          ctx.moveTo(wx, cueTop + 4);
          ctx.lineTo(wx, cueTop + cueH - 4);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (w > 18) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 6, cueTop, w - 12, cueH);
        ctx.clip();
        ctx.fillStyle = sel ? '#fff' : '#f4ede1';
        if (sel && v.pps >= 110) {
          ctx.font = '600 11px Inter, system-ui, sans-serif';
          c.words.forEach((wd) => ctx.fillText(wd.text, tToX(wd.start) + 3, cueTop + cueH / 2));
        } else ctx.fillText(cueText(c), x + 8, cueTop + cueH / 2);
        ctx.restore();
      }
    }

    // Playhead
    const px = Math.round(tToX(playhead.get())) + 0.5;
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, v.height);
    ctx.stroke();
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px, 8);
    ctx.closePath();
    ctx.fill();
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Short clips: fit the whole video to the width so nothing looks tiny.
  const fitted = useRef(false);
  const fitOnce = () => {
    const v = view.current;
    const d = state.current.duration;
    if (fitted.current || !d || !v.width) return;
    fitted.current = true;
    if (d * v.pps < v.width) v.pps = (v.width - 24) / d;
  };
  const fitRef = useRef(fitOnce);
  fitRef.current = fitOnce;

  useEffect(() => {
    fitRef.current();
    drawRef.current();
  }, [cues, selectedId, peaks, duration]);

  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => {
      view.current.width = el.clientWidth;
      view.current.height = el.clientHeight;
      fitRef.current();
      drawRef.current();
    });
    ro.observe(el);
    // Initial zoom: about 12 s visible on phones, 20 s on desktop.
    view.current.pps = Math.max(20, el.clientWidth / (el.clientWidth < 700 ? 12 : 20));
    const unsub = playhead.subscribe((t) => {
      // Follow the playhead while playing.
      const v = view.current;
      if (playing.get() && !drag.current) {
        const x = tToX(t);
        if (x > v.width * 0.8 || x < 0) {
          v.scroll = t - (v.width * 0.25) / v.pps;
          clampScroll();
        }
      }
      drawRef.current();
    });
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const anchor = xToT(e.clientX - r.left);
        v.pps = Math.min(1200, Math.max(4, v.pps * Math.exp(-e.deltaY * 0.01)));
        v.scroll = anchor - (e.clientX - r.left) / v.pps;
      } else {
        v.scroll += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / v.pps;
      }
      clampScroll();
      drawRef.current();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      unsub();
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Keep selected cue in view when selected from the list.
  useEffect(() => {
    const c = cues.find((x) => x.id === selectedId);
    const v = view.current;
    if (!c || !v.width || drag.current) return;
    const x0 = tToX(c.start);
    const x1 = tToX(c.end);
    if (x0 < 0 || x1 > v.width) {
      v.scroll = c.start - (v.width * 0.2) / v.pps;
      clampScroll();
      drawRef.current();
    }
  }, [selectedId]);

  const hit = (x: number, y: number): { kind: 'move' | 'start' | 'end' | 'word'; cue: Cue; index?: number } | null => {
    const v = view.current;
    const trackH = v.height - RULER;
    const cueTop = RULER + Math.round(trackH * 0.42) + 4;
    if (y < cueTop - 4) return null;
    const { cues, selectedId } = state.current;
    // Selected cue gets priority (its edges and word boundaries).
    const sel = cues.find((c) => c.id === selectedId);
    const ordered = sel ? [sel, ...cues.filter((c) => c !== sel)] : cues;
    for (const c of ordered) {
      const x0 = tToX(c.start);
      const x1 = tToX(c.end);
      const edge = Math.min(EDGE, (x1 - x0) / 3);
      if (x >= x0 - edge && x <= x1 + edge) {
        if (c === sel && v.pps >= 110) {
          for (let i = 1; i < c.words.length; i++) if (Math.abs(x - tToX(c.words[i].start)) < 6) return { kind: 'word', cue: c, index: i };
        }
        if (Math.abs(x - x0) <= edge) return { kind: 'start', cue: c };
        if (Math.abs(x - x1) <= edge) return { kind: 'end', cue: c };
        if (x > x0 && x < x1) return { kind: 'move', cue: c };
      }
    }
    return null;
  };

  const local = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const snap = (t: number, exceptId: string) => {
    const thr = 8 / view.current.pps;
    const ph = playhead.get();
    if (Math.abs(t - ph) < thr) return ph;
    for (const c of state.current.cues) {
      if (c.id === exceptId) continue;
      if (Math.abs(t - c.start) < thr) return c.start;
      if (Math.abs(t - c.end) < thr) return c.end;
    }
    return t;
  };

  const onDown = (e: PointerEvent) => {
    ref.current!.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { kind: 'pinch', d0: Math.abs(a.x - b.x) || 1, pps0: view.current.pps, center: xToT((a.x + b.x) / 2) };
      return;
    }
    const h = hit(p.x, p.y);
    const cuesNow = state.current.cues;
    if (h?.kind === 'word') {
      drag.current = { kind: 'word', id: h.cue.id, index: h.index!, orig: h.cue, cues: cuesNow };
    } else if (h) {
      select(h.cue.id);
      drag.current = { kind: h.kind, id: h.cue.id, orig: h.cue, t0: xToT(p.x), moved: false, cues: cuesNow };
    } else if (p.y < RULER + 4 || e.pointerType === 'mouse') {
      drag.current = { kind: 'scrub' };
      seek(xToT(p.x));
    } else {
      drag.current = { kind: 'pan', startX: p.x, startScroll: view.current.scroll, moved: false, t: xToT(p.x) };
    }
  };

  const onMove = (e: PointerEvent) => {
    const p = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    const d = drag.current;
    const v = view.current;
    if (!d) {
      const h = hit(p.x, p.y);
      const cur = h ? (h.kind === 'move' ? 'grab' : 'ew-resize') : 'default';
      if (hover.current !== cur) {
        hover.current = cur;
        ref.current!.style.cursor = cur;
      }
      return;
    }
    if (d.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const dist = Math.abs(pts[0].x - pts[1].x) || 1;
      const cx = (pts[0].x + pts[1].x) / 2;
      v.pps = Math.min(1200, Math.max(4, (d.pps0 * dist) / d.d0));
      v.scroll = d.center - cx / v.pps;
      clampScroll();
      drawRef.current();
      return;
    }
    if (d.kind === 'scrub') {
      seek(xToT(p.x));
      return;
    }
    if (d.kind === 'pan') {
      if (Math.abs(p.x - d.startX) > 4) d.moved = true;
      v.scroll = d.startScroll - (p.x - d.startX) / v.pps;
      clampScroll();
      drawRef.current();
      return;
    }
    const t = xToT(p.x);
    const { duration } = state.current;
    const others = d.cues.filter((c) => c.id !== d.id);
    const prev = others.filter((c) => c.start < d.orig.start).pop();
    const next = others.find((c) => c.start >= d.orig.start);
    const lo = prev ? prev.end : 0;
    const hi = next ? next.start : duration || Infinity;
    let updated: Cue;
    if (d.kind === 'word') {
      const c = d.orig;
      const i = d.index;
      const min = c.words[i - 1].start + 0.03;
      const max = c.words[i].end - 0.03;
      const nt = Math.min(max, Math.max(min, snap(t, d.id)));
      const words = c.words.map((w, k) => (k === i - 1 ? { ...w, end: nt } : k === i ? { ...w, start: nt } : w));
      updated = { ...c, words };
      setCues(d.cues.map((c2) => (c2.id === d.id ? updated : c2)), `word:${d.id}:${i}`);
      return;
    }
    if (!d.moved && Math.abs((t - d.t0) * v.pps) < 3) return;
    d.moved = true;
    if (d.kind === 'move') {
      const len = d.orig.end - d.orig.start;
      let ns = snap(d.orig.start + (t - d.t0), d.id);
      const ne = snap(ns + len, d.id);
      if (ne !== ns + len) ns = ne - len;
      ns = Math.max(lo, Math.min(ns, hi - len));
      updated = moveCue(d.orig, ns - d.orig.start);
    } else if (d.kind === 'start') {
      const ns = Math.max(lo, Math.min(snap(t, d.id), d.orig.end - 0.1));
      updated = retimeCue(d.orig, ns, d.orig.end);
    } else {
      const ne = Math.min(hi, Math.max(snap(t, d.id), d.orig.start + 0.1));
      updated = retimeCue(d.orig, d.orig.start, ne);
    }
    setCues(d.cues.map((c) => (c.id === d.id ? updated : c)), `drag:${d.kind}:${d.id}`);
  };

  const onUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (pointers.current.size > 0) return;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'pan' && !d.moved) {
      select(null);
      seek(d.t);
    }
    if ((d.kind === 'move' || d.kind === 'start' || d.kind === 'end') && !d.moved) {
      // Tap on a cue: jump to its start.
      seek(d.orig.start);
    }
  };

  const zoom = (k: number) => {
    const v = view.current;
    const center = playhead.get();
    v.pps = Math.min(1200, Math.max(4, v.pps * k));
    v.scroll = center - v.width / 2 / v.pps;
    clampScroll();
    drawRef.current();
  };

  return (
    <div class="timeline" ref={ref} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label="Timeline">
      <canvas ref={canvas} />
      <div style={{ position: 'absolute', right: 4, top: 20, display: 'flex', gap: 2 }} onPointerDown={(e) => e.stopPropagation()}>
        <button class="icon-btn sm" aria-label="Zoom out" onClick={() => zoom(1 / 1.6)} style={{ background: 'rgba(18,17,16,.8)' }}>
          <IZoomOut size={16} />
        </button>
        <button class="icon-btn sm" aria-label="Zoom in" onClick={() => zoom(1.6)} style={{ background: 'rgba(18,17,16,.8)' }}>
          <IZoomIn size={16} />
        </button>
      </div>
    </div>
  );
}
