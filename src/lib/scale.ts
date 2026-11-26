/**
 * GPU resize in the video's own YUV planes (used for 1080p / 4K output).
 *
 * Each plane is uploaded as an integer texture (8–16 bit, planar or NV12) and resampled
 * with a Catmull-Rom bicubic filter — the same family as ffmpeg's default "bicubic" — so
 * the picture never passes through RGB and keeps its exact colour space (HDR included).
 * The result is an 8-bit I420 buffer, packed 4 samples per RGBA texel so a single
 * readPixels() call returns the finished planes.
 */

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// 8-bit sources use normalized, filterable textures so Catmull-Rom needs only 9 bilinear taps
// (instead of 16 texel reads). Deeper sources use exact integer texelFetch.
const fs = (filtered: boolean) => `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
${filtered ? 'uniform sampler2D texY; uniform sampler2D texU; uniform sampler2D texV;' : 'uniform usampler2D texY; uniform usampler2D texU; uniform usampler2D texV;'}
uniform bool nv12;
uniform vec2 srcY;         // source luma size
uniform vec2 srcC;         // source chroma size
uniform vec2 dstY;         // output luma size
uniform float scale8;      // divide source values by this to get 8-bit (1, 4, 16)
uniform bool packed;       // 4 samples per texel (else 1)
uniform float texW;
out vec4 o;

float w0(float t) { return ((-0.5 * t + 1.0) * t - 0.5) * t; }
float w1(float t) { return (1.5 * t - 2.5) * t * t + 1.0; }
float w2(float t) { return ((-1.5 * t + 2.0) * t + 0.5) * t; }
float w3(float t) { return (0.5 * t - 0.5) * t * t; }

${filtered ? `
float tap(int plane, vec2 uv) {
  if (plane == 0) return texture(texY, uv).r;
  if (nv12) { vec4 t = texture(texU, uv); return plane == 1 ? t.r : t.g; }
  return plane == 1 ? texture(texU, uv).r : texture(texV, uv).r;
}
// Catmull-Rom via 9 bilinear taps (weights merged for the middle pair of texels).
float sampleAt(int plane, float x, float y, vec2 src, vec2 dst) {
  vec2 pos = (vec2(x, y) + 0.5) * src / dst;
  vec2 p1 = floor(pos - 0.5) + 0.5;
  vec2 f = pos - p1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 p0 = (p1 - 1.0) / src;
  vec2 p3 = (p1 + 2.0) / src;
  vec2 p12 = (p1 + w2 / w12) / src;
  float r = 0.0;
  r += tap(plane, vec2(p0.x, p0.y)) * w0.x * w0.y;
  r += tap(plane, vec2(p12.x, p0.y)) * w12.x * w0.y;
  r += tap(plane, vec2(p3.x, p0.y)) * w3.x * w0.y;
  r += tap(plane, vec2(p0.x, p12.y)) * w0.x * w12.y;
  r += tap(plane, vec2(p12.x, p12.y)) * w12.x * w12.y;
  r += tap(plane, vec2(p3.x, p12.y)) * w3.x * w12.y;
  r += tap(plane, vec2(p0.x, p3.y)) * w0.x * w3.y;
  r += tap(plane, vec2(p12.x, p3.y)) * w12.x * w3.y;
  r += tap(plane, vec2(p3.x, p3.y)) * w3.x * w3.y;
  return clamp(r, 0.0, 1.0);
}` : `
float fetch(int plane, ivec2 c, vec2 size) {
  c = clamp(c, ivec2(0), ivec2(size) - 1);
  if (plane == 0) return float(texelFetch(texY, c, 0).r);
  if (nv12) { uvec4 t = texelFetch(texU, c, 0); return float(plane == 1 ? t.r : t.g); }
  return float(plane == 1 ? texelFetch(texU, c, 0).r : texelFetch(texV, c, 0).r);
}

