import { useEffect, useRef } from 'preact/hooks';
import { drawCue } from '../lib/render';
import { ensureFont } from '../lib/fonts';
import { FONTS, STYLE_PRESETS, segmentPreset, type StylePreset } from '../lib/presets';
import { reflow } from '../lib/edit';
import { editor, setCues, updateProject, useStore } from '../lib/store';
import type { Animation, CaptionStyle, Cue, HighlightMode } from '../lib/types';

const SAMPLE: Cue = {
  id: 'sample',
  start: 0,
  end: 2,
  words: [
    { id: 'a', text: 'Captions', start: 0, end: 0.5 },
    { id: 'b', text: 'that', start: 0.5, end: 0.8 },
    { id: 'c', text: 'stick', start: 0.8, end: 1.6 },
  ],
};

function PresetThumb({ preset, active, onPick }: { preset: StylePreset; active: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const W = 320;
    const H = 200;
    c.width = W * 2;
    c.height = H * 2;
    const paint = () => {
      const ctx = c.getContext('2d')!;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#3d2a22');
      g.addColorStop(1, '#14110f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      const style = { ...preset.style, positionY: 0.5, fontSize: preset.style.fontSize * 1.6, maxWidth: 0.94 };
      drawCue(ctx, W, H, 0.9, SAMPLE, style);
    };
    paint();
    void ensureFont(preset.style, [SAMPLE]).then(paint);
  }, [preset]);
  return (
    <button class="preset" aria-pressed={active} onClick={onPick} title={preset.note}>
      <canvas ref={ref} />
      <span>{preset.name}</span>
    </button>
  );
}

function Range({ label, value, min, max, step, onInput, fmt }: { label: string; value: number; min: number; max: number; step: number; onInput: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label class="ctl">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))} />
      <output>{fmt ? fmt(value) : value}</output>
    </label>
  );
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseInt(x));
    return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return '#ffffff';
}

