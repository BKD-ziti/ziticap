import { memo } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  changeCase,
  fixVocabulary,
  countMatches,
  makeCueAt,
  mergeCues,
  reflow,
  removeFillers,
  replaceAll,
  retextCue,
  retimeCue,
  retimeWord,
  shiftAll,
  splitCueAtTime,
  splitCueAtWord,
} from '../lib/edit';
import { parseSubtitles } from '../lib/formats';
import { formatTime, parseTime } from '../lib/media';
import { SEGMENT_PRESETS, segmentPreset } from '../lib/presets';
import { cueText, cueTextWithBreaks } from '../lib/segment';
import { cancelTranscription, runTranscription, toastStore } from '../lib/session';
import { editor, playRange, playhead, seek, select, setCues, updateCue, updateProject, useStore } from '../lib/store';
import { LANGUAGES, LOCAL_MODELS } from '../lib/transcribe';
import { loadSettings } from '../lib/db';
import type { Cue } from '../lib/types';
import { IMerge, IMic, IPlay, IPlus, IScissors, ISearch, ITrash, IWand, IFile, IClock } from './icons';

export function CaptionsPanel({ openSettings }: { openSettings: () => void }) {
  const cues = useStore(editor, (s) => s.project?.cues ?? []);
  const busy = useStore(editor, (s) => s.busy);
  const transcribing = busy?.kind === 'transcribe' || (busy?.kind === 'audio' && cues.length === 0);
  const [tools, setTools] = useState<'' | 'find' | 'timing' | 'reflow'>('');

  if (!cues.length && !transcribing) return <TranscribeCard openSettings={openSettings} />;

  return (
    <div>
      {busy?.kind === 'transcribe' && <TranscribeProgress />}
      <div class="toolbar">
        <button class="btn small" onClick={() => addAtPlayhead()}>
          <IPlus size={16} /> Caption
        </button>
        <button class="btn small" aria-pressed={tools === 'find'} onClick={() => setTools(tools === 'find' ? '' : 'find')}>
          <ISearch size={16} /> Find
        </button>
        <button class="btn small" onClick={() => setTools(tools === 'timing' ? '' : 'timing')}>
          <IClock size={16} /> Sync
        </button>
        <button class="btn small" onClick={() => setTools(tools === 'reflow' ? '' : 'reflow')}>
          <IWand size={16} /> Tidy
        </button>
      </div>
      {tools === 'find' && <FindReplace />}
      {tools === 'timing' && <SyncTools />}
      {tools === 'reflow' && <TidyTools />}
      <CueList />
      {busy?.kind !== 'transcribe' && (
        <p class="tiny faint" style={{ textAlign: 'center', marginTop: 16 }}>
          Tip: tap a caption to jump there. Drag blocks on the timeline to move them, drag their edges to retime. Zoom in to drag individual word timings.
        </p>
      )}
    </div>
  );
}

