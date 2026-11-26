import { render } from 'preact';
import '@fontsource/inter/400.css';
import './lib/fonts';
import './styles.css';
import { App } from './app';
import { loadSettings, saveSettings } from './lib/db';
import { takeCrashedInflight } from './lib/device';
import { LOCAL_MODELS } from './lib/transcribe';
import { toastStore } from './lib/session';
import { preferSafeAudio } from './lib/audio';

// Load custom vocabulary (e.g. BKDziti) before anything renders captions.
const settings = loadSettings();

// Did the browser kill the page last time (out of memory) while a model or export was running?
// Step down to something lighter so the same crash doesn't happen again, and say why.
let notice = '';
const crashed = takeCrashedInflight();
if (crashed?.kind === 'audio') {
  preferSafeAudio(true);
  notice = 'Your device ran out of memory while reading this video’s audio. ZitiCap will now use its low-memory method — open the project and try again.';
} else if (crashed?.kind === 'asr' && crashed.stage === 'transcribe') {
  notice = 'Your device ran out of memory while transcribing. Close other apps and try again, or use Groq in Settings (it needs almost no phone memory).';
} else if (crashed?.kind === 'asr') {
  const ids = LOCAL_MODELS.map((m) => m.id);
  const i = ids.indexOf(String(crashed.model));
  if (i > 0) {
    const from = LOCAL_MODELS[i].name;
    const to = LOCAL_MODELS[i - 1];
    saveSettings({ ...settings, localModel: to.id });
    notice = `Your device ran out of memory loading the ${from} model, so ZitiCap switched to ${to.name}. For the most accurate captions on a phone, use Groq in Settings.`;
  } else notice = 'Your device ran out of memory during transcription. Close other apps and try again, or use Groq in Settings.';
} else if (crashed?.kind === 'export') {
  notice =
    crashed.resolution && crashed.resolution !== 'original'
      ? `The ${String(crashed.resolution).toUpperCase()} export ran out of memory on this device. Try “Original” resolution.`
      : 'The export ran out of memory on this device. Close other apps and try again.';
}

render(<App />, document.getElementById('app')!);
if (notice) setTimeout(() => toastStore.show(notice, true), 300);

// Offline support + installable app. Only in production builds.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