function Color({ label, value, onInput }: { label: string; value: string; onInput: (v: string) => void }) {
  return (
    <label class="ctl">
      <span>{label}</span>
      <span />
      <input type="color" value={toHex(value)} onInput={(e) => onInput((e.target as HTMLInputElement).value)} aria-label={label} />
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="group">
      {options.map(([v, l]) => (
        <button aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function StylePanel() {
  const project = useStore(editor, (s) => s.project);
  if (!project) return null;
  const s = project.style;
  const set = (patch: Partial<CaptionStyle>) => updateProject((p) => ({ ...p, style: { ...p.style, ...patch }, stylePreset: 'custom' }));
  const font = FONTS.find((f) => f.family === s.fontFamily) ?? FONTS[0];

  const pick = (preset: StylePreset) => {
    const changesSeg = preset.segment !== project.segmentPreset;
    updateProject((p) => ({ ...p, style: { ...preset.style }, stylePreset: preset.id, segmentPreset: preset.segment, segment: { ...segmentPreset(preset.segment).options } }));
    // Re-group captions to suit the preset's pacing (undoable).
    if (changesSeg && project.cues.length) setCues(reflow(project.cues, segmentPreset(preset.segment).options, project.media?.duration));
  };

  return (
    <div>
      <div class="presets">
        {STYLE_PRESETS.map((p) => (
          <PresetThumb preset={p} active={project.stylePreset === p.id} onPick={() => pick(p)} />
        ))}
      </div>
      <p class="tiny faint" style={{ margin: '8px 2px 0' }}>
        Picking a look also sets caption pacing. Drag the caption on the video to move it.
      </p>

      <div class="group" style={{ marginTop: 12 }}>
        <h4>Type</h4>
        <label class="ctl">
          <span>Font</span>
          <select
            class="input"
            value={s.fontFamily}
            onChange={(e) => {
              const f = FONTS.find((x) => x.family === (e.target as HTMLSelectElement).value)!;
              set({ fontFamily: f.family, fontWeight: f.weights.includes(s.fontWeight) ? s.fontWeight : f.weights[f.weights.length - 1] });
            }}
          >
            {FONTS.map((f) => (
              <option value={f.family}>{f.label}</option>
            ))}
          </select>
          <span />
        </label>
        {font.weights.length > 1 && (
          <label class="ctl">
            <span>Weight</span>
            <select class="input" value={s.fontWeight} onChange={(e) => set({ fontWeight: parseInt((e.target as HTMLSelectElement).value) })}>
              {font.weights.map((w) => (
                <option value={w}>{({ 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' } as Record<number, string>)[w]}</option>
              ))}
            </select>
            <span />
          </label>
        )}
        <Range label="Size" value={s.fontSize} min={0.025} max={0.14} step={0.001} onInput={(v) => set({ fontSize: v })} fmt={(v) => `${Math.round(v * 1000) / 10}`} />
        <Range label="Spacing" value={s.letterSpacing} min={-0.05} max={0.2} step={0.005} onInput={(v) => set({ letterSpacing: v })} fmt={(v) => v.toFixed(2)} />
        <Range label="Line height" value={s.lineHeight} min={0.9} max={1.8} step={0.01} onInput={(v) => set({ lineHeight: v })} fmt={(v) => v.toFixed(2)} />
        <label class="switch">
          <input type="checkbox" checked={s.uppercase} onChange={(e) => set({ uppercase: (e.target as HTMLInputElement).checked })} /> ALL CAPS
        </label>
        <Color label="Text" value={s.textColor} onInput={(v) => set({ textColor: v })} />
      </div>

      <div class="group">
        <h4>Word highlight</h4>
        <Seg<HighlightMode>
          value={s.highlight}
          options={[
            ['none', 'None'],
            ['color', 'Color'],
            ['box', 'Box'],
            ['karaoke', 'Fill'],
            ['reveal', 'Reveal'],
          ]}
          onChange={(v) => set({ highlight: v })}
        />
        {s.highlight !== 'none' && s.highlight !== 'reveal' && <Color label="Highlight" value={s.highlightColor} onInput={(v) => set({ highlightColor: v })} />}
        {s.highlight === 'box' && <Color label="Text on box" value={s.highlightTextColor} onInput={(v) => set({ highlightTextColor: v })} />}
      </div>

      <div class="group">
        <h4>Outline & shadow</h4>
        <Range label="Outline" value={s.strokeWidth} min={0} max={0.3} step={0.005} onInput={(v) => set({ strokeWidth: v })} fmt={(v) => `${Math.round(v * 100)}`} />
        {s.strokeWidth > 0 && <Color label="Outline color" value={s.strokeColor} onInput={(v) => set({ strokeColor: v })} />}
        <Range label="Shadow" value={s.shadowBlur} min={0} max={0.6} step={0.01} onInput={(v) => set({ shadowBlur: v, shadowOffset: v > 0 ? Math.max(s.shadowOffset, 0.02) : 0 })} fmt={(v) => `${Math.round(v * 100)}`} />
      </div>

      <div class="group">
        <h4>Background</h4>
        <label class="switch">
          <input type="checkbox" checked={s.boxEnabled} onChange={(e) => set({ boxEnabled: (e.target as HTMLInputElement).checked })} /> Background box
        </label>
        {s.boxEnabled && (
          <>
            <Color label="Box color" value={s.boxColor} onInput={(v) => set({ boxColor: v })} />
            <Range label="Opacity" value={s.boxOpacity} min={0.1} max={1} step={0.01} onInput={(v) => set({ boxOpacity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Range label="Padding" value={s.boxPadding} min={0.05} max={0.8} step={0.01} onInput={(v) => set({ boxPadding: v })} fmt={(v) => v.toFixed(2)} />
            <Range label="Roundness" value={s.boxRadius} min={0} max={0.6} step={0.01} onInput={(v) => set({ boxRadius: v })} fmt={(v) => v.toFixed(2)} />
            <label class="switch">
              <input type="checkbox" checked={s.boxPerLine} onChange={(e) => set({ boxPerLine: (e.target as HTMLInputElement).checked })} /> One box per line
            </label>
          </>
        )}
      </div>

      <div class="group">
        <h4>Layout & motion</h4>
        <Range label="Position" value={s.positionY} min={0.05} max={0.95} step={0.005} onInput={(v) => set({ positionY: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Range label="Max width" value={s.maxWidth} min={0.3} max={0.98} step={0.01} onInput={(v) => set({ maxWidth: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Seg<'left' | 'center' | 'right'>
          value={s.align}
          options={[
            ['left', 'Left'],
            ['center', 'Center'],
            ['right', 'Right'],
          ]}
          onChange={(v) => set({ align: v })}
        />
        <Seg<Animation>
          value={s.animation}
          options={[
            ['none', 'Static'],
            ['pop', 'Pop'],
            ['fade', 'Fade'],
            ['rise', 'Rise'],
          ]}
          onChange={(v) => set({ animation: v })}
        />
      </div>
    </div>
  );
}
