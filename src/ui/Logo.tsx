/**
 * ZitiCap mark: two ziti tubes stacked like caption lines on a tomato tile.
 * Pasta you can read — the studio's food-meets-media idea in one glyph.
 */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#E5482F" />
      <g>
        <rect x="11" y="20" width="42" height="11" rx="5.5" fill="#F6EBD6" />
        <ellipse cx="47.5" cy="25.5" rx="3" ry="4.2" fill="#C9361F" />
        <path d="M19 20.5v10M25 20.5v10M31 20.5v10M37 20.5v10" stroke="#E7D6B8" stroke-width="1.6" />
        <rect x="18" y="36" width="28" height="11" rx="5.5" fill="#F6EBD6" />
        <ellipse cx="40.5" cy="41.5" rx="3" ry="4.2" fill="#C9361F" />
        <path d="M26 36.5v10M32 36.5v10" stroke="#E7D6B8" stroke-width="1.6" />
      </g>
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span class="wordmark">
      <Mark size={compact ? 28 : 34} />
      <span class="wordmark-text">
        <span class="wordmark-name">
          Ziti<b>Cap</b>
        </span>
        {!compact && <span class="wordmark-by">by BKDziti</span>}
      </span>
    </span>
  );
}
