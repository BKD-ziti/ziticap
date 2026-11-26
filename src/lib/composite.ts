/**
 * Caption compositing directly in the source's own YUV planes.
 *
 * The decoded frame is never converted to RGB. Captions are rendered to a transparent
 * overlay, converted once into the *source's* colour space (matrix, range, primaries,
 * transfer — including HLG/PQ HDR), and alpha-blended into the Y/U/V planes. Every pixel
 * outside the captions keeps its decoded value, and the frame keeps the input's colour tags.
 * Frames with no caption on screen are handed to the encoder untouched.
 */
import type { VideoSample } from 'mediabunny';

type Fmt = {
  planar: boolean; // I4xx planar vs NV12 semi-planar
  sx: number; // chroma subsampling
  sy: number;
  bits: number;
  alpha: boolean;
};

const FORMATS: Record<string, Fmt> = {
  I420: { planar: true, sx: 2, sy: 2, bits: 8, alpha: false },
  I420A: { planar: true, sx: 2, sy: 2, bits: 8, alpha: true },
  I422: { planar: true, sx: 2, sy: 1, bits: 8, alpha: false },
  I444: { planar: true, sx: 1, sy: 1, bits: 8, alpha: false },
  NV12: { planar: false, sx: 2, sy: 2, bits: 8, alpha: false },
  I420P10: { planar: true, sx: 2, sy: 2, bits: 10, alpha: false },
  I420P12: { planar: true, sx: 2, sy: 2, bits: 12, alpha: false },
  I422P10: { planar: true, sx: 2, sy: 1, bits: 10, alpha: false },
  I422P12: { planar: true, sx: 2, sy: 1, bits: 12, alpha: false },
  I444P10: { planar: true, sx: 1, sy: 1, bits: 10, alpha: false },
  I444P12: { planar: true, sx: 1, sy: 1, bits: 12, alpha: false },
};

export function compositeSupported(format: string | null): boolean {
  return !!format && format in FORMATS;
}

export interface ColorTags {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}

/** How caption RGB maps into the source's colour space. */
class ColorMath {
  private kr: number;
  private kb: number;
  private full: boolean;
  private bits: number;
  private to2020: boolean;
  private transfer: 'sdr' | 'hlg' | 'pq';
  // 6-bit-per-channel lookup table (262k entries), filled lazily: fast per-pixel conversion.
  private lut = new Float32Array(1 << 18).fill(-1);
  private lutU = new Float32Array(1 << 18);
  private lutV = new Float32Array(1 << 18);
  private cache = new Map<number, [number, number, number]>();

  constructor(cs: ColorTags, bits: number, height: number) {
    // Unspecified matrix: assume what browsers assume (BT.601 for SD, BT.709 for HD).
    const m = cs.matrix ?? (height < 720 ? 'smpte170m' : 'bt709');
    [this.kr, this.kb] = m === 'bt2020-ncl' ? [0.2627, 0.0593] : m === 'bt470bg' || m === 'smpte170m' ? [0.299, 0.114] : [0.2126, 0.0722];
    this.full = !!cs.fullRange;
    this.bits = bits;
    this.to2020 = cs.primaries === 'bt2020';
    this.transfer = cs.transfer === 'hlg' ? 'hlg' : cs.transfer === 'pq' ? 'pq' : 'sdr';
  }

  /** Fast path: quantised lookup. Writes into `out`, returns it. */
  fast(r: number, g: number, b: number, out: Float32Array): Float32Array {
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    if (this.lut[k] < 0) {
      const q = (v: number) => ((v >> 2) << 2) | (v >> 6);
      const [Y, U, V] = this.yuv(q(r), q(g), q(b));
      this.lut[k] = Y;
      this.lutU[k] = U;
      this.lutV[k] = V;
    }
    out[0] = this.lut[k];
    out[1] = this.lutU[k];
    out[2] = this.lutV[k];
    return out;
  }

