import { PhotometricEngine, niceCeil, type FrameInfo, type LuminaireShape, type PointHit, type RenderSettings, type ViewMode } from './photometricEngine';
import type { IntensitySampler, IntensityTexture } from '../../photometry';
import type { BuiltScene } from './scenes';
import type { RenderCommand, RenderEvent } from './render.worker';

export { niceCeil };
export type { FrameInfo, LuminaireShape, PointHit, RenderSettings, ViewMode };

type CameraMode = 'keep' | 'animate' | 'jump';

const workerSupported = () =>
  typeof Worker !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;

/**
 * Main-thread handle for the photometric view.
 * Rendering runs in a module worker (same setup as the frontend heatmap and
 * measurement workers) on an OffscreenCanvas, so scrolling stays on this thread.
 * If that isn't available, the engine runs here instead.
 */
export class PhotometricRenderer {
  onFrame?: (info: FrameInfo) => void;
  onCameraChange?: () => void;
  onHover?: (point: PointHit | null) => void;

  private worker: Worker | null = null;
  private engine: PhotometricEngine | null = null;
  private canvas: HTMLCanvasElement;
  private detachControls: () => void = () => {};
  private resizeObserver: ResizeObserver | null = null;
  private bootFrame = 0;
  private booted = false;
  private pending: { message: RenderCommand; transfer?: Transferable[] }[] = [];

  static isSupported(): boolean {
    return PhotometricEngine.isSupported();
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    if (!workerSupported()) {
      this.engine = new PhotometricEngine(canvas);
      this.engine.onFrame = (info) => this.onFrame?.(info);
      this.engine.onCameraChange = () => this.onCameraChange?.();
      this.engine.onPointHover = (point) => this.onHover?.(point);
      this.booted = true;
      return;
    }
    // Strict mode runs the effect, cleans it up, then runs it again.
    // Transferring during the first pass would burn the canvas.
    this.bootFrame = requestAnimationFrame(() => this.boot());
  }

  private boot() {
    if (this.booted) return;
    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module', name: 'photometric-render' });
    this.worker.onmessage = (event: MessageEvent<RenderEvent>) => {
      const msg = event.data;
      if (msg.type === 'frame') this.onFrame?.(msg.info);
      else if (msg.type === 'camera') this.onCameraChange?.();
      else if (msg.type === 'hover') this.onHover?.(msg.point);
      else console.error('Photometric render worker:', msg.message);
    };
    this.worker.onerror = (event) => console.error('Photometric render worker:', event.message);
    const rect = this.canvas.getBoundingClientRect();
    this.worker.postMessage(
      {
        type: 'init',
        canvas: offscreen,
        cssWidth: Math.max(1, rect.width),
        cssHeight: Math.max(1, rect.height),
        dpr: window.devicePixelRatio || 1,
      } satisfies RenderCommand,
      [offscreen],
    );
    this.resizeObserver = new ResizeObserver(() => this.postSize());
    this.resizeObserver.observe(this.canvas);
    this.detachControls = bindControls(this.canvas, {
      orbit: (dx, dy) => this.post({ type: 'orbit', dx, dy }),
      pan: (dx, dy) => this.post({ type: 'pan', dx, dy }),
      zoom: (factor) => this.post({ type: 'zoom', factor }),
      hover: (cssX, cssY) => this.post({ type: 'hover', cssX, cssY }),
    });
    this.booted = true;
    const queued = this.pending;
    this.pending = [];
    for (const item of queued) this.worker.postMessage(item.message, item.transfer ?? []);
  }

  setPhotometry(texture: IntensityTexture, sampler?: IntensitySampler) {
    if (this.engine) {
      this.engine.setPhotometry(texture, sampler);
      return;
    }
    const data = texture.data.slice();
    this.post(
      { type: 'photometry', azSize: texture.azSize, elSize: texture.elSize, maxCandela: texture.maxCandela, data },
      [data.buffer],
    );
  }

  setLuminaireShape(shape: LuminaireShape) {
    if (this.engine) this.engine.setLuminaireShape(shape);
    else this.post({ type: 'shape', shape });
  }

  setScene(scene: BuiltScene, camera: CameraMode = 'keep') {
    if (this.engine) this.engine.setScene(scene, camera);
    else this.post({ type: 'scene', scene, camera });
  }

  setSettings(settings: Partial<RenderSettings>) {
    if (this.engine) this.engine.setSettings(settings);
    else this.post({ type: 'settings', settings });
  }

  setActive(active: boolean) {
    if (this.engine) this.engine.setActive(active);
    else this.post({ type: 'active', active });
  }

  resetCamera() {
    if (this.engine) this.engine.resetCamera();
    else this.post({ type: 'resetCamera' });
  }

  dispose() {
    cancelAnimationFrame(this.bootFrame);
    this.detachControls();
    this.resizeObserver?.disconnect();
    this.pending = [];
    if (this.engine) {
      this.engine.dispose();
      this.engine = null;
      return;
    }
    if (this.worker) {
      this.worker.postMessage({ type: 'dispose' } satisfies RenderCommand);
      this.worker.terminate();
      this.worker = null;
    }
  }

  private post(message: RenderCommand, transfer?: Transferable[]) {
    if (!this.booted || !this.worker) {
      this.pending.push({ message, transfer });
      return;
    }
    this.worker.postMessage(message, transfer ?? []);
  }

  private postSize() {
    const rect = this.canvas.getBoundingClientRect();
    this.post({
      type: 'resize',
      cssWidth: Math.max(1, rect.width),
      cssHeight: Math.max(1, rect.height),
      dpr: window.devicePixelRatio || 1,
    });
  }
}

function bindControls(
  el: HTMLCanvasElement,
  send: {
    orbit: (dx: number, dy: number) => void;
    pan: (dx: number, dy: number) => void;
    zoom: (factor: number) => void;
    hover: (cssX: number, cssY: number) => void;
  },
): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let mode: 'orbit' | 'pan' | null = null;
  let pinchDist = 0;

  const onDown = (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    mode = e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'orbit';
    send.hover(-1, -1);
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
      if (pinchDist > 0) send.zoom(pinchDist / Math.max(1, dist));
      pinchDist = dist;
      send.pan(dx / 2, dy / 2);
    } else if (mode === 'pan') send.pan(dx, dy);
    else send.orbit(dx, dy);
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) mode = null;
  };
  const onHover = (e: PointerEvent) => {
    if (pointers.size > 0) return;
    const rect = el.getBoundingClientRect();
    send.hover(e.clientX - rect.left, e.clientY - rect.top);
  };
  const onLeave = () => send.hover(-1, -1);
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    send.zoom(Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015))));
  };
  const onContext = (e: Event) => e.preventDefault();

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('contextmenu', onContext);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointermove', onHover);
  el.addEventListener('pointerleave', onLeave);
  return () => {
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
