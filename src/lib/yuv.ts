/**
 * GPU RGB → YUV 4:2:0 (BT.709, limited/"TV" range) converter.
 *
 * Why: if you hand a browser's video encoder an RGB canvas, many platforms tag the
 * result as full-range sRGB — non-standard for video, and it makes Instagram/TikTok
 * transcodes look washed out or crushed. Cameras, phones and editing software deliver
 * BT.709 limited range, so we convert to exactly that ourselves and tag it correctly.
 *
 * The shader packs 4 samples into each RGBA texel, so one readPixels() call yields
 * a ready-to-encode I420 buffer:  [ Y plane | U row, V row (interleaved per row) ].
 */

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 size;   // visible W,H
uniform float H;
uniform float P; // bytes per chroma plane: (W/2)*(H/2)
out vec4 o;

vec3 at(vec2 px) { return texelFetch(src, ivec2(clamp(px, vec2(0.0), size - 1.0)), 0).rgb; }
float Y(vec3 c) { return (16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722))) / 255.0; }
vec3 avg(float cx, float cy) {
  vec2 b = vec2(cx * 2.0, cy * 2.0);
  return (at(b) + at(b + vec2(1.0, 0.0)) + at(b + vec2(0.0, 1.0)) + at(b + vec2(1.0, 1.0))) * 0.25;
}
float U(vec3 c) { return (128.0 + 224.0 * dot(c, vec3(-0.114572, -0.385428, 0.5))) / 255.0; }
float V(vec3 c) { return (128.0 + 224.0 * dot(c, vec3(0.5, -0.454153, -0.045847))) / 255.0; }

void main() {
  float tx = floor(gl_FragCoord.x);
  float row = floor(gl_FragCoord.y);
  if (row < H) {
    float x = tx * 4.0;
    o = vec4(Y(at(vec2(x, row))), Y(at(vec2(x + 1.0, row))), Y(at(vec2(x + 2.0, row))), Y(at(vec2(x + 3.0, row))));
  } else {
    // Chroma planes are stored contiguously (U then V), each (W/2) bytes per row.
    float idx = (row - H) * size.x + tx * 4.0;
    bool isV = idx >= P;
    float local = isV ? idx - P : idx;
    float cw = size.x * 0.5;
    float cy = floor(local / cw);
    float cx = local - cy * cw;
    vec3 a = avg(cx, cy), b = avg(cx + 1.0, cy), c = avg(cx + 2.0, cy), d = avg(cx + 3.0, cy);
    o = isV ? vec4(V(a), V(b), V(c), V(d)) : vec4(U(a), U(b), U(c), U(d));
  }
}`;

export class Yuv420Converter {
  private gl: WebGL2RenderingContext;
  private tex: WebGLTexture;
  private buf: Uint8Array<ArrayBuffer>;
  readonly W: number;
  readonly H: number;

  static supported(W: number, H: number): boolean {
    return W % 8 === 0 && H % 2 === 0 && typeof VideoFrame !== 'undefined';
  }

  constructor(W: number, H: number) {
    this.W = W;
    this.H = H;
    const rows = H + H / 2;
    const texW = W / 4;
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(texW, rows) : Object.assign(document.createElement('canvas'), { width: texW, height: rows });
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (W > max || H > max) throw new Error('Frame too large for GPU texture');

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);

    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);

    gl.uniform1i(gl.getUniformLocation(prog, 'src'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'size'), W, H);
    gl.uniform1f(gl.getUniformLocation(prog, 'H'), H);
    gl.uniform1f(gl.getUniformLocation(prog, 'P'), (W / 2) * (H / 2));
    gl.viewport(0, 0, texW, rows);
    this.buf = new Uint8Array(W * rows);
  }

  /** Convert a composited RGB canvas into a correctly-tagged I420 VideoFrame. */
  convert(source: OffscreenCanvas | HTMLCanvasElement, timestamp: number, duration: number): VideoFrame {
    const { gl, W, H } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, W / 4, H + H / 2, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    return new VideoFrame(this.buf, {
      format: 'I420',
      codedWidth: W,
      codedHeight: H,
      timestamp,
      duration,
      layout: [
        { offset: 0, stride: W },
        { offset: W * H, stride: W / 2 },
        { offset: W * H + (W / 2) * (H / 2), stride: W / 2 },
      ],
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    });
  }

  /** Self-test: convert a known colour and check the result, so a quirky GPU never ruins an export. */
  selfTest(): boolean {
    try {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(this.W, this.H) : Object.assign(document.createElement('canvas'), { width: this.W, height: this.H });
      const ctx = c.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.W / 2, this.H);
      const f = this.convert(c, 0, 1);
      f.close();
      const y0 = this.buf[0];
      const y1 = this.buf[this.W - 1];
      const u = this.buf[this.W * this.H];
      return Math.abs(y0 - 16) <= 1 && Math.abs(y1 - 235) <= 1 && Math.abs(u - 128) <= 1;
    } catch (e) {
      console.warn('[ziticap] YUV path unavailable:', e);
      return false;
    }
  }
}
