/// <reference lib="webworker" />
// Disk-backed export writer for browsers without FileSystemWritableFileStream (Safari/iOS before 26).
// createSyncAccessHandle() is available in dedicated workers since Safari 15.2, Chrome 102, Firefox 111.

type Msg = { type: 'open'; name: string } | { type: 'write'; data: Uint8Array; position: number } | { type: 'close' };

let handle: { write(b: Uint8Array, o: { at: number }): number; flush(): void; close(): void } | null = null;

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  try {
    if (m.type === 'open') {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(m.name, { create: true });
      handle = await (fh as unknown as { createSyncAccessHandle(): Promise<typeof handle> }).createSyncAccessHandle();
    } else if (m.type === 'write') {
      let off = 0;
      while (off < m.data.byteLength) off += handle!.write(m.data.subarray(off), { at: m.position + off });
    } else if (m.type === 'close') {
      handle?.flush();
      handle?.close();
      handle = null;
    }
    (self as unknown as Worker).postMessage({ ok: true });
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, error: (e as Error)?.message ?? String(e) });
  }
};
