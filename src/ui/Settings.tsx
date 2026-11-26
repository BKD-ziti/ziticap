import { useState } from 'preact/hooks';
import { loadSettings, saveSettings, type Settings as S } from '../lib/db';
import { LANGUAGES, LOCAL_MODELS } from '../lib/transcribe';
import { IClose, ILock } from './icons';

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<S>(loadSettings());
  const set = (patch: Partial<S>) => setS((p) => ({ ...p, ...patch }));
  const save = () => {
    saveSettings({ ...s, groqKey: s.groqKey.trim(), openaiKey: s.openaiKey.trim() });
    onClose();
  };

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet stack" role="dialog" aria-modal="true" aria-label="Transcription settings">
        <div class="row">
          <h2 class="grow">Transcription</h2>
          <button class="icon-btn" aria-label="Close" onClick={onClose}>
            <IClose />
          </button>
        </div>

        <div class="stack tight">
          <button class="choice" aria-pressed={s.engine === 'local'} onClick={() => set({ engine: 'local' })}>
            <i class="dot" />
            <div>
              <b>On this device — free & private</b>
              <span>Whisper runs right in your browser. Your video never leaves your phone or computer. Uses the GPU when available.</span>
            </div>
          </button>
          <button class="choice" aria-pressed={s.engine === 'groq'} onClick={() => set({ engine: 'groq' })}>
            <i class="dot" />
            <div>
              <b>Groq — fastest, most accurate</b>
              <span>Whisper Large v3 Turbo in the cloud. An hour of audio in well under a minute, for a few cents (free tier available). Uses your own key.</span>
            </div>
          </button>
          <button class="choice" aria-pressed={s.engine === 'openai'} onClick={() => set({ engine: 'openai' })}>
            <i class="dot" />
            <div>
              <b>OpenAI</b>
              <span>Whisper with word timestamps. Uses your own key.</span>
            </div>
          </button>
        </div>

        {s.engine === 'local' && (
          <div class="stack tight">
            <label class="field">
              <span>Model</span>
              <select class="input" value={s.localModel} onChange={(e) => set({ localModel: (e.target as HTMLSelectElement).value })}>
                {LOCAL_MODELS.map((m) => (
                  <option value={m.id}>
                    {m.name} · {m.size}
                  </option>
                ))}
              </select>
              <span class="tiny faint" style={{ fontWeight: 400 }}>
                {LOCAL_MODELS.find((m) => m.id === s.localModel)?.note} Downloaded once, then cached for offline use.
              </span>
            </label>
            <label class="field">
              <span>Processor</span>
              <div class="seg">
                {(['auto', 'webgpu', 'wasm'] as const).map((d) => (
                  <button aria-pressed={s.device === d} onClick={() => set({ device: d })}>
                    {d === 'auto' ? 'Auto' : d === 'webgpu' ? 'GPU' : 'CPU'}
                  </button>
                ))}
              </div>
            </label>
          </div>
        )}

        {s.engine === 'groq' && (
          <label class="field">
            <span>Groq API key</span>
            <input class="input mono" type="password" autoComplete="off" placeholder="gsk_…" value={s.groqKey} onInput={(e) => set({ groqKey: (e.target as HTMLInputElement).value })} />
            <span class="tiny faint" style={{ fontWeight: 400 }}>
              Get one at <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>.
            </span>
          </label>
        )}
        {s.engine === 'openai' && (
          <label class="field">
            <span>OpenAI API key</span>
            <input class="input mono" type="password" autoComplete="off" placeholder="sk-…" value={s.openaiKey} onInput={(e) => set({ openaiKey: (e.target as HTMLInputElement).value })} />
            <span class="tiny faint" style={{ fontWeight: 400 }}>
              Get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>.
            </span>
          </label>
        )}
        {s.engine !== 'local' && (
          <>
            <div class="row small muted">
              <ILock size={16} />
              <span>Your key is stored only on this device and sent only to the provider. Only the audio (not the video) is uploaded.</span>
            </div>
            <label class="field">
              <span>Spelling hints (optional)</span>
              <textarea class="input" rows={2} placeholder="Names, brands, jargon: BKDziti, ziti al forno, Alexander Zornes…" value={s.prompt} onInput={(e) => set({ prompt: (e.target as HTMLTextAreaElement).value })} />
            </label>
          </>
        )}

        <label class="field">
          <span>Default language</span>
          <select class="input" value={s.language} onChange={(e) => set({ language: (e.target as HTMLSelectElement).value })}>
            {LANGUAGES.map(([c, n]) => (
              <option value={c}>{n}</option>
            ))}
          </select>
        </label>

        <button class="btn primary big block" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
