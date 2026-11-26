import type { CaptionStyle, SegmentOptions } from './types';

export interface FontOption {
  family: string;
  label: string;
  weights: number[];
}

/** Every font is self-hosted (bundled), so captions render identically offline and in export. */
export const FONTS: FontOption[] = [
  { family: 'Montserrat', label: 'Montserrat', weights: [500, 700, 800, 900] },
  { family: 'Inter', label: 'Inter', weights: [500, 600, 700, 800] },
  { family: 'Poppins', label: 'Poppins', weights: [500, 600, 700, 800] },
  { family: 'Anton', label: 'Anton', weights: [400] },
  { family: 'Bebas Neue', label: 'Bebas Neue', weights: [400] },
  { family: 'Oswald', label: 'Oswald', weights: [500, 600, 700] },
  { family: 'Archivo Black', label: 'Archivo Black', weights: [400] },
];

const base: CaptionStyle = {
  fontFamily: 'Montserrat',
  fontWeight: 800,
  italic: false,
  fontSize: 0.062,
  uppercase: false,
  textColor: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidth: 0,
  shadowColor: 'rgba(0,0,0,0.65)',
  shadowBlur: 0.18,
  shadowOffset: 0.04,
  boxEnabled: false,
  boxColor: '#000000',
  boxOpacity: 0.7,
  boxPadding: 0.28,
  boxRadius: 0.22,
  boxPerLine: true,
  highlight: 'none',
  highlightColor: '#FFD23F',
  highlightTextColor: '#111111',
  positionY: 0.72,
  maxWidth: 0.86,
  align: 'center',
  lineHeight: 1.18,
  letterSpacing: 0,
  animation: 'none',
};

export interface StylePreset {
  id: string;
  name: string;
  note: string;
  style: CaptionStyle;
  segment: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'ziti',
    name: 'Ziti Pop',
    note: 'Bold, word-by-word highlight. Built for Reels, TikTok, Shorts.',
    segment: 'punchy',
    style: {
      ...base,
      fontWeight: 900,
      uppercase: true,
      fontSize: 0.075,
      strokeWidth: 0.16,
      strokeColor: '#000000',
      shadowBlur: 0.1,
      shadowOffset: 0.05,
      highlight: 'color',
      highlightColor: '#FFD23F',
      animation: 'pop',
      positionY: 0.68,
    },
  },
  {
    id: 'sauce',
    name: 'Sauce Box',
    note: 'Active word sits in a tomato-red pill.',
    segment: 'punchy',
    style: {
      ...base,
      fontFamily: 'Poppins',
      fontWeight: 800,
      fontSize: 0.068,
      strokeWidth: 0.1,
      highlight: 'box',
      highlightColor: '#E5482F',
      highlightTextColor: '#FFFFFF',
      animation: 'pop',
      positionY: 0.7,
    },
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    note: 'Words fill in as they are spoken.',
    segment: 'social',
    style: {
      ...base,
      fontFamily: 'Inter',
      fontWeight: 800,
      fontSize: 0.064,
      textColor: 'rgba(255,255,255,0.55)',
      strokeWidth: 0.1,
      highlight: 'karaoke',
      highlightColor: '#FFFFFF',
      animation: 'fade',
    },
  },
  {
    id: 'headline',
    name: 'Headline',
    note: 'Tall condensed type, words appear as they land.',
    segment: 'punchy',
    style: {
      ...base,
      fontFamily: 'Anton',
      fontWeight: 400,
      uppercase: true,
      fontSize: 0.09,
      letterSpacing: 0.02,
      strokeWidth: 0.12,
      highlight: 'reveal',
      highlightColor: '#FFFFFF',
      animation: 'rise',
      positionY: 0.62,
    },
  },
  {
    id: 'broadcast',
    name: 'Broadcast',
    note: 'Classic subtitle box. Reads well on anything.',
    segment: 'subtitle',
    style: {
      ...base,
      fontFamily: 'Inter',
      fontWeight: 600,
      fontSize: 0.05,
      shadowBlur: 0,
      shadowOffset: 0,
      boxEnabled: true,
      boxOpacity: 0.72,
      boxRadius: 0.12,
      boxPadding: 0.24,
      positionY: 0.86,
      maxWidth: 0.9,
    },
  },
  {
    id: 'clean',
    name: 'Clean',
    note: 'White, soft shadow, sentence case. Quiet and timeless.',
    segment: 'subtitle',
    style: {
      ...base,
      fontFamily: 'Inter',
      fontWeight: 700,
      fontSize: 0.052,
      shadowBlur: 0.25,
      shadowOffset: 0.03,
      positionY: 0.85,
    },
  },
];

export interface SegmentPreset {
  id: string;
  name: string;
  note: string;
  options: SegmentOptions;
}

export const SEGMENT_PRESETS: SegmentPreset[] = [
  {
    id: 'punchy',
    name: 'Punchy (1–3 words)',
    note: 'Fast social pacing.',
    options: { maxChars: 16, maxLines: 1, maxWords: 3, maxDuration: 2.5, minDuration: 0.3, pauseSplit: 0.45, closeGaps: 0.35 },
  },
  {
    id: 'social',
    name: 'Social (short lines)',
    note: 'One or two short lines.',
    options: { maxChars: 24, maxLines: 2, maxWords: 8, maxDuration: 4, minDuration: 0.6, pauseSplit: 0.6, closeGaps: 0.4 },
  },
  {
    id: 'subtitle',
    name: 'Subtitle standard',
    note: '42 chars × 2 lines, 5/6s–7s. Broadcast & streaming guidance.',
    options: { maxChars: 42, maxLines: 2, maxWords: 0, maxDuration: 7, minDuration: 0.833, pauseSplit: 1.0, closeGaps: 0.5 },
  },
];

export const DEFAULT_STYLE_PRESET = 'ziti';

export function stylePreset(id: string): StylePreset {
  return STYLE_PRESETS.find((p) => p.id === id) ?? STYLE_PRESETS[0];
}
export function segmentPreset(id: string): SegmentPreset {
  return SEGMENT_PRESETS.find((p) => p.id === id) ?? SEGMENT_PRESETS[0];
}
