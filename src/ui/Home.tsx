import { useEffect, useRef, useState } from 'preact/hooks';
import { deleteProject, listProjects } from '../lib/db';
import { formatTime } from '../lib/media';
import { createProject, openProject, toastStore } from '../lib/session';
import type { Project } from '../lib/types';
import { Wordmark } from './Logo';
import { IFile, ISettings, ITrash, IUpload } from './icons';

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

export function Home({ onOpen, openSettings }: { onOpen: (needFile: boolean) => void; openSettings: () => void }) {
  const [recent, setRecent] = useState<Project[]>([]);
  const [over, setOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => void listProjects().then(setRecent).catch(() => setRecent([]));
  useEffect(refresh, []);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) {
      toastStore.show('That doesn’t look like a video file.', true);
      return;
    }
    setLoading(true);
    try {
      await createProject(f);
      onOpen(false);
    } catch (e) {
      console.error(e);
      toastStore.show((e as Error).message || 'Couldn’t open that video.', true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main class="home">
      <div class="home-top">
        <Wordmark />
        <button class="icon-btn" aria-label="Transcription settings" onClick={openSettings}>
          <ISettings />
        </button>
      </div>

      <section class="hero">
        <h1>
          Captions that sound like <em>you</em>.
        </h1>
        <p>Drop in a video. Get every word transcribed and timed. Fix anything, style it, and export at the exact same size and quality — straight from your phone.</p>
      </section>

      <label
        class={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void pick(e.dataTransfer?.files?.[0]);
        }}
      >
        <span class="drop-icon">
          <IUpload size={26} />
        </span>
        <strong>{loading ? 'Opening…' : 'Choose a video'}</strong>
        <span class="muted small">MP4, MOV or WebM · any size or orientation</span>
        {isIOS && (
          <span class="tiny faint" style={{ maxWidth: 360, lineHeight: 1.45 }}>
            iPhone tip: in the photo picker, tap <b>Options</b> → <b>Current</b> so iOS hands over your original video instead of a compressed copy.
          </span>
        )}
        <input
          ref={input}
          type="file"
          accept="video/*,.mov,.mp4,.m4v,.webm,.mkv"
          class="sr-only"
          onChange={(e) => {
            const el = e.target as HTMLInputElement;
            void pick(el.files?.[0]);
            el.value = '';
          }}
        />
      </label>

      <div class="facts">
        <div class="fact">
          <b>Private by default</b>
          <span>Transcription can run entirely on your device. Nothing is uploaded unless you choose a cloud engine.</span>
        </div>
        <div class="fact">
          <b>Word-perfect timing</b>
          <span>Every word is timed, so highlights land on the beat. Drag, split, merge and retime on a real timeline.</span>
        </div>
        <div class="fact">
          <b>Nothing else changes</b>
          <span>Same resolution, aspect ratio, frame timing and color space (HDR included). Audio is carried over untouched.</span>
        </div>
      </div>

      {recent.length > 0 && (
        <section class="recent">
          <h2>Recent</h2>
          <div class="recent-list">
            {recent.map((p) => (
              <div class="row" key={p.id}>
                <button
                  class="recent-item grow"
                  onClick={async () => {
                    try {
                      const r = await openProject(p.id);
                      onOpen(r === 'need-file');
                    } catch (e) {
                      toastStore.show((e as Error).message, true);
                    }
                  }}
                >
                  <span class="thumb">
                    <IFile />
                  </span>
                  <span class="grow" style={{ minWidth: 0 }}>
                    <b style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</b>
                    <span class="small muted">
                      {p.media ? `${p.media.width}×${p.media.height} · ${formatTime(p.media.duration, false)} · ` : ''}
                      {p.cues.length} captions · {new Date(p.updatedAt).toLocaleDateString()}
                    </span>
                  </span>
                </button>
                <button
                  class="icon-btn danger"
                  aria-label={`Delete ${p.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete “${p.name}”? This can’t be undone.`)) return;
                    await deleteProject(p.id);
                    refresh();
                  }}
                >
                  <ITrash size={18} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer class="foot">
        ZitiCap is made by BKDziti — rethinking food, media and interaction, online and in person.
        <br />
        Projects are saved in this browser only. Add to your Home Screen for an app-like experience.
      </footer>
    </main>
  );
}
