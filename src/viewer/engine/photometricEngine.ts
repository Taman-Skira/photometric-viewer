import type { IntensitySampler, IntensityTexture } from '../../photometry';
import { kelvinToLinearRgb } from '../../photometry';
import { OrbitCamera, type CameraLimits, type CameraView } from './camera';
import { buildLdcGeometry, type LdcGeometry } from './ldc';
import { DEG, transformPoint, type Mat4, type Vec3 } from './math';
import { buildGlyphAtlas, formatLux, measurementLayout, type GlyphAtlas, type MeasureLayout } from './measurement';
import { FULLSCREEN_VS, LDC_FS, LDC_LINE_FS, LDC_LINE_VS, LDC_VS, OVERLAY_FS, OVERLAY_VS, PRESENT_FS, PROBE_FS, TRACE_FS } from './shaders';
import { MAX_BOXES, MAX_LAMPS, ROAD_HALF_WIDTH, estimateIlluminance, segmentBlocked, type BuiltScene } from './scenes';

export type ViewMode = 'render' | 'isolines' | 'points' | 'ldc';

export interface PointHit {
  position: Vec3;
  lux: number;
  cssX: number;
  cssY: number;
}

export interface RenderSettings {
  mode: ViewMode;
  isolines: boolean;
  /** 0..1 haze density slider. */
  haze: number;
  glare: boolean;
  exposureEv: number;
  cct: number;
  /** Multiplier on candela output (dimming). */
  dimming: number;
  bounces: number;
}

export interface LuminaireShape {
  halfX: number;
  halfY: number;
  round: boolean;
  housingHalf: Vec3;
}

export interface RendererOptions {
  maxSamples?: number;
  maxPixelRatio?: number;
  wheelZoom?: boolean;
  controls?: boolean;
  /** Offscreen canvas owned by a worker: no DOM listeners, size comes from setViewport. */
  headless?: boolean;
}

export interface FrameInfo {
  samples: number;
  maxSamples: number;
  luxMax: number;
  isoStep: number;
}

interface Target {
  fbo: WebGLFramebuffer;
  color: WebGLTexture;
  lux: WebGLTexture;
}

const LDC_HOME: CameraView = { target: [0, 0, 0], yaw: 0.85, pitch: 0.42, distance: 2.75 };
const LDC_LIMITS: CameraLimits = { minPitch: -80 * DEG, maxPitch: 80 * DEG, minDistance: 0.4, maxDistance: 8 };
const IDENTITY_ROT = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
/** Radiance of an urban night sky, cd/m². */
const NIGHT_SKY_RADIANCE = 0.01;
/** Illuminance at which a 30% grey diffuse surface renders as mid-grey at 0 EV.
 *  A fixed camera per setting, like a photographer's night-street and interior presets. */
const CAMERA_KEY_LUX = { outdoor: 30, indoor: 150 };
/** Measurement points are laid out in rows of this many texels. */
const PROBE_WIDTH = 64;
const PROBE_PASS_SAMPLES = 16;
const PROBE_MAX_SAMPLES = 1024;
/** Point spheres are sized in the world, like the frontend's 0.1 m markers, relative to the grid cell. */
const SPHERE_RADIUS_PER_CELL = 0.12;
const SPHERE_RADIUS_MIN = 0.06;
const SPHERE_RADIUS_MAX = 0.25;
/** Overlay sizes in CSS pixels. Far spheres keep this radius so they stay visible. */
const MIN_SPHERE_PX = 2;
const LABEL_PX = 11;
const LABEL_GAP = 5;
const MAX_LOD = 5;
const MAX_LABEL_CHARS = 6;
/** Floats per overlay instance: anchor (4), rect (4), uv (4), value (1). */
const OVERLAY_STRIDE = 13;
const MODE_ID: Record<ViewMode, number> = { render: 0, isolines: 1, points: 2, ldc: 0 };

const requestFrame = (cb: (time: number) => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), 16) as unknown as number);

const cancelFrame = (id: number) => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
};

interface CameraSnapshot {
  view: CameraView;
  limits: CameraLimits;
}

const DEFAULT_SETTINGS: RenderSettings = {
  mode: 'render',
  isolines: false,
  haze: 0,
  glare: true,
  exposureEv: 0,
  cct: 3000,
  dimming: 1,
  bounces: 3,
};

/** Rounds up to 1, 2, 2.5 or 5 x 10^n. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p * 1.0001) return m * p;
  return 10 * p;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile error: ${log}`);
  }
  return s;
}

function link(gl: WebGL2RenderingContext, fs: string, vs = FULLSCREEN_VS): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link error: ${gl.getProgramInfoLog(p)}`);
  return p;
}

type Surface = HTMLCanvasElement | OffscreenCanvas;

function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/** CPU sampler matching the GPU texture, so the worker does not need the parsed closure. */
function samplerFromTexture(texture: IntensityTexture): IntensitySampler {
  const { azSize, elSize, data, maxCandela } = texture;
  const values = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) values[i] = halfToFloat(data[i]) * maxCandela;
  const at = (ci: number, gi: number) => values[gi * azSize + ((ci % azSize) + azSize) % azSize];
  return (cDeg, gDeg) => {
    const c = ((cDeg % 360) + 360) % 360;
    const g = Math.min(180, Math.max(0, gDeg));
    const x = (c / 360) * azSize - 0.5;
    const y = (g / 180) * (elSize - 1);
    const x0 = Math.floor(x);
    const y0 = Math.min(elSize - 1, Math.max(0, Math.floor(y)));
    const y1 = Math.min(elSize - 1, y0 + 1);
    const tx = x - x0;
    const ty = Math.min(1, Math.max(0, y - y0));
    const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const b = at(x0, y1) * (1 - tx) + at(x0 + 1, y1) * tx;
    return a * (1 - ty) + b * ty;
  };
}

