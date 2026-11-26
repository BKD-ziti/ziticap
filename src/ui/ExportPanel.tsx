import { useEffect, useRef, useState } from 'preact/hooks';
import { downloadText, exportVideo, saveFile, webCodecsSupported, type ExportQuality, type ExportResult } from '../lib/exporter';
import { toASS, toSRT, toTXT, toVTT } from '../lib/formats';
import { formatBytes, formatTime } from '../lib/media';
import { toastStore } from '../lib/session';
import { editor, getVideo, setBusy, useStore } from '../lib/store';
import { IDownload, IExport, IShare, ICheck } from './icons';
import { targetSize, type OutputResolution } from '../lib/scale';

const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

export function ExportPanel() {
  const project = useStore(editor, (s) => s.project);
  const file = useStore(editor, (s) => s.file);
  const busy = useStore(editor, (s) => s.busy);
  const [quality, setQuality] = useState<ExportQuality>('match');
  const [resolution, setResolution] = useState<OutputResolution>('original');
  const [progress, setProgress] = useState<{ p: number; eta: number | null } | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  if (!project) return null;
  const m = project.media;
  const base = project.name || 'captions';
  const fileOpts = { maxChars: project.segment.maxChars, maxLines: project.segment.maxLines, uppercase: project.style.uppercase };
  const hasCues = project.cues.length > 0;

  const run = async () => {
    if (!file || !m) return toastStore.show('Re-select the source video first.', true);
    getVideo()?.pause();
    abort.current = new AbortController();
    setResult(null);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setProgress({ p: 0, eta: null });
    setBusy({ kind: 'export', progress: 0, label: 'Exporting' });
    try {
      const res = await exportVideo(file, m, project.cues, project.style, {
        quality,
        resolution,
        signal: abort.current.signal,
        onProgress: (p, eta) => setProgress({ p, eta }),
      });
      setResult(res);
      setResultUrl(URL.createObjectURL(res.file));
      toastStore.show('Export ready.');
    } catch (e) {
      if ((e as Error).name === 'AbortError') toastStore.show('Export canceled.');
      else {
        console.error(e);
        toastStore.show((e as Error).message || 'Export failed', true);
      }
    } finally {
      setProgress(null);
      setBusy(null);
      abort.current = null;
    }
  };

  const fps = m?.fps ? `${Number.isInteger(m.fps) ? m.fps : m.fps.toFixed(2)} fps` : 'source fps';
  const aspect = m ? ratio(m.width, m.height) : '';

  return (
    <div class="stack">
      <div class="card stack tight">
        <span class="label">Source</span>
        {m ? (
          <dl class="spec">
            <dt>Resolution</dt>
            <dd>
              {m.width}×{m.height} ({aspect})
            </dd>
            <dt>Frame rate</dt>
            <dd>{fps}</dd>
            <dt>Video</dt>
            <dd>
              {(m.videoCodec ?? '?').toUpperCase()}
              {m.videoBitrate ? ` · ${(m.videoBitrate / 1e6).toFixed(1)} Mbps` : ''}
              {m.hdr ? ' · HDR' : ''}
            </dd>
            <dt>Audio</dt>
            <dd>{m.hasAudio ? (m.audioCodec ?? '?').toUpperCase() + ' · copied untouched' : 'none'}</dd>
            <dt>Length</dt>
            <dd>
              {formatTime(m.duration, false)} · {formatBytes(m.size)}
            </dd>
          </dl>
        ) : (
          <span class="muted small">No video loaded.</span>
        )}
      </div>

      <div class="stack tight">
        <span class="label">Video with captions</span>
        <p class="small muted" style={{ margin: 0, lineHeight: 1.5 }}>
          Captions are burned into the picture exactly as previewed, so they show up everywhere — Reels, TikTok, Shorts, LinkedIn, iMessage. Resolution, aspect ratio, frame rate, frame timing and color space match the original; audio is copied untouched.
        </p>
        {m && (
          <label class="field">
            <span>Resolution</span>
            <div class="seg">
              {(['original', '1080p', '4k'] as OutputResolution[]).map((r) => {
                const [w, h] = targetSize(m.width, m.height, r);
                const label = r === 'original' ? 'Original' : r === '4k' ? '4K' : '1080p';
                return (
                  <button aria-pressed={resolution === r} onClick={() => setResolution(r)} title={`${w}×${h}`}>
                    {label}
                  </button>
                );
              })}
            </div>
            <span class="tiny faint" style={{ fontWeight: 400 }}>
              {(() => {
                const [w, h] = targetSize(m.width, m.height, resolution);
                if (resolution === 'original') return `${w}×${h}, exactly as recorded.`;
                const up = w * h > m.width * m.height;
                const same = w === m.width && h === m.height;
                return same
                  ? `${w}×${h} — your video is already this size.`
                  : `${w}×${h} (${aspect}), ${up ? 'upscaled' : 'downscaled'} from ${m.width}×${m.height}. Aspect ratio and color space are kept; captions render natively sharp.`;
              })()}
            </span>
          </label>
        )}
        <label class="field">
            <span>Quality</span>
            <div class="seg">
              <button aria-pressed={quality === 'match'} onClick={() => setQuality('match')}>
                Match original
              </button>
              <button aria-pressed={quality === 'high'} onClick={() => setQuality('high')}>
                Higher
              </button>
              <button aria-pressed={quality === 'smaller'} onClick={() => setQuality('smaller')}>
                Smaller file
              </button>
            </div>
        </label>
        {!webCodecsSupported() && <span class="pill warn">This browser can’t encode video. Use current Chrome, Edge, Safari 17+ or Firefox.</span>}

        {progress ? (
          <div class="card stack tight">
            <div class="row">
              <span class="grow small">
                Rendering captions into every frame · {Math.round(progress.p * 100)}%
                {progress.eta != null && progress.eta > 1 ? ` · ~${fmtEta(progress.eta)} left` : ''}
              </span>
              <button class="btn small" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            </div>
            <div class={`progress${progress.p <= 0 ? ' indeterminate' : ''}`}>
              <i style={{ width: `${Math.round(progress.p * 100)}%` }} />
            </div>
            <span class="tiny faint">Keep this screen open — phones pause background tabs.</span>
          </div>
        ) : (
          <button class="btn primary big block" disabled={!file || !hasCues || !!busy} onClick={run}>
            <IExport size={20} /> Export video
          </button>
        )}
        {!hasCues && <span class="tiny faint">Add or transcribe captions first.</span>}
      </div>

      {result && resultUrl && (
        <div class="card stack">
          <div class="row">
            <ICheck size={18} style={{ color: 'var(--basil)' }} />
            <b class="grow">{result.file.name}</b>
          </div>
          <video class="result-video" src={resultUrl} controls playsInline />
          <dl class="spec">
            <dt>Output</dt>
            <dd>
              {result.width}×{result.height} · {result.codec.toUpperCase()}
              {result.bitrate ? ` · ~${(result.bitrate / 1e6).toFixed(1)} Mbps` : ''}
            </dd>
            <dt>Size</dt>
            <dd>{formatBytes(result.file.size)}</dd>
          </dl>
          {result.notes.map((n) => (
            <span class="tiny muted">• {n}</span>
          ))}
          <div class="row wrap">
            {isPhone() && 'canShare' in navigator && (
              <button class="btn primary grow" onClick={() => saveFile(result.file, true)}>
                <IShare size={18} /> Save / Share
              </button>
            )}
            <button class={`btn grow${isPhone() ? '' : ' primary'}`} onClick={() => saveFile(result.file, false)}>
              <IDownload size={18} /> Download
            </button>
          </div>
          {isPhone() && <span class="tiny faint">On iPhone, “Save / Share” → “Save Video” puts it straight in Photos.</span>}
        </div>
      )}

      <div class="stack tight">
        <span class="label">Caption files</span>
        <div class="row wrap">
          <button class="btn small" disabled={!hasCues} onClick={() => downloadText(toSRT(project.cues, fileOpts), `${base}.srt`, 'application/x-subrip')}>
            SRT
          </button>
          <button class="btn small" disabled={!hasCues} onClick={() => downloadText(toVTT(project.cues, fileOpts), `${base}.vtt`, 'text/vtt')}>
            WebVTT
          </button>
          <button class="btn small" disabled={!hasCues} onClick={() => downloadText(toVTT(project.cues, { ...fileOpts, words: true }), `${base}.words.vtt`, 'text/vtt')}>
            VTT word-timed
          </button>
          <button class="btn small" disabled={!hasCues || !m} onClick={() => m && downloadText(toASS(project.cues, project.style, m.width, m.height), `${base}.ass`, 'text/x-ssa')}>
            ASS (styled)
          </button>
          <button class="btn small" disabled={!hasCues} onClick={() => downloadText(toTXT(project.cues), `${base}.txt`)}>
            Transcript
          </button>
          <button
            class="btn small"
            onClick={() => downloadText(JSON.stringify({ app: 'ziticap', version: 1, project: { ...project } }, null, 2), `${base}.ziticap.json`, 'application/json')}
          >
            Project
          </button>
        </div>
        <span class="tiny faint">SRT/VTT for YouTube, Facebook, LinkedIn and editors (Premiere, Resolve, Final Cut). ASS keeps your font, colors and word highlighting.</span>
      </div>
    </div>
  );
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
function ratio(w: number, h: number): string {
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  const known: [number, string][] = [
    [16 / 9, '16:9'], [9 / 16, '9:16'], [4 / 3, '4:3'], [3 / 4, '3:4'], [1, '1:1'], [4 / 5, '4:5'], [21 / 9, '21:9'],
  ];
  const k = known.find(([r]) => Math.abs(r - w / h) < 0.01);
  return k ? k[1] : a < 100 ? `${a}:${b}` : (w / h).toFixed(2) + ':1';
}
function fmtEta(s: number) {
  if (s < 60) return `${Math.ceil(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
}
