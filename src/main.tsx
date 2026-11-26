import { render } from 'preact';
import '@fontsource/inter/400.css';
import './lib/fonts';
import './styles.css';
import { App } from './app';

render(<App />, document.getElementById('app')!);

// Offline support + installable app. Only in production builds.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