// Catmull-Rom sample of a plane at output pixel (x, y) of an output plane sized 'dst'.
float sampleAt(int plane, float x, float y, vec2 src, vec2 dst) {
  vec2 pos = (vec2(x, y) + 0.5) * src / dst - 0.5;
  vec2 f = floor(pos);
  vec2 t = pos - f;
  vec4 wx = vec4(w0(t.x), w1(t.x), w2(t.x), w3(t.x));
  vec4 wy = vec4(w0(t.y), w1(t.y), w2(t.y), w3(t.y));
  ivec2 b = ivec2(f) - 1;
  float acc = 0.0;
  for (int j = 0; j < 4; j++) {
    float row = 0.0;
    for (int i = 0; i < 4; i++) row += wx[i] * fetch(plane, b + ivec2(i, j), src);
    acc += wy[j] * row;
  }
  return clamp(acc / scale8, 0.0, 255.0) / 255.0;
}`}

float outSample(uint idx) {
  // idx = byte index into [Y | U | V]; integer maths keeps row/column exact at any size.
  uint W = uint(dstY.x);
  uint H = uint(dstY.y);
  uint ySize = W * H;
  if (idx < ySize) {
    uint y = idx / W;
    return sampleAt(0, float(idx - y * W), float(y), srcY, dstY);
  }
  uint l = idx - ySize;
  uint cP = (W / 2u) * (H / 2u);
  int plane = l < cP ? 1 : 2;
  if (plane == 2) l -= cP;
  uint cw = W / 2u;
  uint cy = l / cw;
  return sampleAt(plane, float(l - cy * cw), float(cy), srcC, dstY * 0.5);
}

void main() {
  uint per = packed ? 4u : 1u;
  uint idx = (uint(gl_FragCoord.y) * uint(texW) + uint(gl_FragCoord.x)) * per;
  if (packed) o = vec4(outSample(idx), outSample(idx + 1u), outSample(idx + 2u), outSample(idx + 3u));
  else o = vec4(outSample(idx), 0.0, 0.0, 1.0);
}`;

type Fmt = { nv12: boolean; sx: number; sy: number; bits: number };
const FORMATS: Record<string, Fmt> = {
  I420: { nv12: false, sx: 2, sy: 2, bits: 8 },
  I420A: { nv12: false, sx: 2, sy: 2, bits: 8 },
  I422: { nv12: false, sx: 2, sy: 1, bits: 8 },
  I444: { nv12: false, sx: 1, sy: 1, bits: 8 },
  NV12: { nv12: true, sx: 2, sy: 2, bits: 8 },
  I420P10: { nv12: false, sx: 2, sy: 2, bits: 10 },
  I420P12: { nv12: false, sx: 2, sy: 2, bits: 12 },
  I422P10: { nv12: false, sx: 2, sy: 1, bits: 10 },
  I422P12: { nv12: false, sx: 2, sy: 1, bits: 12 },
  I444P10: { nv12: false, sx: 1, sy: 1, bits: 10 },
  I444P12: { nv12: false, sx: 1, sy: 1, bits: 12 },
};

export function scalerSupported(format: string | null): boolean {
  return !!format && format in FORMATS && typeof WebGL2RenderingContext !== 'undefined';
}

export class YuvScaler {
  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture[];
  private fmt: Fmt;
  private filtered = false;
  private packed: boolean;
  private texW: number;
  private rows: number;
  private raw: Uint8Array<ArrayBuffer>;
  private src: Uint8Array<ArrayBuffer> | null = null;
  /** Output I420 planes (8-bit), tightly packed: Y (W×H), U, V (W/2 × H/2). */
  readonly out: Uint8Array<ArrayBuffer>;
  readonly layout: PlaneLayout[];

  constructor(
    format: string,
    private sw: number,
    private sh: number,
    readonly W: number,
    readonly H: number,
  ) {
    this.fmt = FORMATS[format];
    const total = W * H * 1.5;
    this.packed = W % 8 === 0;
    const per = this.packed ? 4 : 1;
    const texels = Math.ceil(total / per);
    this.texW = this.packed ? W / 4 : Math.min(W, 4096);
    this.rows = Math.ceil(texels / this.texW);
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(this.texW, this.rows) : Object.assign(document.createElement('canvas'), { width: this.texW, height: this.rows });
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (sw > max || sh > max || this.texW > max || this.rows > max) throw new Error('Frame too large for this GPU');

    const compile = (type: number, src: string) => {
      const x = gl.createShader(type)!;
      gl.shaderSource(x, src);
      gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? 'shader');
      return x;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    this.filtered = this.fmt.bits === 8;
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs(this.filtered)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = [0, 1, 2].map((i) => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      const filter = this.filtered ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    });
    const u = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniform1i(u('texY'), 0);
    gl.uniform1i(u('texU'), 1);
    gl.uniform1i(u('texV'), 2);
    gl.uniform1i(u('nv12'), this.fmt.nv12 ? 1 : 0);
    gl.uniform2f(u('srcY'), sw, sh);
    gl.uniform2f(u('srcC'), Math.ceil(sw / this.fmt.sx), Math.ceil(sh / this.fmt.sy));
    gl.uniform2f(u('dstY'), W, H);
    gl.uniform1f(u('scale8'), 1 << (this.fmt.bits - 8));
    gl.uniform1i(u('packed'), this.packed ? 1 : 0);
    gl.uniform1f(u('texW'), this.texW);
    gl.viewport(0, 0, this.texW, this.rows);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

