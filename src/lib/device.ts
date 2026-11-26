// Device hints used to keep heavy work (speech models, 4K) within what a device can hold in memory.

export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

export function isPhoneOrTablet(): boolean {
  return isIOS() || /Android|Mobi/i.test(navigator.userAgent);
}

/** GB of RAM where the browser tells us (Chrome/Android); null on Safari/Firefox. */
export function deviceMemoryGB(): number | null {
  const m = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof m === 'number' ? m : null;
}

/**
 * Phones kill a browser tab that uses too much memory, and the browser then reloads the page.
 * We mark heavy work as "in flight" so that, if the page comes back without finishing it,
 * we know it crashed and can step down to something lighter.
 */
const KEY = 'ziticap:inflight';

export function markInflight(kind: string, detail: Record<string, unknown>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ kind, ...detail, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

let lastUpdate = 0;
/** Record progress on the in-flight step (throttled), so a crash report can say exactly where it died. */
export function updateInflight(patch: Record<string, unknown>) {
  const now = Date.now();
  if (now - lastUpdate < 1000) return;
  lastUpdate = now;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(raw), ...patch }));
  } catch {
    /* ignore */
  }
}

export function clearInflight() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Returns what was running when the page last died (within the last hour), and clears the marker. */
export function takeCrashedInflight(): ({ kind: string; at: number } & Record<string, unknown>) | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Date.now() - v.at >= 60 * 60 * 1000) return null;
    localStorage.setItem('ziticap:lastcrash', raw);
    return v;
  } catch {
    return null;
  }
}
