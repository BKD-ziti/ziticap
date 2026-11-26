import { useState } from 'preact/hooks';
import { formatTime } from '../lib/media';
import { editor, getVideo, playhead, playing, seek, togglePlay, useStore } from '../lib/store';
import { IPause, IPlay, IStepBack, IStepFwd } from './icons';

const RATES = [1, 0.75, 0.5, 1.5, 2];

export function Transport() {
  const t = useStore(playhead);
  const isPlaying = useStore(playing);
  const duration = useStore(editor, (s) => s.project?.media?.duration ?? 0);
  const fps = useStore(editor, (s) => s.project?.media?.fps ?? 30);
  const [rate, setRate] = useState(1);
  const frame = 1 / (fps || 30);

  const cycleRate = () => {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    setRate(next);
    const v = getVideo();
    if (v) v.playbackRate = next;
  };

  return (
    <div class="transport">
      <button class="icon-btn" aria-label="Back one second" title="Back 1s (←)" onClick={() => seek(t - 1)}>
        <IStepBack size={18} />
      </button>
      <button class="play-btn" aria-label={isPlaying ? 'Pause' : 'Play'} title="Play / pause (Space)" onClick={togglePlay}>
        {isPlaying ? <IPause size={20} /> : <IPlay size={20} />}
      </button>
      <button class="icon-btn" aria-label="Forward one second" title="Forward 1s (→)" onClick={() => seek(t + 1)}>
        <IStepFwd size={18} />
      </button>
      <span class="time mono">
        <b>{formatTime(t)}</b> / {formatTime(duration, false)}
      </span>
      <span class="grow" />
      <button class="btn small ghost mono" title="Previous frame (,)" onClick={() => seek(t - frame)} aria-label="Previous frame">
        −1f
      </button>
      <button class="btn small ghost mono" title="Next frame (.)" onClick={() => seek(t + frame)} aria-label="Next frame">
        +1f
      </button>
      <button class="btn small mono" onClick={cycleRate} title="Playback speed" aria-label={`Playback speed ${rate}×`}>
        {rate}×
      </button>
    </div>
  );
}