    this.raw = new Uint8Array(this.texW * this.rows * 4);
    this.out = this.packed ? new Uint8Array(this.raw.buffer, 0, total) : new Uint8Array(total);
    this.layout = [
      { offset: 0, stride: W },
      { offset: W * H, stride: W / 2 },
      { offset: W * H + (W / 2) * (H / 2), stride: W / 2 },
    ];
  }

  private upload(unit: number, data: Uint8Array<ArrayBuffer>, layout: PlaneLayout, w: number, h: number, channels: 1 | 2) {
    const gl = this.gl;
    const wide = this.fmt.bits > 8;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[unit]);
    const bytes = wide ? 2 : 1;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout.stride / bytes / channels);
    if (this.filtered) {
      const view = new Uint8Array(data.buffer, data.byteOffset + layout.offset, layout.stride * (h - 1) + w * channels);
      gl.texImage2D(gl.TEXTURE_2D, 0, channels === 2 ? gl.RG8 : gl.R8, w, h, 0, channels === 2 ? gl.RG : gl.RED, gl.UNSIGNED_BYTE, view);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      return;
    }
    const fmt = channels === 2 ? gl.RG_INTEGER : gl.RED_INTEGER;
    if (wide) {
      const view = new Uint16Array(data.buffer, data.byteOffset + layout.offset, (layout.stride * (h - 1)) / 2 + w * channels);
      gl.texImage2D(gl.TEXTURE_2D, 0, channels === 2 ? gl.RG16UI : gl.R16UI, w, h, 0, fmt, gl.UNSIGNED_SHORT, view);
    } else {
      const view = new Uint8Array(data.buffer, data.byteOffset + layout.offset, layout.stride * (h - 1) + w * channels);
      gl.texImage2D(gl.TEXTURE_2D, 0, channels === 2 ? gl.RG8UI : gl.R8UI, w, h, 0, fmt, gl.UNSIGNED_BYTE, view);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  /** Resize one decoded frame. Returns the 8-bit I420 output (this.out, reused between calls). */
  async scale(sample: { allocationSize(): number; copyTo(d: Uint8Array<ArrayBuffer>): Promise<PlaneLayout[]> }): Promise<Uint8Array<ArrayBuffer>> {
    const size = sample.allocationSize();
    if (!this.src || this.src.byteLength !== size) this.src = new Uint8Array(size);
    const layout = await sample.copyTo(this.src);
    const { sw, sh, fmt } = this;
    const cw = Math.ceil(sw / fmt.sx);
    const ch = Math.ceil(sh / fmt.sy);
    this.upload(0, this.src, layout[0], sw, sh, 1);
    if (fmt.nv12) this.upload(1, this.src, layout[1], cw, ch, 2);
    else {
      this.upload(1, this.src, layout[1], cw, ch, 1);
      this.upload(2, this.src, layout[2], cw, ch, 1);
    }
    const gl = this.gl;
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, this.texW, this.rows, gl.RGBA, gl.UNSIGNED_BYTE, this.raw);
    if (!this.packed) for (let i = 0; i < this.out.length; i++) this.out[i] = this.raw[i * 4];
    return this.out;
  }
}

export type OutputResolution = 'original' | '1080p' | '4k';

/** Output size for a resolution preset, preserving aspect ratio (fits a 16:9-class box in either orientation). */
export function targetSize(dw: number, dh: number, res: OutputResolution): [number, number] {
  if (res === 'original') return [dw, dh];
  const [L, S] = res === '4k' ? [3840, 2160] : [1920, 1080];
  const k = Math.min(L / Math.max(dw, dh), S / Math.min(dw, dh));
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return [even(dw * k), even(dh * k)];
}
