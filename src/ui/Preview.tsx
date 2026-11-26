import { useEffect, useRef, useState } from 'preact/hooks';
import { drawCaptions, cueBounds, visibleCue } from '../lib/render';
import { ensureFont } from '../lib/fonts';
import { editor, playhead, playing, registerVideo, togglePlay, updateProject, useStore } from '../lib/store';

/**
 * Video + caption overlay. The overlay canvas uses the *video's* pixel space, so
 * size/position here is exactly what export burns in.
 */
export function Preview() {
  const url = useStore(editor, (s) => s.url);
  const media = useStore(editor, (s) => s.project?.media ?? null);
  const cues = useStore(editor, (s) => s.project?.cues ?? null);
  const style = useStore(editor, (s) => s.project?.style ?? null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const live = useRef({ cues, style });
  live.current = { cues, style };

  const W = media?.width ?? 1920;
  const H = media?.height ?? 1080;

  // Fit the video box into the available space, preserving aspect ratio.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const aw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ah = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const k = Math.min(aw / W, ah / H);
      setBox({ w: Math.max(1, Math.floor(W * k)), h: Math.max(1, Math.floor(H * k)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  const draw = () => {
    const c = canvasRef.current;
    const v = videoRef.current;
    const { cues, style } = live.current;
    if (!c || !style || !cues) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = Math.round(box.w * dpr);
    const ch = Math.round(box.h * dpr);
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    drawCaptions(ctx, W, H, v ? v.currentTime : playhead.get(), cues, style);
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Redraw whenever captions/style/size change; fonts may arrive late, so redraw then too.
  useEffect(() => {
    draw();
    if (style && cues) void ensureFont(style, cues).then(() => drawRef.current());
  }, [cues, style, box.w, box.h]);

  // Frame-accurate sync during playback.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    registerVideo(v);
    let raf = 0;
    let vfc = 0;
    const hasVFC = 'requestVideoFrameCallback' in v;
    const tick = () => {
      playhead.set(v.currentTime);
      drawRef.current();
      if (!v.paused) schedule();
    };
    const schedule = () => {
      if (hasVFC) vfc = (v as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number }).requestVideoFrameCallback(tick);
      else raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      playing.set(true);
      schedule();
    };
    const onPause = () => {
      playing.set(false);
      tick();
    };
    const onSeek = () => tick();
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeek);
    v.addEventListener('seeking', onSeek);
    v.addEventListener('loadeddata', onSeek);
    return () => {
      cancelAnimationFrame(raf);
      if (hasVFC && vfc) (v as HTMLVideoElement & { cancelVideoFrameCallback(id: number): void }).cancelVideoFrameCallback(vfc);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeek);
      v.removeEventListener('seeking', onSeek);
      v.removeEventListener('loadeddata', onSeek);
      registerVideo(null);
    };
  }, [url]);

  // Drag the caption to reposition it; tap elsewhere toggles playback.
  const drag = useRef<{ startY: number; startPos: number; moved: boolean; onCaption: boolean } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    const el = boxRef.current;
    const v = videoRef.current;
    const { cues, style } = live.current;
    if (!el || !style || !cues) return;
    const r = el.getBoundingClientRect();
    const y = ((e.clientY - r.top) / r.height) * H;
    const x = ((e.clientX - r.left) / r.width) * W;
    const cue = visibleCue(cues, v?.currentTime ?? 0) ?? cues[0];
    let onCaption = false;
    if (cue) {
      const ctx = canvasRef.current!.getContext('2d')!;
      const b = cueBounds(ctx, cue, style, W, H);
      onCaption = x >= b.x && x <= b.x + b.w && y >= b.y - H * 0.03 && y <= b.y + b.h + H * 0.03;
    }
    drag.current = { startY: e.clientY, startPos: style.positionY, moved: false, onCaption };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const el = boxRef.current;
    if (!d || !el || !d.onCaption) return;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) < 4) return;
    d.moved = true;
    setDragging(true);
    const pos = Math.min(0.95, Math.max(0.05, d.startPos + dy / el.getBoundingClientRect().height));
    updateProject((p) => ({ ...p, style: { ...p.style, positionY: Math.round(pos * 1000) / 1000 } }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d && !d.moved) togglePlay();
  };

  return (
    <div class="preview-wrap" ref={wrapRef}>
      <div
        ref={boxRef}
        class={`preview${dragging ? ' dragging' : ''}`}
        style={{ width: box.w + 'px', height: box.h + 'px' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {url && <video ref={videoRef} src={url} playsInline preload="auto" />}
        <canvas ref={canvasRef} aria-label="Caption preview" />
        <div class="drag-hint">Position {Math.round((style?.positionY ?? 0) * 100)}%</div>
      </div>
    </div>
  );
}
