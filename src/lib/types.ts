/** A single spoken word with its own timing (seconds, media timeline). */
export interface Word {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Force a line break after this word when rendering / exporting. */
  br?: boolean;
}

/** One caption on screen. Its text is always derived from its words. */
export interface Cue {
  id: string;
  start: number;
  end: number;
  words: Word[];
}

export interface MediaInfo {
  name: string;
  size: number;
  mime: string;
  duration: number;
  /** Display size (after rotation / pixel aspect ratio) — what the viewer sees. */
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  rotation: number;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  videoBitrate: number | null;
  hasAudio: boolean;
  container: string;
  hdr: boolean;
}

export type Align = 'left' | 'center' | 'right';
export type Animation = 'none' | 'pop' | 'fade' | 'rise';
export type HighlightMode = 'none' | 'color' | 'box' | 'karaoke' | 'reveal';

export interface CaptionStyle {
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  /** Font size as a fraction of min(width, height) of the video. */
  fontSize: number;
  uppercase: boolean;
  textColor: string;
  /** Outline (stroke) around each glyph. Width as a fraction of font size. */
  strokeColor: string;
  strokeWidth: number;
  /** Drop shadow. Blur/offset as fraction of font size. */
  shadowColor: string;
  shadowBlur: number;
  shadowOffset: number;
  /** Background box behind lines. */
  boxEnabled: boolean;
  boxColor: string;
  boxOpacity: number;
  boxPadding: number; // fraction of font size
  boxRadius: number; // fraction of font size
  boxPerLine: boolean;
  /** Active-word treatment. */
  highlight: HighlightMode;
  highlightColor: string;
  highlightTextColor: string;
  /** Vertical position of the caption block's centre, 0 = top, 1 = bottom. */
  positionY: number;
  /** Max text width as a fraction of video width. */
  maxWidth: number;
  align: Align;
  lineHeight: number;
  letterSpacing: number; // fraction of font size
  animation: Animation;
}

export interface SegmentOptions {
  /** Max characters per line. */
  maxChars: number;
  maxLines: number;
  /** Optional hard cap on words per caption (0 = no cap). */
  maxWords: number;
  /** Max seconds a single caption stays up. */
  maxDuration: number;
  /** Minimum seconds a caption stays up (extended into gaps when possible). */
  minDuration: number;
  /** A pause at least this long always starts a new caption. */
  pauseSplit: number;
  /** Gaps shorter than this are closed so captions don't flicker. */
  closeGaps: number;
}

export interface TranscribeSettings {
  engine: 'local' | 'groq' | 'openai';
  localModel: string;
  language: string; // 'auto' or ISO code
  prompt: string; // vocabulary / spelling hints
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  media: MediaInfo | null;
  cues: Cue[];
  style: CaptionStyle;
  segment: SegmentOptions;
  stylePreset: string;
  segmentPreset: string;
  language: string;
}

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}
