import { DEG, add, cross, lookAt, normalize, perspective, multiply, invert, scale, type Mat4, type Vec3 } from './math';

export interface CameraView {
  target: Vec3;
  /** Azimuth around world Z in radians (0 = looking toward +Y). */
  yaw: number;
  /** Elevation above the horizon in radians. */
  pitch: number;
  distance: number;
}

export interface CameraLimits {
  minPitch: number;
  maxPitch: number;
  minDistance: number;
  maxDistance: number;
}

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class OrbitCamera {
  view: CameraView = { target: [0, 0, 1], yaw: -0.6, pitch: 0.35, distance: 12 };
  limits: CameraLimits = { minPitch: 2 * DEG, maxPitch: 89.5 * DEG, minDistance: 0.5, maxDistance: 120 };
  fovY = 50 * DEG;
  /** Scene views keep the target above the ground. The 3D curve is centered on the origin. */
  clampGround = true;
  private anim: { from: CameraView; to: CameraView; start: number; duration: number } | null = null;

  get eye(): Vec3 {
    const { target, yaw, pitch, distance } = this.view;
    const cp = Math.cos(pitch);
    return add(target, [-Math.sin(yaw) * cp * distance, -Math.cos(yaw) * cp * distance, Math.sin(pitch) * distance]);
  }

  setView(view: CameraView, animate = false) {
    if (animate) {
      this.anim = { from: { ...this.view, target: [...this.view.target] }, to: view, start: performance.now(), duration: 900 };
    } else {
      this.anim = null;
      this.view = { ...view, target: [...view.target] };
    }
  }

  /** Advances any running transition. Returns true while the camera is moving. */
  update(now: number): boolean {
    if (!this.anim) return false;
    const { from, to, start, duration } = this.anim;
    const t = easeOutExpo(Math.min(1, (now - start) / duration));
    this.view = {
      target: [lerp(from.target[0], to.target[0], t), lerp(from.target[1], to.target[1], t), lerp(from.target[2], to.target[2], t)],
      yaw: lerpAngle(from.yaw, to.yaw, t),
      pitch: lerp(from.pitch, to.pitch, t),
      distance: lerp(from.distance, to.distance, t),
    };
    if (t >= 1) this.anim = null;
    return true;
  }

  orbit(dxPx: number, dyPx: number) {
    this.anim = null;
    this.view.yaw += dxPx * 0.0055;
    this.view.pitch = Math.min(this.limits.maxPitch, Math.max(this.limits.minPitch, this.view.pitch + dyPx * 0.0045));
  }

  pan(dxPx: number, dyPx: number, viewportHeight: number) {
    this.anim = null;
    const eye = this.eye;
    const forward = normalize([this.view.target[0] - eye[0], this.view.target[1] - eye[1], this.view.target[2] - eye[2]]);
    const right = normalize(cross(forward, [0, 0, 1]));
    const up = cross(right, forward);
    const worldPerPx = (2 * this.view.distance * Math.tan(this.fovY / 2)) / Math.max(1, viewportHeight);
    const delta = add(scale(right, -dxPx * worldPerPx), scale(up, dyPx * worldPerPx));
    this.view.target = add(this.view.target, delta);
    if (this.clampGround) this.view.target[2] = Math.max(0, this.view.target[2]);
  }

  zoom(factor: number) {
    this.anim = null;
    this.view.distance = Math.min(this.limits.maxDistance, Math.max(this.limits.minDistance, this.view.distance * factor));
  }

  matrices(aspect: number): { view: Mat4; proj: Mat4; viewProj: Mat4; invViewProj: Mat4 } {
    const view = lookAt(this.eye, this.view.target, [0, 0, 1]);
    const proj = perspective(this.fovY, aspect, 0.05, 500);
    const viewProj = multiply(proj, view);
    return { view, proj, viewProj, invViewProj: invert(viewProj) };
  }
}