  /** Caption colour (sRGB 0–255) → [Y, Cb, Cr] code values in the source's bit depth. */
  yuv(r: number, g: number, b: number): [number, number, number] {
    const key = (r << 16) | (g << 8) | b;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let R = r / 255;
    let G = g / 255;
    let B = b / 255;
    if (this.to2020 || this.transfer !== 'sdr') {
      const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      let [lr, lg, lb] = [lin(R), lin(G), lin(B)];
      if (this.to2020) {
        // BT.709 → BT.2020 primaries (ITU-R BT.2087)
        [lr, lg, lb] = [
          0.6274 * lr + 0.3293 * lg + 0.0433 * lb,
          0.0691 * lr + 0.9195 * lg + 0.0114 * lb,
          0.0164 * lr + 0.088 * lg + 0.8956 * lb,
        ];
      }
      let enc: (c: number) => number;
      if (this.transfer === 'hlg') {
        // BT.2408: SDR graphics white sits at 75% HLG signal.
        const a = 0.17883277, bb = 0.28466892, c = 0.55991073;
        enc = (v) => {
          const e = Math.max(0, v * 0.2647);
          return e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - bb) + c;
        };
      } else if (this.transfer === 'pq') {
        // BT.2408: graphics white at 203 cd/m².
        const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
        enc = (v) => {
          const y = Math.pow(Math.max(0, (v * 203) / 10000), m1);
          return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
        };
      } else enc = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
      [R, G, B] = [enc(lr), enc(lg), enc(lb)];
    }
    const Y = this.kr * R + (1 - this.kr - this.kb) * G + this.kb * B;
    const Cb = (B - Y) / (2 * (1 - this.kb));
    const Cr = (R - Y) / (2 * (1 - this.kr));
    const s = 1 << (this.bits - 8);
    const max = (1 << this.bits) - 1;
    let out: [number, number, number];
    if (this.full) out = [Y * max, (Cb + 0.5) * max, (Cr + 0.5) * max];
    else out = [(16 + 219 * Y) * s, (128 + 224 * Cb) * s, (128 + 224 * Cr) * s];
    out = out.map((v) => Math.min(max, Math.max(0, v))) as [number, number, number];
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Renders captions into coded (pre-rotation) space and blends them into a frame's planes.
 * `drawOverlay` draws captions in *display* space; we map it to coded space for the
 * file's rotation, so rotation metadata can be kept as-is instead of re-rendering the picture.
 */
export class YuvCompositor {
  private overlay: OffscreenCanvas | HTMLCanvasElement;
  private octx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private math: ColorMath;
  private fmt: Fmt;
  private format: string;
  private dirty: Rect | null = null;
  private buf: Uint8Array<ArrayBuffer> | null = null;
  private out8: Uint8Array<ArrayBuffer> | null = null;
  readonly downconvert: boolean;
  /** Shift applied to output timestamps (µs), to match a trimmed timeline. */
  timestampOffsetUs = 0;

  constructor(
    format: string,
    private cw: number, // coded (visible) width
    private ch: number,
    private rotation: number,
    private tags: ColorTags,
    mathCs: ColorTags,
  ) {
    this.format = format;
    this.fmt = FORMATS[format];
    this.downconvert = this.fmt.bits > 8; // encoders here are 8-bit; keep the colour space, round the depth
    this.math = new ColorMath(mathCs, this.fmt.bits, Math.min(cw, ch));
    this.overlay = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    this.octx = this.overlay.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  }

