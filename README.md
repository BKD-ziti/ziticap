# ZitiCap

**Captions that sound like you.** A transcription and caption studio by BKDziti that runs entirely in the browser — on a phone or a laptop — and deploys to GitHub Pages with no server.

Upload a video → get every word transcribed with its own timestamp → fix text and timing on a real timeline → style it → export a video that is identical to the original except for the captions.

## What it does

| | |
|---|---|
| **Transcribe** | Whisper, word-level timestamps. Runs **on-device** (free, private, GPU-accelerated via WebGPU, CPU fallback) or with **your own Groq or OpenAI key** for Large-v3-Turbo accuracy at cloud speed. Only audio is uploaded in cloud mode, never the video. |
| **Edit** | Caption list with editable text and in/out times (↑/↓ nudges 0.1 s, ⇧ 1 s, ⌥ 10 ms). Split at cursor or playhead, merge, add, delete, undo/redo. Per-word timing chips. Find & replace, filler-word removal, case tools, global sync shift, regroup to a new pacing. Reading-speed (CPS) warnings. |
| **Timeline** | Waveform, drag captions to move them, drag edges to retime, zoom in to drag individual word boundaries. Snaps to the playhead and neighbours. Pinch-zoom on touch, Ctrl/⌘ + wheel on desktop. |
| **Style** | Six presets (Ziti Pop, Sauce Box, Karaoke, Headline, Broadcast, Clean) plus full control: font, weight, size, case, colour, outline, shadow, background box, word highlight (colour / box / karaoke fill / reveal), position (drag it on the video), width, alignment, animation. |
| **Export** | Burned-in MP4/WebM at the **source's exact resolution, aspect ratio, frame rate and frame timestamps**. Audio packets are copied bit-for-bit. Also SRT, WebVTT, word-timed VTT, styled ASS, plain transcript, and a project file. |

## How export keeps everything else identical

Built on WebCodecs (via [Mediabunny](https://mediabunny.dev)), with no ffmpeg.wasm involved:

1. Demux the source and decode each frame with the hardware decoder.
2. Draw the frame at its **display** resolution (rotation metadata is baked in, so iPhone portrait clips stay upright) and render captions with the *same* renderer the preview uses, laid out in video-pixel units, so the preview is the export.
3. Convert to **BT.709 limited-range 4:2:0 on the GPU** and tag it as such. That's what cameras and NLEs deliver, so Instagram/TikTok/YouTube re-encodes look right. (Encoding a canvas directly tags output as full-range sRGB, which is non-standard.)
4. Re-encode with the source codec when the device supports it (otherwise H.264), at a bitrate matched to the source and adjusted for codec efficiency.
5. Copy every audio packet untouched, keep metadata tags, and write a fast-start MP4 (index first) to on-disk browser storage (OPFS), so long 4K files don't exhaust phone memory.

Verified on test files: 1080p30, 1080×1920 at 29.97 fps, rotated portrait, and VP9/Opus WebM. Output resolution, frame count, frame rate and duration all match, the audio stream is byte-identical, colour tags match, and luma PSNR is about 49 dB outside the caption area.

Caption pacing follows broadcast/streaming guidance for the "Subtitle standard" preset: at most 42 characters × 2 lines, 5/6 s to 7 s on screen, balanced line breaks, no dangling articles or prepositions, and flicker-free gap closing.

## Use it on your phone

1. Open the GitHub Pages URL in Safari (iOS 17+) or Chrome (Android).
2. Share → **Add to Home Screen**. It launches full-screen like an app and works offline once loaded.
3. After exporting, tap **Save / Share → Save Video** to put it straight into Photos.

Projects autosave in the browser (IndexedDB). The first on-device transcription downloads the model once (Base ≈ 80 MB); after that it's cached.

## Deploy to GitHub Pages

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge to `main`. The workflow in `.github/workflows/deploy.yml` builds and publishes.
3. Your app is at `https://<user>.github.io/ziticap/`. All paths are relative, so it also works on a custom domain.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

Stack: Vite, Preact, TypeScript, Mediabunny (WebCodecs mux/demux/encode), Transformers.js (Whisper ONNX, WebGPU/WASM), self-hosted Fontsource fonts. No backend.

### Layout

```
src/lib/render.ts      caption renderer (shared by preview + export)
src/lib/exporter.ts    WebCodecs burn-in pipeline
src/lib/yuv.ts         GPU RGB → BT.709 I420 converter
src/lib/transcribe.ts  on-device + cloud transcription, silence-aware chunking
src/lib/whisper.worker.ts  Whisper in a Web Worker
src/lib/audio.ts       streaming 16 kHz decode, waveform peaks, WAV encode
src/lib/segment.ts     words → captions (pacing rules)
src/lib/edit.ts        split/merge/retime/retext (keeps word timing through edits)
src/lib/formats.ts     SRT / VTT / ASS / TXT export, SRT/VTT import
src/ui/*               editor UI
```

## Browser support

Chrome/Edge 94+, Safari 17+ (iOS 17+), Firefox 130+. On-device transcription is fastest with WebGPU (Chrome, Edge, Safari 26). HDR sources export as SDR.

---

ZitiCap is made by **BKDziti**: rethinking food, media and interaction, online and in person.