function addAtPlayhead() {
  const s = editor.get();
  if (!s.project) return;
  const c = makeCueAt(s.project.cues, playhead.get(), s.project.media?.duration ?? 0);
  setCues([...s.project.cues, c]);
  select(c.id);
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-cue="${c.id}"] textarea`)?.select());
}

function TranscribeProgress() {
  const busy = useStore(editor, (s) => s.busy);
  if (!busy) return null;
  return (
    <div class="card stack tight" style={{ marginBottom: 10 }}>
      <div class="row">
        <IMic size={18} />
        <span class="grow small">{busy.label}</span>
        <button class="btn small" onClick={cancelTranscription}>
          Cancel
        </button>
      </div>
      <div class={`progress${busy.progress <= 0 ? ' indeterminate' : ''}`}>
        <i style={{ width: `${Math.round(busy.progress * 100)}%` }} />
      </div>
      <span class="tiny faint">Captions appear below as they’re recognised. Keep this tab open.</span>
    </div>
  );
}

function TranscribeCard({ openSettings }: { openSettings: () => void }) {
  const project = useStore(editor, (s) => s.project);
  const busy = useStore(editor, (s) => s.busy);
  const settings = loadSettings();
  const [lang, setLang] = useState(project?.language || settings.language || 'auto');
  const fileRef = useRef<HTMLInputElement>(null);
  const model = LOCAL_MODELS.find((m) => m.id === settings.localModel) ?? LOCAL_MODELS[1];
  const engineLabel =
    settings.engine === 'local'
      ? `On this device · Whisper ${model.name} (${model.size}, downloaded once)`
      : settings.engine === 'groq'
        ? 'Groq · Whisper Large v3 Turbo (your API key)'
        : 'OpenAI · Whisper (your API key)';
  const needsKey = (settings.engine === 'groq' && !settings.groqKey) || (settings.engine === 'openai' && !settings.openaiKey);

  const importFile = async (f: File) => {
    try {
      const text = await f.text();
      const cues = parseSubtitles(text);
      if (!cues.length) throw new Error('No captions found in that file.');
      setCues(fixVocabulary(cues));
      toastStore.show(`Imported ${cues.length} captions.`);
    } catch (e) {
      toastStore.show((e as Error).message, true);
    }
  };

  return (
    <div class="empty">
      <div class="drop-icon" style={{ margin: '0 auto', width: 56, height: 56, borderRadius: 18, display: 'grid', placeItems: 'center', background: 'var(--tomato)' }}>
        <IMic size={26} />
      </div>
      <h3>Transcribe this video</h3>
      <p class="muted small" style={{ margin: '0 auto 18px', maxWidth: 360, lineHeight: 1.5 }}>
        Every word gets its own timestamp, so captions can highlight in sync. You can fix anything afterwards.
      </p>
      <div class="stack" style={{ textAlign: 'left', maxWidth: 420, margin: '0 auto' }}>
        <label class="field">
          <span>Spoken language</span>
          <select class="input" value={lang} onChange={(e) => setLang((e.target as HTMLSelectElement).value)}>
            {LANGUAGES.map(([code, name]) => (
              <option value={code}>{name}</option>
            ))}
          </select>
        </label>
        <div class="row small">
          <span class="grow muted">{engineLabel}</span>
          <button class="btn small ghost" onClick={openSettings}>
            Change
          </button>
        </div>
        {needsKey ? (
          <button class="btn primary big block" onClick={openSettings}>
            Add API key to continue
          </button>
        ) : (
          <button class="btn primary big block" disabled={busy?.kind === 'transcribe'} onClick={() => runTranscription(lang)}>
            <IMic size={20} /> Transcribe
          </button>
        )}
        {busy?.kind === 'audio' && <span class="tiny faint">{busy.label}</span>}
        <div class="row" style={{ justifyContent: 'center', marginTop: 4 }}>
          <button class="btn small ghost" onClick={() => fileRef.current?.click()}>
            <IFile size={16} /> Import SRT / VTT
          </button>
          <button class="btn small ghost" onClick={addAtPlayhead}>
            <IPlus size={16} /> Start blank
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".srt,.vtt,text/vtt,application/x-subrip"
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void importFile(f);
          }}
        />
      </div>
    </div>
  );
}

function CueList() {
  const cues = useStore(editor, (s) => s.project?.cues ?? []);
  const selectedId = useStore(editor, (s) => s.selectedId);
  const activeId = useStore(playhead, (t) => {
    for (const c of editor.get().project?.cues ?? []) if (t >= c.start && t < c.end) return c.id;
    return null;
  });
  const listRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // Auto-scroll to the active caption during playback (unless the user is editing).
  useEffect(() => {
    if (!activeId || !following.current) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cue="${activeId}"]`);
    if (!el || el.contains(document.activeElement)) return;
    const scroller = el.closest('.panel-body') as HTMLElement | null;
    if (!scroller) return;
    const r = el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeId]);

  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cue="${selectedId}"]`);
    if (el && !el.contains(document.activeElement)) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  const fps = useStore(editor, (s) => s.project?.media?.fps ?? 30);
  return (
    <div class="cue-list" ref={listRef} onFocusIn={() => (following.current = false)} onFocusOut={() => (following.current = true)}>
      {cues.map((c, i) => (
        <CueCard key={c.id} cue={c} index={i} next={cues[i + 1]} prev={cues[i - 1]} active={c.id === activeId} selected={c.id === selectedId} fps={fps} />
      ))}
    </div>
  );
}

function TimeField({ value, onCommit, label, min, max }: { value: number; onCommit: (t: number) => void; label: string; min: number; max: number }) {
  const [text, setText] = useState(formatTime(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(formatTime(value));
  }, [value, focused]);
  const t = parseTime(text);
  const bad = Number.isNaN(t);
  const commit = () => {
    if (!bad) onCommit(Math.min(max, Math.max(min, t)));
    else setText(formatTime(value));
  };
  return (
    <input
      class={`time-in${bad ? ' bad' : ''}`}
      aria-label={label}
      inputMode="decimal"
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onInput={(e) => setText((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = (e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
          const nt = Math.min(max, Math.max(min, (bad ? value : t) + step));
          setText(formatTime(nt));
          onCommit(nt);
        }
      }}
    />
  );
}

const CueCard = memo(function CueCard({ cue, index, next, prev, active, selected, fps }: { cue: Cue; index: number; next?: Cue; prev?: Cue; active: boolean; selected: boolean; fps: number }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const base = useRef<Cue | null>(null);
  const [showWords, setShowWords] = useState(false);
  const [wordSel, setWordSel] = useState(-1);
  const duration = editor.get().project?.media?.duration ?? Infinity;
  const text = useMemo(() => cueTextWithBreaks(cue), [cue]);

  const grow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };
  useLayoutEffect(() => {
    const el = ta.current;
    if (el && document.activeElement !== el && el.value !== text) el.value = text;
    grow();
  }, [text]);

  const len = cue.end - cue.start;
  const cps = cueText(cue).replace(/\s/g, '').length / Math.max(0.1, len);
  const fast = cps > 20;
  const lo = prev ? prev.end : 0;
  const hi = next ? next.start : duration;

  const split = () => {
    const ph = playhead.get();
    // Split at the text cursor if typing; otherwise at the playhead.
    let parts: [Cue, Cue] | null = null;
    const el = ta.current;
    if (el && document.activeElement === el && el.selectionStart > 0 && el.selectionStart < el.value.length) {
      const before = el.value.slice(0, el.selectionStart).trim().split(/\s+/).filter(Boolean).length;
      parts = splitCueAtWord(cue, before);
    }
    if (!parts) parts = splitCueAtTime(cue, ph > cue.start && ph < cue.end ? ph : (cue.start + cue.end) / 2);
    if (!parts) return toastStore.show('Need at least two words to split.');
    const all = editor.get().project!.cues;
    setCues(all.flatMap((c) => (c.id === cue.id ? parts! : [c])));
  };

  const merge = () => {
    if (!next) return;
    const all = editor.get().project!.cues;
    const m = mergeCues(cue, next);
    setCues(all.filter((c) => c.id !== next.id).map((c) => (c.id === cue.id ? m : c)));
  };

  const remove = () => {
    const all = editor.get().project!.cues;
    setCues(all.filter((c) => c.id !== cue.id));
  };

  return (
    <div class={`cue${active ? ' active' : ''}${selected ? ' selected' : ''}`} data-cue={cue.id} onPointerDown={() => !selected && select(cue.id)}>
      <div class="cue-head">
        <span class="cue-idx mono">{index + 1}</span>
        <TimeField label="Start time" value={cue.start} min={lo} max={cue.end - 0.05} onCommit={(t) => updateCue(cue.id, (c) => retimeCue(c, t, c.end))} />
        <span class="faint tiny">→</span>
        <TimeField label="End time" value={cue.end} min={cue.start + 0.05} max={hi} onCommit={(t) => updateCue(cue.id, (c) => retimeCue(c, c.start, t))} />
        <span class="grow" />
        <button class="icon-btn sm" title="Play this caption" aria-label="Play this caption" onClick={() => playRange(cue.start, cue.end)}>
          <IPlay size={14} />
        </button>
        <button class="icon-btn sm" title="Split at playhead / cursor (S)" aria-label="Split caption" onClick={split}>
          <IScissors size={15} />
        </button>
        <button class="icon-btn sm" title="Merge with next (M)" aria-label="Merge with next caption" disabled={!next} onClick={merge}>
          <IMerge size={15} />
        </button>
        <button class="icon-btn sm danger" title="Delete" aria-label="Delete caption" onClick={remove}>
          <ITrash size={15} />
        </button>
      </div>
      <textarea
        ref={ta}
        rows={1}
        defaultValue={text}
        spellcheck
        aria-label={`Caption ${index + 1} text`}
        onFocus={() => {
          base.current = editor.get().project!.cues.find((c) => c.id === cue.id) ?? cue;
          select(cue.id);
          const ph = playhead.get();
          if (ph < cue.start || ph >= cue.end) seek(cue.start + 0.001);
        }}
        onInput={(e) => {
          grow();
          const value = (e.target as HTMLTextAreaElement).value;
          const b = base.current ?? cue;
          if (!value.trim()) return; // don't delete on empty; use the trash button
          updateCue(cue.id, () => ({ ...retextCue(b, value), id: cue.id }), `text:${cue.id}`);
        }}
        onBlur={(e) => {
          base.current = null;
          const el = e.target as HTMLTextAreaElement;
          if (!el.value.trim()) el.value = text;
        }}
      />
      <div class="cue-meta">
        <span class={`pill mono${fast ? ' warn' : ''}`} title="Reading speed (characters per second). Over ~20 is hard to read.">
          {len.toFixed(2)}s · {Math.round(cps)} cps
        </span>
        <span class="grow" />
        <button class="btn small ghost" onClick={() => setShowWords(!showWords)} aria-expanded={showWords}>
          {showWords ? 'Hide' : 'Word'} timing
        </button>
      </div>
      {showWords && (
        <div>
          <div class="words">
            {cue.words.map((w, i) => (
              <button
                class={`chip${wordSel === i ? ' sel' : ''}`}
                onClick={() => {
                  setWordSel(i);
                  seek(w.start + 0.001);
                }}
              >
                {w.text}
                <small>{formatTime(w.start)}</small>
              </button>
            ))}
          </div>
          {wordSel >= 0 && wordSel < cue.words.length && (
            <div class="row wrap" style={{ marginTop: 8 }}>
              <span class="small muted grow">“{cue.words[wordSel].text}”</span>
              <button class="btn small" onClick={() => updateCue(cue.id, (c) => retimeWord(c, wordSel, Math.max(0, c.words[wordSel].start - 1 / fps)))}>
                −1f
              </button>
              <button class="btn small" onClick={() => updateCue(cue.id, (c) => retimeWord(c, wordSel, c.words[wordSel].start + 1 / fps))}>
                +1f
              </button>
              <button class="btn small primary" onClick={() => updateCue(cue.id, (c) => retimeWord(c, wordSel, playhead.get()))}>
                Start = playhead
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function FindReplace() {
  const cues = useStore(editor, (s) => s.project?.cues ?? []);
  const [find, setFind] = useState('');
  const [rep, setRep] = useState('');
  const [cs, setCs] = useState(false);
  const [whole, setWhole] = useState(true);
  const n = countMatches(cues, find, { caseSensitive: cs, wholeWord: whole });
  return (
    <div class="findbar">
      <input class="input" placeholder="Find…" value={find} onInput={(e) => setFind((e.target as HTMLInputElement).value)} autoFocus />
      <input class="input" placeholder="Replace with…" value={rep} onInput={(e) => setRep((e.target as HTMLInputElement).value)} />
      <div class="row wrap">
        <label class="switch small">
          <input type="checkbox" checked={whole} onChange={(e) => setWhole((e.target as HTMLInputElement).checked)} /> Whole word
        </label>
        <label class="switch small">
          <input type="checkbox" checked={cs} onChange={(e) => setCs((e.target as HTMLInputElement).checked)} /> Match case
        </label>
        <span class="grow" />
        <span class="small muted">{find ? `${n} found` : ''}</span>
        <button
          class="btn small primary"
          disabled={!n}
          onClick={() => {
            setCues(replaceAll(cues, find, rep, { caseSensitive: cs, wholeWord: whole }));
            toastStore.show(`Replaced ${n}.`);
          }}
        >
          Replace all
        </button>
      </div>
      <span class="tiny faint">For one-off fixes. Names you use often belong in Settings → Word fixes, so every transcript gets them right.</span>
    </div>
  );
}

function SyncTools() {
  const [ms, setMs] = useState('100');
  const shift = (sign: number) => {
    const p = editor.get().project;
    const d = (parseFloat(ms) || 0) / 1000;
    if (p) setCues(shiftAll(p.cues, sign * d));
  };
  return (
    <div class="findbar">
      <span class="small">Shift every caption earlier or later — fixes audio that’s consistently ahead or behind.</span>
      <div class="row">
        <input class="input mono" style={{ width: 110 }} inputMode="numeric" value={ms} onInput={(e) => setMs((e.target as HTMLInputElement).value)} aria-label="Milliseconds" />
        <span class="small muted">ms</span>
        <span class="grow" />
        <button class="btn small" onClick={() => shift(-1)}>
          Earlier
        </button>
        <button class="btn small" onClick={() => shift(1)}>
          Later
        </button>
      </div>
    </div>
  );
}

function TidyTools() {
  const project = useStore(editor, (s) => s.project);
  if (!project) return null;
  const apply = (fn: (c: Cue[]) => Cue[], msg: string) => {
    setCues(fn(project.cues));
    toastStore.show(msg);
  };
  return (
    <div class="findbar">
      <label class="field">
        <span>Caption length</span>
        <div class="row">
          <select
            class="input grow"
            value={project.segmentPreset}
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              const opts = segmentPreset(id).options;
              updateProject((p) => ({ ...p, segmentPreset: id, segment: { ...opts } }));
            }}
          >
            {SEGMENT_PRESETS.map((s) => (
              <option value={s.id}>{s.name}</option>
            ))}
          </select>
          <button class="btn small primary" onClick={() => apply((c) => reflow(c, project.segment, project.media?.duration), 'Captions regrouped. Undo if you preferred the old ones.')}>
            Regroup
          </button>
        </div>
        <span class="tiny faint">{segmentPreset(project.segmentPreset).note} Regrouping keeps every word and its timing.</span>
      </label>
      <div class="row wrap">
        <button class="btn small" onClick={() => apply(fixVocabulary, 'Word fixes applied (e.g. BKDziti).')}>
          Apply word fixes
        </button>
        <button class="btn small" onClick={() => apply(removeFillers, 'Removed filler words.')}>
          Remove “um / uh”
        </button>
        <button class="btn small" onClick={() => apply((c) => changeCase(c, 'sentence'), 'Sentence case applied.')}>
          Sentence case
        </button>
        <button class="btn small" onClick={() => apply((c) => changeCase(c, 'upper'), 'Uppercase applied.')}>
          UPPERCASE
        </button>
        <button class="btn small" onClick={() => apply((c) => changeCase(c, 'lower'), 'Lowercase applied.')}>
          lowercase
        </button>
      </div>
    </div>
  );
}
