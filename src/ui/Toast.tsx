import { useEffect } from 'preact/hooks';
import { Store, useStore } from '../lib/store';
import { toastStore } from '../lib/session';

const toast = new Store<{ msg: string; err: boolean; id: number } | null>(null);
let n = 0;
toastStore.show = (msg: string, err = false) => toast.set({ msg, err, id: ++n });

export function Toast() {
  const t = useStore(toast);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => toast.set(null), t.err ? 6000 : 3200);
    return () => clearTimeout(id);
  }, [t?.id]);
  if (!t) return null;
  return (
    <div class={`toast${t.err ? ' err' : ''}`} role="status" aria-live="polite" onClick={() => toast.set(null)}>
      {t.msg}
    </div>
  );
}
