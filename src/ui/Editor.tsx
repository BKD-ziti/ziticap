import { useEffect, useRef, useState } from 'preact/hooks';
import { mergeCues, retimeCue, splitCueAtTime } from '../lib/edit';
import { closeProject, relinkFile, toastStore } from '../lib/session';
import { editor, playhead, redo, seek, setCues, togglePlay, undo, updateProject, useStore } from '../lib/store';
import { visibleCue } from '../lib/render';
import { CaptionsPanel } from './CaptionsPanel';
import { ExportPanel } from './ExportPanel';
import { Preview } from './Preview';
import { StylePanel } from './StylePanel';
import { Timeline } from './Timeline';
import { Transport } from './Transport';
import { IBack, IExport, IPalette, IRedo, ISettings, IText, IUndo, IUpload } from './icons';
import { Mark } from './Logo';

type Tab = 'captions' | 'style' | 'export';

export function Editor({ onBack, openSettings, needFile }: { onBack: () => void; openSettings: () => void; needFile: boolean }) {
  const project = useStore(editor, (s) => s.project);
  const hasFile = useStore(editor, (s) => !!s.file);
  const canUndo = useStore(editor, (s) => s.past.length > 0);
  const canRedo = useStore(editor, (s) => s.future.length > 0);
  const [tab, setTab] = useState<Tab>('captions');
  const relink = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'range', 'color'].includes((el as HTMLInputElement).type)) || el.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        if (typing && el.tagName === 'TEXTAREA') return; // let the textarea undo its own typing first
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (typing) {
        if (e.key === 'Escape') el.blur();
        // Alt+Space toggles playback even while typing — handy for transcription review.
        if (e.altKey && e.code === 'Space') {
          e.preventDefault();
          togglePlay();
        }
        return;
      }
      const t = playhead.get();
      const p = editor.get().project;
      if (!p) return;
      const cur = visibleCue(p.cues, t) ?? p.cues.find((c) => c.id === editor.get().selectedId);
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seek(t - (e.shiftKey ? 5 : 1));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seek(t + (e.shiftKey ? 5 : 1));
          break;
        case 'j':
          seek(t - 2);
          break;
        case 'l':
          seek(t + 2);
          break;
        case ',':
          seek(t - 1 / (p.media?.fps || 30));
          break;
        case '.':
          seek(t + 1 / (p.media?.fps || 30));
          break;
        case '[': // set start of current caption to playhead
          if (cur && t < cur.end - 0.05) setCues(p.cues.map((c) => (c.id === cur.id ? retimeCue(c, t, c.end) : c)));
          break;
        case ']':
          if (cur && t > cur.start + 0.05) setCues(p.cues.map((c) => (c.id === cur.id ? retimeCue(c, c.start, t) : c)));
          break;
        case 's':
          if (cur) {
            const parts = splitCueAtTime(cur, t);
            if (parts) setCues(p.cues.flatMap((c) => (c.id === cur.id ? parts : [c])));
          }
          break;
        case 'm':
          if (cur) {
            const i = p.cues.indexOf(cur);
            const next = p.cues[i + 1];
            if (next) setCues(p.cues.filter((c) => c.id !== next.id).map((c) => (c.id === cur.id ? mergeCues(cur, next) : c)));
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Warn before leaving mid-export/transcription.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (editor.get().busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  if (!project) return null;

  return (
    <div class="editor">
      <header class="topbar">
        <button
          class="icon-btn"
          aria-label="Back to projects"
          onClick={() => {
            if (editor.get().busy && !confirm('Work is in progress. Leave anyway?')) return;
            closeProject();
            onBack();
          }}
        >
          <IBack />
        </button>
        <Mark size={26} />
        <input class="title" value={project.name} aria-label="Project name" onChange={(e) => updateProject((p) => ({ ...p, name: (e.target as HTMLInputElement).value || p.name }))} />
        <button class="icon-btn" aria-label="Undo" title="Undo (Ctrl/⌘ Z)" disabled={!canUndo} onClick={undo}>
          <IUndo size={19} />
        </button>
        <button class="icon-btn" aria-label="Redo" title="Redo (Ctrl/⌘ ⇧ Z)" disabled={!canRedo} onClick={redo}>
          <IRedo size={19} />
        </button>
        <button class="icon-btn" aria-label="Transcription settings" onClick={openSettings}>
          <ISettings size={19} />
        </button>
      </header>

      {(needFile || !hasFile) && !hasFile && (
        <div class="row" style={{ padding: '8px 12px', background: '#2a1f1a', borderBottom: '1px solid var(--line-soft)' }}>
          <span class="small grow">This project’s video wasn’t saved on this device. Re-select it to keep editing.</span>
          <button class="btn small primary" onClick={() => relink.current?.click()}>
            <IUpload size={16} /> Select video
          </button>
          <input
            ref={relink}
            type="file"
            accept="video/*,.mov,.mp4,.m4v,.webm,.mkv"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) relinkFile(f).catch((err) => toastStore.show((err as Error).message, true));
            }}
          />
        </div>
      )}

      <div class="workspace">
        <section class="stage">
          <Preview />
          <Transport />
          <Timeline />
        </section>
        <section class="panel">
          <div class="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'captions'} onClick={() => setTab('captions')}>
              <IText size={17} /> Captions
            </button>
            <button role="tab" aria-selected={tab === 'style'} onClick={() => setTab('style')}>
              <IPalette size={17} /> Style
            </button>
            <button role="tab" aria-selected={tab === 'export'} onClick={() => setTab('export')}>
              <IExport size={17} /> Export
            </button>
          </div>
          <div class="panel-body" role="tabpanel" key={tab}>
            {tab === 'captions' && <CaptionsPanel openSettings={openSettings} />}
            {tab === 'style' && <StylePanel />}
            {tab === 'export' && <ExportPanel />}
          </div>
        </section>
      </div>
    </div>
  );
}