  /** Display→coded transform for the file's clockwise display rotation. */
  private setDisplayTransform() {
    const { cw, ch } = this;
    const c = this.octx;
    switch (this.rotation) {
      case 90: c.setTransform(0, -1, 1, 0, 0, ch); break;
      case 180: c.setTransform(-1, 0, 0, -1, cw, ch); break;
      case 270: c.setTransform(0, 1, -1, 0, cw, 0); break;
      default: c.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  private toCoded(r: Rect, W: number, H: number): Rect {
    let x0: number, y0: number, x1: number, y1: number;
    const X0 = r.x, Y0 = r.y, X1 = r.x + r.w, Y1 = r.y + r.h;
    switch (this.rotation) {
      case 90: [x0, x1, y0, y1] = [Y0, Y1, this.ch - X1, this.ch - X0]; break;
      case 180: [x0, x1, y0, y1] = [this.cw - X1, this.cw - X0, this.ch - Y1, this.ch - Y0]; break;
      case 270: [x0, x1, y0, y1] = [this.cw - Y1, this.cw - Y0, X0, X1]; break;
      default: [x0, x1, y0, y1] = [X0, X1, Y0, Y1];
    }
    void W; void H;
    // Align to the chroma grid and clamp.
    x0 = Math.max(0, Math.floor(x0 / 2) * 2);
    y0 = Math.max(0, Math.floor(y0 / 2) * 2);
    x1 = Math.min(this.cw, Math.ceil(x1 / 2) * 2);
    y1 = Math.min(this.ch, Math.ceil(y1 / 2) * 2);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  /**
   * Composite captions into `sample`. `draw` paints captions in display space (W×H) and
   * returns their display-space bounds, or null when nothing is on screen.
   */
  async composite(sample: VideoSample, W: number, H: number, draw: (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => Rect | null): Promise<VideoFrame | null> {
    const c = this.octx;
    if (this.dirty) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(this.dirty.x, this.dirty.y, this.dirty.w, this.dirty.h);
      this.dirty = null;
    }
    this.setDisplayTransform();
    const bounds = draw(c);
    c.setTransform(1, 0, 0, 1, 0, 0);
    const rect = bounds ? this.toCoded(bounds, W, H) : null;
    if (rect && rect.w > 0 && rect.h > 0) this.dirty = rect;
    if (!this.dirty && !this.downconvert) return null; // nothing to change → caller passes the frame through

    const size = sample.allocationSize();
    if (!this.buf || this.buf.byteLength !== size) this.buf = new Uint8Array(size);
    const layout = await sample.copyTo(this.buf);
    if (this.dirty) this.blend(layout, this.dirty);

    const init = {
      timestamp: sample.microsecondTimestamp + this.timestampOffsetUs,
      duration: sample.microsecondDuration,
      codedWidth: this.cw,
      codedHeight: this.ch,
      colorSpace: this.tags as VideoColorSpaceInit,
    };
    if (!this.downconvert) return new VideoFrame(this.buf, { ...init, format: this.format as VideoPixelFormat, layout });
    return this.to8bit(layout, init);
  }

  /**
   * Composite into an already-prepared I420 buffer (e.g. a frame the GPU scaler just resized
   * to 4K). This compositor must have been created with format 'I420' at the buffer's size.
   */
  frameFromBuffer(
    buf: Uint8Array<ArrayBuffer>,
    layout: PlaneLayout[],
    timestampUs: number,
    durationUs: number,
    W: number,
    H: number,
    draw: (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => Rect | null,
  ): VideoFrame {
    const c = this.octx;
    if (this.dirty) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(this.dirty.x, this.dirty.y, this.dirty.w, this.dirty.h);
      this.dirty = null;
    }
    this.setDisplayTransform();
    const bounds = draw(c);
    c.setTransform(1, 0, 0, 1, 0, 0);
    const rect = bounds ? this.toCoded(bounds, W, H) : null;
    if (rect && rect.w > 0 && rect.h > 0) this.dirty = rect;
    this.buf = buf;
    if (this.dirty) this.blend(layout, this.dirty);
    return new VideoFrame(buf, {
      format: 'I420',
      codedWidth: this.cw,
      codedHeight: this.ch,
      timestamp: timestampUs + this.timestampOffsetUs,
      duration: durationUs,
      layout,
      colorSpace: this.tags as VideoColorSpaceInit,
    });
  }

  /** Copy a frame unchanged but labelled with the input's colour tags (and 8-bit if needed). */
  async copyFrame(sample: VideoSample): Promise<VideoFrame> {
    const size = sample.allocationSize();
    if (!this.buf || this.buf.byteLength !== size) this.buf = new Uint8Array(size);
    const layout = await sample.copyTo(this.buf);
    const init = {
      timestamp: sample.microsecondTimestamp + this.timestampOffsetUs,
      duration: sample.microsecondDuration,
      codedWidth: this.cw,
      codedHeight: this.ch,
      colorSpace: this.tags as VideoColorSpaceInit,
    };
    if (!this.downconvert) return new VideoFrame(this.buf, { ...init, format: this.format as VideoPixelFormat, layout });
    return this.to8bit(layout, init);
  }

  private blend(layout: PlaneLayout[], r: Rect) {
    const img = this.octx.getImageData(r.x, r.y, r.w, r.h).data;
    const { fmt, math } = this;
    const wide = fmt.bits > 8;
    const buf = this.buf!;
    const u16 = wide ? new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1) : null;
    const get = (o: number) => (u16 ? u16[o >> 1] : buf[o]);
    const set = (o: number, v: number) => {
      if (u16) u16[o >> 1] = Math.round(v);
      else buf[o] = Math.round(v);
    };
    const bps = wide ? 2 : 1;
    const tmp = new Float32Array(3);

    // Luma
    const yl = layout[0];
    for (let j = 0; j < r.h; j++) {
      const row = yl.offset + (r.y + j) * yl.stride;
      for (let i = 0; i < r.w; i++) {
        const p = (j * r.w + i) * 4;
        const a = img[p + 3];
        if (!a) continue;
        const Y = math.fast(img[p], img[p + 1], img[p + 2], tmp)[0];
        const o = row + (r.x + i) * bps;
        const al = a / 255;
        set(o, get(o) * (1 - al) + Y * al);
      }
    }

    // Chroma: alpha-weighted average over each subsampled block
    const { sx, sy } = fmt;
    const cx0 = r.x / sx, cy0 = r.y / sy, cwN = Math.ceil(r.w / sx), chN = Math.ceil(r.h / sy);
    for (let cj = 0; cj < chN; cj++) {
      for (let ci = 0; ci < cwN; ci++) {
        let aSum = 0, uSum = 0, vSum = 0, n = 0;
        for (let dy = 0; dy < sy; dy++) {
          const j = cj * sy + dy;
          if (j >= r.h) continue;
          for (let dx = 0; dx < sx; dx++) {
            const i = ci * sx + dx;
            if (i >= r.w) continue;
            n++;
            const p = (j * r.w + i) * 4;
            const a = img[p + 3];
            if (!a) continue;
            math.fast(img[p], img[p + 1], img[p + 2], tmp);
            const U = tmp[1];
            const V = tmp[2];
            aSum += a;
            uSum += U * a;
            vSum += V * a;
          }
        }
        if (!aSum) continue;
        const al = aSum / (255 * n);
        const U = uSum / aSum;
        const V = vSum / aSum;
        const cy = cy0 + cj, cx = cx0 + ci;
        if (fmt.planar) {
          const ou = layout[1].offset + cy * layout[1].stride + cx * bps;
          const ov = layout[2].offset + cy * layout[2].stride + cx * bps;
          set(ou, get(ou) * (1 - al) + U * al);
          set(ov, get(ov) * (1 - al) + V * al);
        } else {
          const o = layout[1].offset + cy * layout[1].stride + cx * 2;
          set(o, get(o) * (1 - al) + U * al);
          set(o + 1, get(o + 1) * (1 - al) + V * al);
        }
      }
    }
  }

  /** High-bit-depth planar → 8-bit with rounding (same subsampling, same colour space). */
  private to8bit(layout: PlaneLayout[], init: { timestamp: number; duration: number; codedWidth: number; codedHeight: number; colorSpace: VideoColorSpaceInit }): VideoFrame {
    const { sx, sy, bits } = this.fmt;
    const shift = bits - 8;
    const half = 1 << (shift - 1);
    const W = this.cw, H = this.ch;
    const cW = Math.ceil(W / sx), cH = Math.ceil(H / sy);
    const size = W * H + 2 * cW * cH;
    if (!this.out8 || this.out8.byteLength !== size) this.out8 = new Uint8Array(size);
    const out = this.out8;
    const src = new Uint16Array(this.buf!.buffer, this.buf!.byteOffset, this.buf!.byteLength >> 1);
    const planes: [number, number, number][] = [
      [0, W, H],
      [W * H, cW, cH],
      [W * H + cW * cH, cW, cH],
    ];
    planes.forEach(([dst, pw, ph], k) => {
      const l = layout[k];
      for (let y = 0; y < ph; y++) {
        const so = (l.offset >> 1) + y * (l.stride >> 1);
        const d = dst + y * pw;
        for (let x = 0; x < pw; x++) out[d + x] = Math.min(255, (src[so + x] + half) >> shift);
      }
    });
    const fmt8 = sx === 2 && sy === 2 ? 'I420' : sx === 2 ? 'I422' : 'I444';
    return new VideoFrame(out, {
      ...init,
      format: fmt8 as VideoPixelFormat,
      layout: planes.map(([offset, pw]) => ({ offset, stride: pw })),
    });
  }
}
