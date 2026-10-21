/**
 * Path-trace worker. Same shape as the frontend measurement/heatmap workers:
 * a module worker, plain messages, typed arrays transferred in.
 * The WebGL context lives here so draw calls cannot stall the page scroll.
 */
import { PhotometricEngine, type FrameInfo, type LuminaireShape, type PointHit, type RenderSettings } from './photometricEngine';
import type { BuiltScene } from './scenes';

type CameraMode = 'keep' | 'animate' | 'jump';

export type RenderCommand =
  | { type: 'init'; canvas: OffscreenCanvas; cssWidth: number; cssHeight: number; dpr: number }
  | { type: 'resize'; cssWidth: number; cssHeight: number; dpr: number }
  | { type: 'photometry'; azSize: number; elSize: number; maxCandela: number; data: Uint16Array }
  | { type: 'shape'; shape: LuminaireShape }
  | { type: 'scene'; scene: BuiltScene; camera: CameraMode }
  | { type: 'settings'; settings: Partial<RenderSettings> }
  | { type: 'active'; active: boolean }
  | { type: 'orbit'; dx: number; dy: number }
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; factor: number }
  | { type: 'resetCamera' }
  | { type: 'hover'; cssX: number; cssY: number }
  | { type: 'dispose' };

export type RenderEvent =
  | { type: 'frame'; info: FrameInfo }
  | { type: 'camera' }
  | { type: 'hover'; point: PointHit | null }
  | { type: 'error'; message: string };

let engine: PhotometricEngine | null = null;
let lastPost = 0;

const post = (event: RenderEvent) => self.postMessage(event);

const postFrame = (info: FrameInfo) => {
  const now = performance.now();
  if (info.samples < info.maxSamples && now - lastPost < 120) return;
  lastPost = now;
  post({ type: 'frame', info });
};

self.onmessage = (event: MessageEvent<RenderCommand>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      engine = new PhotometricEngine(msg.canvas, { headless: true, controls: false });
      engine.onFrame = postFrame;
      engine.onCameraChange = () => post({ type: 'camera' });
      engine.setViewport(msg.cssWidth, msg.cssHeight, msg.dpr);
      return;
    }
    if (!engine) return;
    switch (msg.type) {
      case 'resize':
        engine.setViewport(msg.cssWidth, msg.cssHeight, msg.dpr);
        break;
      case 'photometry':
        engine.setPhotometry({ azSize: msg.azSize, elSize: msg.elSize, maxCandela: msg.maxCandela, data: msg.data });
        break;
      case 'shape':
        engine.setLuminaireShape(msg.shape);
        break;
      case 'scene':
        engine.setScene(msg.scene, msg.camera);
        break;
      case 'settings':
        engine.setSettings(msg.settings);
        break;
      case 'active':
        engine.setActive(msg.active);
        break;
      case 'orbit':
        engine.nudgeOrbit(msg.dx, msg.dy);
        break;
      case 'pan':
        engine.nudgePan(msg.dx, msg.dy);
        break;
      case 'zoom':
        engine.nudgeZoom(msg.factor);
        break;
      case 'resetCamera':
        engine.resetCamera();
        break;
      case 'hover':
        post({ type: 'hover', point: engine.pickPoint(msg.cssX, msg.cssY) });
        break;
      case 'dispose':
        engine.dispose();
        engine = null;
        break;
      default:
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
