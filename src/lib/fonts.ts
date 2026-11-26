// Self-hosted caption fonts. Each weight CSS ships every unicode subset with
// unicode-range, so the browser only downloads the glyph ranges it needs.
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/montserrat/900.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/800.css';
import '@fontsource/anton/400.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/oswald/500.css';
import '@fontsource/oswald/600.css';
import '@fontsource/oswald/700.css';
import '@fontsource/archivo-black/400.css';

import type { CaptionStyle, Cue } from './types';

/**
 * Canvas text silently falls back to a system font if the webfont isn't loaded yet,
 * so we explicitly load the exact face (and the glyphs the captions use) before drawing.
 */
export async function ensureFont(style: CaptionStyle, cues: Cue[] = []): Promise<void> {
  if (!('fonts' in document)) return;
  const sample = Array.from(new Set(cues.flatMap((c) => c.words.map((w) => w.text)).join('').split('')))
    .slice(0, 400)
    .join('');
  const spec = `${style.italic ? 'italic ' : ''}${style.fontWeight} 32px "${style.fontFamily}"`;
  try {
    await Promise.all([
      document.fonts.load(spec, sample || 'Aa'),
      document.fonts.load(spec, sample.toUpperCase() || 'AA'),
    ]);
  } catch {
    /* fall back silently */
  }
}