export class PhotometricEngine {
  readonly camera = new OrbitCamera();
  onFrame?: (info: FrameInfo) => void;
  onCameraChange?: () => void;
  onPointHover?: (point: PointHit | null) => void;

  private gl: WebGL2RenderingContext;
  private trace: WebGLProgram;
  private present: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private targets: Target[] = [];
  private current = 0;
  private internalFormat: number;
  private iesTex: WebGLTexture;
  private iesSize: [number, number] = [1, 1];
  private iesMax = 0;
  private sampler: IntensitySampler = () => 0;
  private shape: LuminaireShape = { halfX: 0.08, halfY: 0.08, round: true, housingHalf: [0.1, 0.1, 0.04] };
  private scene: BuiltScene | null = null;
  private settings: RenderSettings = { ...DEFAULT_SETTINGS };
  private samples = 0;
  private frameIndex = 0;
  private maxSamples: number;
  private maxPixelRatio: number;
  private renderScale = 1;
  private slowFrames = 0;
  private lastFrameTime = 0;
  private glareDirty = true;
  private lampGlare = new Float32Array(MAX_LAMPS);
  private headless: boolean;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private width = 1;
  private height = 1;
  private raf = 0;
  private active = true;
  private needsPresent = true;
  private exposure = 1;
  private luxMax = 100;
  private peakLux = 100;
  private isoStep = 10;
  private resizeObserver: ResizeObserver | null = null;
  private detachControls: () => void = () => {};
  private matrices: { viewProj: Mat4; invViewProj: Mat4 } | null = null;
  private ldcSolid: WebGLProgram;
  private ldcLine: WebGLProgram;
  private ldcMesh: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private ldcLines: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private ldcRibbons: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private ldcBuffers: WebGLBuffer[] = [];
  private sceneCam: CameraSnapshot | null = null;
  private ldcCam: CameraSnapshot = { view: { ...LDC_HOME, target: [...LDC_HOME.target] }, limits: { ...LDC_LIMITS } };
  private probeProgram: WebGLProgram;
  private overlayProgram: WebGLProgram;
  private layout: MeasureLayout = { points: [], slots: [] };
  private probeRows = 0;
  private probePos: WebGLTexture;
  private probeNrm: WebGLTexture;
  private probeTargets: { fbo: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  private probeCurrent = 0;
  private probeSamples = 0;
  private probeFrame = 0;
  private probeReadBuffer: WebGLBuffer;
  private probeSync: WebGLSync | null = null;
  private probeUnread = false;
  private probeValues = new Float32Array(0);
  private probeReady = false;
  private atlas: GlyphAtlas | null = null;
  private atlasTex: WebGLTexture | null = null;
  private overlayVao: WebGLVertexArrayObject;
  private overlayBuffer: WebGLBuffer;
  private overlayData = new Float32Array(0);
  private hits: { index: number; cssX: number; cssY: number; radiusCss: number; dist: number }[] = [];

  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      return !!gl && !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    } catch {
      return false;
    }
  }

  constructor(private canvas: Surface, options: RendererOptions = {}) {
    // HTMLCanvasElement and OffscreenCanvas disagree on getContext's return type.
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const full = gl.getExtension('EXT_color_buffer_float');
    const half = full ? null : gl.getExtension('EXT_color_buffer_half_float');
    if (!full && !half) throw new Error('Float render targets are not supported');
    this.internalFormat = full ? gl.RGBA32F : gl.RGBA16F;
    this.maxSamples = options.maxSamples ?? 768;
    this.maxPixelRatio = options.maxPixelRatio ?? 1.25;
    this.headless = options.headless === true;

    this.trace = link(gl, TRACE_FS);
    this.present = link(gl, PRESENT_FS);
    this.ldcSolid = link(gl, LDC_FS, LDC_VS);
    this.ldcLine = link(gl, LDC_LINE_FS, LDC_LINE_VS);
    this.probeProgram = link(gl, PROBE_FS);
    this.overlayProgram = link(gl, OVERLAY_FS, OVERLAY_VS);
    this.vao = gl.createVertexArray()!;

    const dataTex = () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    this.probePos = dataTex();
    this.probeNrm = dataTex();
    this.probeReadBuffer = gl.createBuffer()!;

    this.overlayVao = gl.createVertexArray()!;
    this.overlayBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.overlayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer);
    const stride = OVERLAY_STRIDE * 4;
    [4, 4, 4, 1].reduce((offset, size, index) => {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(index, 1);
      return offset + size;
    }, 0);
    gl.bindVertexArray(null);

    this.iesTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.iesTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1, 1, 0, gl.RED, gl.HALF_FLOAT, new Uint16Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (!this.headless && canvas instanceof HTMLCanvasElement) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
      this.resize();
      if (options.controls !== false) this.attachControls(options.wheelZoom !== false);
    }
    this.raf = requestFrame(this.loop);
  }

  /** CSS size of the on-screen canvas. The worker sends this; there is no layout in that thread. */
  setViewport(cssWidth: number, cssHeight: number, dpr: number) {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = Math.max(1, dpr);
    this.resize();
  }

  nudgeOrbit(dx: number, dy: number) {
    this.camera.orbit(dx, dy);
    this.afterCameraInput();
  }

  nudgePan(dx: number, dy: number) {
    this.camera.pan(dx, dy, this.cssHeight);
    this.afterCameraInput();
  }

  nudgeZoom(factor: number) {
    this.camera.zoom(factor);
    this.afterCameraInput();
  }

  private afterCameraInput() {
    this.glareDirty = true;
    this.reset();
    this.onCameraChange?.();
  }

  // ---------- public API ----------

  setPhotometry(texture: IntensityTexture, sampler?: IntensitySampler) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.iesTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, texture.azSize, texture.elSize, 0, gl.RED, gl.HALF_FLOAT, texture.data);
    this.iesSize = [texture.azSize, texture.elSize];
    this.iesMax = texture.maxCandela;
    this.sampler = sampler ?? samplerFromTexture(texture);
    this.glareDirty = true;
    this.updateExposure();
    this.rebuildLdc();
    this.reset();
    this.resetProbe();
  }

  setLuminaireShape(shape: LuminaireShape) {
    this.shape = shape;
    this.reset();
    this.resetProbe();
  }

  setScene(scene: BuiltScene, camera: 'keep' | 'animate' | 'jump' = 'keep') {
    this.scene = scene;
    this.uploadMeasurement();
    this.glareDirty = true;
    const limits = { minDistance: 0.5, maxPitch: 89.5 * DEG, ...scene.limits };
    if (this.settings.mode === 'ldc') {
      if (this.sceneCam) {
        this.sceneCam.limits = { ...this.sceneCam.limits, ...limits };
        if (camera !== 'keep') this.sceneCam.view = { ...scene.view, target: [...scene.view.target] };
      }
    } else {
      this.camera.limits = { ...this.camera.limits, ...limits };
      if (camera !== 'keep') this.camera.setView(scene.view, camera === 'animate');
    }
    this.updateExposure();
    this.rebuildLdc();
    this.reset();
  }

  setSettings(partial: Partial<RenderSettings>) {
    const prev = this.settings;
    this.settings = { ...prev, ...partial };
    this.glareDirty = true;
    const s = this.settings;
    if (s.mode === 'ldc' && prev.mode !== 'ldc') {
      this.sceneCam = this.snapshot();
      this.camera.clampGround = false;
      this.applySnapshot(this.ldcCam);
    } else if (s.mode !== 'ldc' && prev.mode === 'ldc') {
      this.ldcCam = this.snapshot();
      this.camera.clampGround = true;
      if (this.sceneCam) this.applySnapshot(this.sceneCam);
      this.needsPresent = true;
    }
    const needsTrace =
      s.haze !== prev.haze || s.glare !== prev.glare || s.cct !== prev.cct || s.dimming !== prev.dimming || s.bounces !== prev.bounces;
    if (s.dimming !== prev.dimming || s.exposureEv !== prev.exposureEv) this.updateExposure();
    if (s.dimming !== prev.dimming || s.bounces !== prev.bounces) this.resetProbe();
    if (needsTrace) this.reset();
    else this.needsPresent = true;
  }

  setActive(active: boolean) {
    this.active = active;
    if (active) this.needsPresent = true;
  }

  resetCamera() {
    if (this.settings.mode === 'ldc') {
      this.camera.setView(LDC_HOME, true);
      return;
    }
    if (this.scene) this.camera.setView(this.scene.view, true);
  }

  setCameraView(view: BuiltScene['view']) {
    this.camera.setView(view, true);
  }

  get frameInfo(): FrameInfo {
    return { samples: this.samples, maxSamples: this.maxSamples, luxMax: this.luxMax, isoStep: this.isoStep };
  }

  /** The measurement point under the cursor, or null. Nearest sphere wins. */
  pickPoint(cssX: number, cssY: number): PointHit | null {
    if (this.settings.mode !== 'points') return null;
    let best: (typeof this.hits)[number] | null = null;
    for (const hit of this.hits) {
      if (Math.hypot(hit.cssX - cssX, hit.cssY - cssY) > hit.radiusCss) continue;
      if (!best || hit.dist < best.dist) best = hit;
    }
    if (!best) return null;
    const point = this.layout.points[best.index];
    if (this.scene && segmentBlocked(this.scene, this.camera.eye, point.position)) return null;
    return { position: point.position, lux: this.probeValues[best.index], cssX: best.cssX, cssY: best.cssY };
  }

  /** Mean direct illuminance at a CSS pixel, or null if the pixel shows no surface. */
  readLux(cssX: number, cssY: number): number | null {
    const gl = this.gl;
    const x = Math.floor((cssX / this.cssWidth) * this.width);
    const y = Math.floor((1 - cssY / this.cssHeight) * this.height);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || this.samples === 0) return null;
    const t = this.targets[this.current];
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    const out = new Float32Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, out);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    if (out[1] < 0.5) return null;
    return out[0] / out[1];
  }

  /** Projects a world point to CSS pixels relative to the canvas. */
  project(p: Vec3): { x: number; y: number; visible: boolean } {
    const m = this.matrices ?? this.computeMatrices();
    const [x, y, , w] = transformPoint(m.viewProj, p);
    if (w <= 0.01) return { x: 0, y: 0, visible: false };
    return { x: ((x / w) * 0.5 + 0.5) * this.cssWidth, y: (1 - ((y / w) * 0.5 + 0.5)) * this.cssHeight, visible: true };
  }

  /** Presents the current accumulation and returns it as a PNG data URL. */
  captureImage(): string {
    this.drawPresent();
    return 'toDataURL' in this.canvas ? this.canvas.toDataURL('image/png') : '';
  }

  dispose() {
    cancelFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.detachControls();
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.color);
      gl.deleteTexture(t.lux);
    }
    gl.deleteTexture(this.iesTex);
    gl.deleteProgram(this.trace);
    gl.deleteProgram(this.present);
    gl.deleteProgram(this.ldcSolid);
    gl.deleteProgram(this.ldcLine);
    this.deleteLdcBuffers();
    gl.deleteProgram(this.probeProgram);
    gl.deleteProgram(this.overlayProgram);
    this.deleteProbeTargets();
    gl.deleteTexture(this.probePos);
    gl.deleteTexture(this.probeNrm);
    gl.deleteBuffer(this.probeReadBuffer);
    if (this.probeSync) gl.deleteSync(this.probeSync);
    if (this.atlasTex) gl.deleteTexture(this.atlasTex);
    gl.deleteVertexArray(this.overlayVao);
    gl.deleteBuffer(this.overlayBuffer);
  }

  // ---------- internals ----------

  private reset() {
    this.samples = 0;
    this.needsPresent = true;
  }

  private updateExposure() {
    if (!this.scene) return;
    const dim = this.settings.dimming;
    const { max } = estimateIlluminance(this.scene, (c, g) => this.sampler(c, g) * dim);
    // A fixed camera: the picture follows the light and never meters it.
    const key = this.scene.keyLux ?? (this.scene.outdoor ? CAMERA_KEY_LUX.outdoor : CAMERA_KEY_LUX.indoor);
    this.exposure = ((0.45 * Math.PI) / (0.3 * key)) * Math.pow(2, this.settings.exposureEv);
    const mount = this.scene.lamps.reduce((h, lamp) => Math.max(h, lamp.position[2]), 1);
    const anchorLux = (this.iesMax * dim) / Math.max(1, mount * mount);
    this.peakLux = Math.max(max, anchorLux, 1e-3);
    this.luxMax = niceCeil(Math.max(max, 1e-3) * 1.02);
    this.isoStep = niceCeil(this.luxMax / 10);
    this.needsPresent = true;
  }

  private resize() {
    const cw = this.headless ? this.cssWidth : Math.max(1, (this.canvas as HTMLCanvasElement).clientWidth || this.cssWidth);
    const ch = this.headless ? this.cssHeight : Math.max(1, (this.canvas as HTMLCanvasElement).clientHeight || this.cssHeight);
    this.cssWidth = cw;
    this.cssHeight = ch;
    const devicePr = this.headless ? this.dpr : window.devicePixelRatio || 1;
    let pr = Math.min(devicePr, this.maxPixelRatio) * this.renderScale;
    const maxPixels = 1.7e6;
    if (cw * ch * pr * pr > maxPixels) pr = Math.sqrt(maxPixels / (cw * ch));
    const w = Math.max(1, Math.round(cw * pr));
    const h = Math.max(1, Math.round(ch * pr));
    if (w === this.width && h === this.height && this.targets.length) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.createTargets();
    this.reset();
  }

  private createTargets() {
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.color);
      gl.deleteTexture(t.lux);
    }
    const makeTex = () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.internalFormat, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    this.targets = [0, 1].map(() => {
      const color = makeTex();
      const lux = makeTex();
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, lux, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      return { fbo, color, lux };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private loc(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let map = this.uniforms.get(program);
    if (!map) {
      map = new Map();
      this.uniforms.set(program, map);
    }
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(program, name));
    return map.get(name) ?? null;
  }

  private computeMatrices() {
    const m = this.camera.matrices(this.width / this.height);
    this.matrices = { viewProj: m.viewProj, invViewProj: m.invViewProj };
    return this.matrices;
  }

  private loop = (now: number) => {
    this.raf = requestFrame(this.loop);
    if (!this.active) return;
    if (this.settings.mode === 'ldc') {
      this.camera.update(now);
      this.drawLdc();
      return;
    }
    if (!this.scene) return;
    if (this.camera.update(now)) {
      this.glareDirty = true;
      this.reset();
      this.onCameraChange?.();
    }
    if (this.settings.mode === 'points' && this.stepProbe()) this.needsPresent = true;
    if (this.samples < this.maxSamples) {
      const dt = this.lastFrameTime ? now - this.lastFrameTime : 16;
      this.lastFrameTime = now;
      this.adapt(dt);
      this.computeMatrices();
      this.ensureGlare();
      this.drawTrace();
      this.drawPresent();
      this.onFrame?.(this.frameInfo);
    } else if (this.needsPresent) {
      this.lastFrameTime = 0;
      this.drawPresent();
      this.onFrame?.(this.frameInfo);
    }
  };

  private adapt(dt: number) {
    if (dt > 48) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 10 && this.renderScale > 0.55) {
      this.slowFrames = 0;
      this.renderScale *= 0.85;
      this.resize();
    }
  }

  private snapshot(): CameraSnapshot {
    return { view: { ...this.camera.view, target: [...this.camera.view.target] }, limits: { ...this.camera.limits } };
  }

  private applySnapshot(s: CameraSnapshot) {
    this.camera.limits = { ...s.limits };
    this.camera.setView(s.view, false);
  }

  private deleteLdcBuffers() {
    const gl = this.gl;
    for (const b of this.ldcBuffers) gl.deleteBuffer(b);
    this.ldcBuffers = [];
    if (this.ldcMesh) gl.deleteVertexArray(this.ldcMesh.vao);
    if (this.ldcLines) gl.deleteVertexArray(this.ldcLines.vao);
    if (this.ldcRibbons) gl.deleteVertexArray(this.ldcRibbons.vao);
    this.ldcMesh = null;
    this.ldcLines = null;
    this.ldcRibbons = null;
  }

  private rebuildLdc() {
    const rot = this.scene?.lamps[0]?.rotation ?? IDENTITY_ROT;
    try {
      this.uploadLdc(buildLdcGeometry(this.sampler, rot));
    } catch (e) {
      console.error(e);
    }
  }

  private gpuBuffer(data: ArrayBufferView, target: number): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    this.ldcBuffers.push(buf);
    return buf;
  }

  private attrib(index: number, buf: WebGLBuffer, size: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0);
  }

  private uploadLdc(geo: LdcGeometry) {
    const gl = this.gl;
    this.deleteLdcBuffers();

    const solid = gl.createVertexArray()!;
    gl.bindVertexArray(solid);
    this.attrib(0, this.gpuBuffer(geo.solidPos, gl.ARRAY_BUFFER), 3);
    this.attrib(1, this.gpuBuffer(geo.solidNrm, gl.ARRAY_BUFFER), 3);
    this.attrib(2, this.gpuBuffer(geo.solidCol, gl.ARRAY_BUFFER), 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gpuBuffer(geo.solidIdx, gl.ELEMENT_ARRAY_BUFFER));
    this.ldcMesh = { vao: solid, count: geo.solidIdx.length };

    const lines = gl.createVertexArray()!;
    gl.bindVertexArray(lines);
    this.attrib(0, this.gpuBuffer(geo.linePos, gl.ARRAY_BUFFER), 3);
    this.attrib(1, this.gpuBuffer(geo.lineCol, gl.ARRAY_BUFFER), 4);
    this.ldcLines = { vao: lines, count: geo.linePos.length / 3 };

    const ribbons = gl.createVertexArray()!;
    gl.bindVertexArray(ribbons);
    this.attrib(0, this.gpuBuffer(geo.ribbonPos, gl.ARRAY_BUFFER), 3);
    this.attrib(1, this.gpuBuffer(geo.ribbonCol, gl.ARRAY_BUFFER), 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gpuBuffer(geo.ribbonIdx, gl.ELEMENT_ARRAY_BUFFER));
    this.ldcRibbons = { vao: ribbons, count: geo.ribbonIdx.length };

    gl.bindVertexArray(null);
  }

  private drawLdc() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0.0275, 0.0314, 0.0392, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.ldcMesh) return;

    const m = this.computeMatrices();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE);

    const solid = this.ldcSolid;
    gl.useProgram(solid);
    gl.uniformMatrix4fv(this.loc(solid, 'uViewProj'), false, m.viewProj);
    gl.uniform3fv(this.loc(solid, 'uEye'), this.camera.eye);
    gl.bindVertexArray(this.ldcMesh.vao);
    gl.cullFace(gl.FRONT);
    gl.uniform1f(this.loc(solid, 'uBack'), 1);
    gl.drawElements(gl.TRIANGLES, this.ldcMesh.count, gl.UNSIGNED_SHORT, 0);
    gl.cullFace(gl.BACK);
    gl.uniform1f(this.loc(solid, 'uBack'), 0);
    gl.drawElements(gl.TRIANGLES, this.ldcMesh.count, gl.UNSIGNED_SHORT, 0);

    gl.disable(gl.CULL_FACE);
    const line = this.ldcLine;
    gl.useProgram(line);
    gl.uniformMatrix4fv(this.loc(line, 'uViewProj'), false, m.viewProj);
    if (this.ldcLines) {
      gl.bindVertexArray(this.ldcLines.vao);
      gl.drawArrays(gl.LINES, 0, this.ldcLines.count);
    }
    if (this.ldcRibbons && this.ldcRibbons.count) {
      gl.bindVertexArray(this.ldcRibbons.vao);
      gl.drawElements(gl.TRIANGLES, this.ldcRibbons.count, gl.UNSIGNED_SHORT, 0);
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  private drawTrace() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    const read = this.targets[this.current];
    const write = this.targets[1 - this.current];
    const p = this.trace;
    const u = (n: string) => this.loc(p, n);

    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, this.width, this.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.color);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, read.lux);
    gl.uniform1i(u('uPrevColor'), 0);
    gl.uniform1i(u('uPrevLux'), 1);

    gl.uniform2f(u('uResolution'), this.width, this.height);
    gl.uniform1ui(u('uFrame'), this.frameIndex++ >>> 0);
    gl.uniform1f(u('uBlend'), 1 / (this.samples + 1));
    gl.uniformMatrix4fv(u('uInvViewProj'), false, this.matrices!.invViewProj);
    gl.uniform3fv(u('uCamPos'), this.camera.eye);
    this.sceneUniforms(p);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.current = 1 - this.current;
    this.samples++;
    this.needsPresent = true;
  }

  /** Lamps, geometry and lighting shared by the camera pass and the measurement probe. Binds the IES table to unit 2. */
  private sceneUniforms(p: WebGLProgram) {
    const gl = this.gl;
    const scene = this.scene!;
    const u = (n: string) => this.loc(p, n);
    const s = this.settings;
    const eye = this.camera.eye;

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.iesTex);
    gl.uniform1i(u('uIes'), 2);
    gl.uniform2f(u('uIesSize'), this.iesSize[0], this.iesSize[1]);
    gl.uniform1f(u('uIesScale'), this.iesMax * s.dimming);
    gl.uniform3fv(u('uLightTint'), kelvinToLinearRgb(s.cct));

    const lamps = scene.lamps.slice(0, MAX_LAMPS);
    gl.uniform1i(u('uLampCount'), lamps.length);
    if (lamps.length) {
      gl.uniform3fv(u('uLampPos[0]'), lamps.flatMap((l) => l.position));
      const rots = new Float32Array(lamps.length * 9);
      lamps.forEach((l, i) => rots.set(l.rotation, i * 9));
      gl.uniformMatrix3fv(u('uLampRot[0]'), false, rots);
      gl.uniform1fv(u('uLampGlare[0]'), this.lampGlare.subarray(0, lamps.length));
    }
    gl.uniform2f(u('uLumHalf'), this.shape.halfX, this.shape.halfY);
    gl.uniform1i(u('uLumRound'), this.shape.round ? 1 : 0);
    gl.uniform3fv(u('uHousingHalf'), this.shape.housingHalf);

    const boxes = scene.boxes.slice(0, MAX_BOXES);
    gl.uniform1i(u('uBoxCount'), boxes.length);
    if (boxes.length) {
      gl.uniform3fv(u('uBoxMin[0]'), boxes.flatMap((b) => b.min));
      gl.uniform3fv(u('uBoxMax[0]'), boxes.flatMap((b) => b.max));
      gl.uniform4fv(
        u('uBoxInfo[0]'),
        boxes.flatMap((b) => {
          let hidden = 0;
          if (b.cutaway) {
            const { point, inward } = b.cutaway;
            const d = (eye[0] - point[0]) * inward[0] + (eye[1] - point[1]) * inward[1] + (eye[2] - point[2]) * inward[2];
            hidden = d < 0 ? 1 : 0;
          }
          return [b.material, b.castsShadow ? 1 : 0, hidden, 0];
        }),
      );
    }
    gl.uniform1i(u('uGround'), scene.ground);
    gl.uniform1f(u('uGridLines'), scene.gridLines ? 1 : 0);
    gl.uniform1f(u('uRoadHalf'), ROAD_HALF_WIDTH);

    gl.uniform1i(u('uMaxBounces'), Math.max(1, Math.min(6, s.bounces)));
    gl.uniform1f(u('uOutdoor'), scene.outdoor ? 1 : 0);
    // Fixed scene radiances in cd/m², independent of the camera: a lit-city
    // night sky is around 0.01 cd/m², and a closed room has no outside fill.
    gl.uniform1f(u('uSkyScale'), 0.25);
    gl.uniform1f(u('uAmbient'), scene.outdoor ? NIGHT_SKY_RADIANCE : 0);
    gl.uniform1f(u('uHaze'), s.haze * s.haze * 0.12);
    gl.uniform1f(u('uGlare'), s.glare ? 0.6 : 0);
    // Firefly cap on bounced light: twice the brightest radiance a white
    // Lambertian surface in this scene can reflect.
    gl.uniform1f(u('uClamp'), (2 * this.peakLux) / Math.PI);
    const tint = kelvinToLinearRgb(s.cct);
    gl.uniform1f(u('uTintLuma'), Math.max(1e-4, 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]));
  }

  private drawPresent() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    const p = this.present;
    const u = (n: string) => this.loc(p, n);
    const t = this.targets[this.current];
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.color);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.lux);
    gl.uniform1i(u('uColor'), 0);
    gl.uniform1i(u('uLux'), 1);
    gl.uniform1f(u('uExposure'), this.exposure);
    gl.uniform1i(u('uMode'), MODE_ID[this.settings.mode]);
    gl.uniform1f(u('uLuxMax'), this.luxMax);
    gl.uniform1f(u('uIsoStep'), this.isoStep);
    gl.uniform1f(u('uIsolines'), this.settings.isolines ? 1 : 0);
    gl.uniform2f(u('uResolution'), this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.settings.mode === 'points') this.drawOverlay();
    this.needsPresent = false;
  }

  // ---------- measurement points ----------

  private deleteProbeTargets() {
    const gl = this.gl;
    for (const t of this.probeTargets) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    this.probeTargets = [];
  }

  private uploadMeasurement() {
    const gl = this.gl;
    const prevCount = this.layout.points.length;
    this.layout = this.scene ? measurementLayout(this.scene) : { points: [], slots: [] };
    const points = this.layout.points;
    const rows = Math.max(1, Math.ceil(points.length / PROBE_WIDTH));
    const pos = new Float32Array(PROBE_WIDTH * rows * 4);
    const nrm = new Float32Array(PROBE_WIDTH * rows * 4);
    points.forEach((p, k) => {
      pos.set(p.position, k * 4);
      nrm.set(p.normal, k * 4);
    });
    for (const [tex, data] of [
      [this.probePos, pos],
      [this.probeNrm, nrm],
    ] as const) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, PROBE_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, data);
    }
    if (rows !== this.probeRows) {
      this.deleteProbeTargets();
      this.probeRows = rows;
      this.probeTargets = [0, 1].map(() => {
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, this.internalFormat, PROBE_WIDTH, rows);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { fbo, tex };
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    // A read in flight describes the previous layout.
    if (this.probeSync) {
      gl.deleteSync(this.probeSync);
      this.probeSync = null;
    }
    if (points.length !== prevCount) {
      this.probeValues = new Float32Array(points.length);
      this.probeReady = false;
    }
    this.resetProbe();
  }

  private resetProbe() {
    this.probeSamples = 0;
    this.needsPresent = true;
  }

  /** Runs one probe pass and collects finished readbacks. Returns true when new values arrived. */
  private stepProbe(): boolean {
    const gl = this.gl;
    const changed = this.pollProbeRead();
    if (!this.scene || !this.layout.points.length || !this.probeTargets.length) return changed;

    if (this.probeSamples < PROBE_MAX_SAMPLES) {
      const read = this.probeTargets[this.probeCurrent];
      const write = this.probeTargets[1 - this.probeCurrent];
      const p = this.probeProgram;
      const u = (n: string) => this.loc(p, n);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(p);
      gl.bindVertexArray(this.vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
      gl.viewport(0, 0, PROBE_WIDTH, this.probeRows);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, read.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.probePos);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.probeNrm);
      gl.uniform1i(u('uPrevProbe'), 0);
      gl.uniform1i(u('uProbePos'), 1);
      gl.uniform1i(u('uProbeNrm'), 3);
      gl.uniform1ui(u('uFrame'), this.probeFrame++ >>> 0);
      gl.uniform1i(u('uProbeSamples'), PROBE_PASS_SAMPLES);
      gl.uniform1f(u('uBlend'), PROBE_PASS_SAMPLES / (this.probeSamples + PROBE_PASS_SAMPLES));
      this.sceneUniforms(p);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.probeCurrent = 1 - this.probeCurrent;
      this.probeSamples += PROBE_PASS_SAMPLES;
      this.probeUnread = true;
    }

    if (this.probeUnread && !this.probeSync) {
      // Asynchronous readback so the worker never waits on the GPU.
      const bytes = PROBE_WIDTH * this.probeRows * 16;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.probeTargets[this.probeCurrent].fbo);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeReadBuffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      gl.readPixels(0, 0, PROBE_WIDTH, this.probeRows, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      this.probeSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this.probeUnread = false;
    }
    return changed;
  }

  private pollProbeRead(): boolean {
    const gl = this.gl;
    if (!this.probeSync) return false;
    if (gl.clientWaitSync(this.probeSync, 0, 0) === gl.TIMEOUT_EXPIRED) return false;
    gl.deleteSync(this.probeSync);
    this.probeSync = null;
    const texels = new Float32Array(PROBE_WIDTH * this.probeRows * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeReadBuffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, texels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    for (let k = 0; k < this.probeValues.length; k++) this.probeValues[k] = texels[k * 4];
    this.probeReady = true;
    return true;
  }

  private ensureAtlas(): boolean {
    if (this.atlasTex) return true;
    if (!this.atlas) this.atlas = buildGlyphAtlas();
    if (!this.atlas) return false;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.atlas.width, this.atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasTex = tex;
    return true;
  }

  /**
   * Point spheres and their lux labels. Where neighbours
   * crowd on screen, only every 2nd, 4th, ... point along each grid axis is kept.
   */
  private drawOverlay() {
    const points = this.layout.points;
    this.hits = [];
    if (!this.probeReady || !points.length) return;
    const gl = this.gl;
    const m = this.matrices ?? this.computeMatrices();
    const eye = this.camera.eye;
    const px = this.width / this.cssWidth;
    const n = points.length;
    const focalPx = this.height / (2 * Math.tan(this.camera.fovY / 2));
    const gridRadius = this.scene!.grids.map((g) => {
      const cell = Math.min(Math.hypot(...g.u) / g.nu, Math.hypot(...g.v) / g.nv);
      return Math.min(SPHERE_RADIUS_MAX, Math.max(SPHERE_RADIUS_MIN, SPHERE_RADIUS_PER_CELL * cell));
    });

    const sx = new Float32Array(n);
    const sy = new Float32Array(n);
    const radiusPx = new Float32Array(n);
    const onScreen = new Uint8Array(n);
    const projected = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const { position: p, normal: nm, grid } = points[k];
      const [x, y, , w] = transformPoint(m.viewProj, p);
      if (w <= 0.05) continue;
      sx[k] = ((x / w) * 0.5 + 0.5) * this.width;
      sy[k] = ((y / w) * 0.5 + 0.5) * this.height;
      radiusPx[k] = Math.max(MIN_SPHERE_PX * px, (gridRadius[grid] * focalPx) / w);
      projected[k] = 1;
      const facing = (eye[0] - p[0]) * nm[0] + (eye[1] - p[1]) * nm[1] + (eye[2] - p[2]) * nm[2] > 0;
      const margin = 40 * px + radiusPx[k];
      onScreen[k] = facing && sx[k] > -margin && sx[k] < this.width + margin && sy[k] > -margin && sy[k] < this.height + margin ? 1 : 0;
    }

    // Level at which neighbours along either grid axis stop overlapping a box of w x h.
    const levelFor = (k: number, w: number, h: number) => {
      const { grid, i, j } = points[k];
      const slots = this.layout.slots[grid];
      const nv = this.scene!.grids[grid].nv;
      const nu = slots.length / nv;
      let level = 0;
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nu || nj >= nv) continue;
        const q = slots[ni * nv + nj];
        if (q < 0 || !projected[q]) continue;
        const f = Math.max(Math.abs(sx[q] - sx[k]) / w, Math.abs(sy[q] - sy[k]) / h);
        level = Math.max(level, f >= 1 ? 0 : Math.ceil(Math.log2(1 / Math.max(f, 1e-6))));
      }
      return level;
    };
    const keep = (k: number, level: number) => {
      if (level > MAX_LOD) return false;
      const step = 1 << level;
      return points[k].i % step === 0 && points[k].j % step === 0;
    };

    const labelSlots = 1 + MAX_LABEL_CHARS;
    const needed = n * labelSlots * OVERLAY_STRIDE;
    if (this.overlayData.length < needed) this.overlayData = new Float32Array(needed);
    const out = this.overlayData;
    let count = 0;
    const push = (k: number, kind: number, ox: number, oy: number, w: number, h: number, uv: readonly number[]) => {
      const o = count++ * OVERLAY_STRIDE;
      const p = points[k].position;
      out[o] = sx[k];
      out[o + 1] = sy[k];
      out[o + 2] = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
      out[o + 3] = kind;
      out[o + 4] = ox;
      out[o + 5] = oy;
      out[o + 6] = w;
      out[o + 7] = h;
      out[o + 8] = uv[0];
      out[o + 9] = uv[1];
      out[o + 10] = uv[2];
      out[o + 11] = uv[3];
      out[o + 12] = this.probeValues[k];
    };

    this.hits = [];
    for (let k = 0; k < n; k++) {
      const R = radiusPx[k];
      if (!onScreen[k] || !keep(k, levelFor(k, 2 * R, 2 * R))) continue;
      const half = R + px;
      push(k, 1, -half, -half, 2 * half, 2 * half, [gridRadius[points[k].grid], R, 0, 0]);
      const p = points[k].position;
      this.hits.push({
        index: k,
        cssX: sx[k] / px,
        cssY: (this.height - sy[k]) / px,
        radiusCss: R / px,
        dist: Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]),
      });
    }
    if (this.ensureAtlas()) {
      const atlas = this.atlas!;
      const glyphScale = (LABEL_PX * px) / atlas.fontSize;
      const labelH = atlas.fontSize * 0.72 * glyphScale;
      const gap = LABEL_GAP * px;
      const labels: { k: number; text: string; width: number; dist: number }[] = [];
      for (let k = 0; k < n; k++) {
        if (!onScreen[k]) continue;
        const text = formatLux(this.probeValues[k]);
        let advance = 0;
        for (const ch of text) advance += atlas.glyphs.get(ch)?.advance ?? 0;
        const width = advance * glyphScale;
        if (!keep(k, levelFor(k, width + gap, labelH + gap))) continue;
        const pnt = points[k].position;
        labels.push({ k, text, width, dist: Math.hypot(pnt[0] - eye[0], pnt[1] - eye[1], pnt[2] - eye[2]) });
      }
      labels.sort((a, b) => a.dist - b.dist);
      const placed: number[] = [];
      const visible = labels.filter(({ k, width }) => {
        const x0 = sx[k] - width / 2 - gap / 2;
        const x1 = sx[k] + width / 2 + gap / 2;
        const y0 = sy[k] + radiusPx[k] + 3 * px - gap / 2;
        const y1 = y0 + labelH + gap;
        for (let q = 0; q < placed.length; q += 4) {
          if (x0 < placed[q + 2] && x1 > placed[q] && y0 < placed[q + 3] && y1 > placed[q + 1]) return false;
        }
        for (const d of this.hits) {
          const r = d.radiusCss * px;
          const dx = d.cssX * px;
          const dy = this.height - d.cssY * px;
          if (d.index !== k && x0 < dx + r && x1 > dx - r && y0 < dy + r && y1 > dy - r) return false;
        }
        placed.push(x0, y0, x1, y1);
        return true;
      });
      const pad = atlas.pad * glyphScale;
      const cellH = atlas.height * glyphScale;
      for (const { k, text, width } of visible) {
        let pen = -width / 2;
        for (const ch of text.slice(0, MAX_LABEL_CHARS)) {
          const g = atlas.glyphs.get(ch);
          if (!g) continue;
          push(k, 0, pen - pad, radiusPx[k] + 3 * px - pad, g.width * glyphScale, cellH, g.uv);
          pen += g.advance * glyphScale;
        }
      }
    }
    if (!count) return;

    const p = this.overlayProgram;
    const u = (name: string) => this.loc(p, name);
    gl.useProgram(p);
    gl.bindVertexArray(this.overlayVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, count * OVERLAY_STRIDE), gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.current].lux);
    gl.activeTexture(gl.TEXTURE1);
    if (this.atlasTex) gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(u('uLux'), 0);
    gl.uniform1i(u('uAtlas'), 1);
    gl.uniform2f(u('uResolution'), this.width, this.height);
    gl.uniform1f(u('uLuxMax'), this.luxMax);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /** Veiling glare depends only on the camera, so it is filled when that changes. */
  private ensureGlare() {
    if (!this.glareDirty || !this.scene) return;
    this.glareDirty = false;
    const eye = this.camera.eye;
    const lamps = this.scene.lamps;
    const glare = this.settings.glare;
    for (let i = 0; i < MAX_LAMPS; i++) {
      const lamp = lamps[i];
      this.lampGlare[i] = glare && lamp ? this.eyeIlluminance(lamp.position, lamp.rotation, eye) : 0;
    }
  }

  /** Illuminance at the camera from one lamp (lux), 0 if occluded. Drives the veiling-glare term. */
  private eyeIlluminance(pos: Vec3, rot: Float32Array, eye: Vec3): number {
    const dx = eye[0] - pos[0];
    const dy = eye[1] - pos[1];
    const dz = eye[2] - pos[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    const d = Math.sqrt(d2);
    if (d < 0.2 || !this.scene) return 0;
    const lx = (rot[0] * dx + rot[1] * dy + rot[2] * dz) / d;
    const ly = (rot[3] * dx + rot[4] * dy + rot[5] * dz) / d;
    const lz = (rot[6] * dx + rot[7] * dy + rot[8] * dz) / d;
    const g = Math.acos(Math.max(-1, Math.min(1, -lz))) / DEG;
    let c = Math.atan2(-lx, ly) / DEG;
    if (c < 0) c += 360;
    const I = this.sampler(c, g) * this.settings.dimming;
    if (I <= 0) return 0;
    const hidden = this.scene.boxes.some((b) => b.cutaway) ? false : segmentBlocked(this.scene, eye, pos);
    return hidden ? 0 : I / d2;
  }

  private attachControls(wheelZoom: boolean) {
    const el = this.canvas as HTMLCanvasElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'orbit' | 'pan' | null = null;
    let pinchDist = 0;

    const changed = () => {
      this.glareDirty = true;
      this.reset();
      this.onCameraChange?.();
    };

    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      mode = e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'orbit';
      this.onPointHover?.(null);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) this.camera.zoom(pinchDist / Math.max(1, dist));
        pinchDist = dist;
        this.camera.pan(dx / 2, dy / 2, el.clientHeight);
      } else if (mode === 'pan') {
        this.camera.pan(dx, dy, el.clientHeight);
      } else {
        this.camera.orbit(dx, dy);
      }
      changed();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) mode = null;
    };
    const onHover = (e: PointerEvent) => {
      if (pointers.size > 0) return;
      const rect = el.getBoundingClientRect();
      this.onPointHover?.(this.pickPoint(e.clientX - rect.left, e.clientY - rect.top));
    };
    const onLeave = () => this.onPointHover?.(null);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.camera.zoom(Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015))));
      changed();
    };
    const onContext = (e: Event) => e.preventDefault();

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('contextmenu', onContext);
    if (wheelZoom) el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointermove', onHover);
    el.addEventListener('pointerleave', onLeave);
    this.detachControls = () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('contextmenu', onContext);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointermove', onHover);
      el.removeEventListener('pointerleave', onLeave);
    };
  }
}
