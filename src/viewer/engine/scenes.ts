import type { CameraLimits, CameraView } from './camera';
import { DEG, applyMat3, luminaireRotation, type Mat3, type Vec3 } from './math';

export type SceneId = 'open' | 'street' | 'wall' | 'room';
export type StreetLayout = 'single' | 'opposite' | 'staggered';
export type WallFinish = 'plaster' | 'brick';

/** Material ids; must match the MAT_* constants in shaders.ts. */
export const MAT = {
  CONCRETE: 0,
  STREET: 1,
  SIDEWALK: 2,
  PLASTER: 3,
  BRICK: 4,
  WOOD_FLOOR: 5,
  CEILING: 6,
  METAL: 7,
  WOOD: 8,
  FABRIC: 9,
  FIGURE: 10,
  WHITE: 11,
  GRASS: 12,
} as const;

export interface SceneParams {
  scene: SceneId;
  /** Mounting height of the luminous opening above the floor (m). */
  height: number;
  /** Tilt in degrees; positive swings the beam toward C90. */
  tilt: number;
  /** Rotation of the C0 axis around the vertical in degrees. */
  rotation: number;
  count: number;
  spacing: number;
  wallDistance: number;
  ceilingHeight: number;
  wallFinish: WallFinish;
  streetLayout: StreetLayout;
  showFigure: boolean;
  /** Half extents of the luminaire housing (m), used to keep it clear of the ceiling. */
  housingHalf?: Vec3;
}

export interface SceneBox {
  min: Vec3;
  max: Vec3;
  material: number;
  castsShadow: boolean;
  /** Hidden from the camera (but still bouncing light) when the camera is on the outer side. */
  cutaway?: { point: Vec3; inward: Vec3 };
}

export interface SceneLamp {
  position: Vec3;
  rotation: Mat3;
}

export interface Receiver {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

/** A calculation surface with nu x nv measurement points at the cell centres. */
export interface MeasureGrid extends Receiver {
  nu: number;
  nv: number;
}

export interface BuiltScene {
  boxes: SceneBox[];
  lamps: SceneLamp[];
  ground: 0 | 1 | 2;
  outdoor: boolean;
  /** Exposure key in lux. Omitted scenes use the outdoor or indoor default. */
  keyLux?: number;
  gridLines: boolean;
  view: CameraView;
  limits: Partial<CameraLimits>;
  receivers: Receiver[];
  grids: MeasureGrid[];
  /** Height reference lines drawn in the overlay: from lamp down to the floor below it. */
  floorZ: number;
}

export const MAX_BOXES = 40;
export const MAX_LAMPS = 12;

export const ROAD_HALF_WIDTH = 3.5;
const SIDEWALK_WIDTH = 2.5;
/** Grass beyond each sidewalk, so spill light past the kerb can be measured. */
const VERGE_WIDTH = 4;
const VERGE_TOP = 0.04;
const CURB = 0.15;
const POLE_OFFSET = 1.0;
const ARM_OVERHANG = 0.6;
const ROOM_W = 7;
const ROOM_D = 5.5;
/** Gap left between the highest point of the luminaire body and the ceiling. */
export const CEILING_CLEARANCE = 0.05;

/**
 * Highest mounting height (luminous opening) at which the whole tilted body,
 * from the luminous face up to the top of the housing, stays below the ceiling.
 */
export function roomMountLimit(p: Pick<SceneParams, 'ceilingHeight' | 'tilt' | 'rotation' | 'housingHalf'>): number {
  const [hx, hy, hz] = p.housingHalf ?? [0.1, 0.1, 0.04];
  const rot = luminaireRotation(p.rotation * DEG, p.tilt * DEG);
  let rise = 0;
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [0, 2 * hz]) rise = Math.max(rise, applyMat3(rot, [x, y, z])[2]);
  return p.ceilingHeight - rise - CEILING_CLEARANCE;
}

const box = (min: Vec3, max: Vec3, material: number, castsShadow = true): SceneBox => ({ min, max, material, castsShadow });

function figure(base: Vec3, out: SceneBox[]) {
  const [x, y, z] = base;
  out.push(
    box([x - 0.19, y - 0.09, z], [x - 0.03, y + 0.07, z + 0.86], MAT.FIGURE),
    box([x + 0.03, y - 0.09, z], [x + 0.19, y + 0.07, z + 0.86], MAT.FIGURE),
    box([x - 0.21, y - 0.12, z + 0.86], [x + 0.21, y + 0.1, z + 1.46], MAT.FIGURE),
    box([x - 0.3, y - 0.07, z + 0.8], [x - 0.22, y + 0.05, z + 1.42], MAT.FIGURE),
    box([x + 0.22, y - 0.07, z + 0.8], [x + 0.3, y + 0.05, z + 1.42], MAT.FIGURE),
    box([x - 0.095, y - 0.11, z + 1.5], [x + 0.095, y + 0.09, z + 1.74], MAT.FIGURE),
  );
}

const rowPositions = (count: number, spacing: number) =>
  Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);

const MAX_GRID_AXIS = 36;
/** Extra points over the standard calculation grids, so the field reads a bit tighter. */
const GRID_DENSITY = 1.5;
/** Open-area cells stay this size. A higher mount grows the field, not the cells. */
const OPEN_GRID_STEP = 1;
const OPEN_GRID_MAX_AXIS = 96;
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** EN 12464-1 grid size: p = 0.2 · 5^log10(d), d being the longer side of the area. */
function normGrid(r: Receiver): MeasureGrid {
  const lu = len(r.u);
  const lv = len(r.v);
  const p = (0.2 * Math.pow(5, Math.log10(Math.max(lu, lv, 1)))) / GRID_DENSITY;
  const n = (l: number) => Math.min(MAX_GRID_AXIS, Math.max(1, Math.ceil(l / p)));
  return { ...r, nu: n(lu), nv: n(lv) };
}

/** Fixed spacing. The field grows by adding points; the cells do not get larger. */
function fixedGrid(r: Receiver, step: number, maxAxis: number): MeasureGrid {
  const n = (l: number) => Math.min(maxAxis, Math.max(1, Math.ceil(l / step)));
  return { ...r, nu: n(len(r.u)), nv: n(len(r.v)) };
}

/** Along-street spacing. A longer run or a wider pole spacing adds points; the cells stay this size. */
const ROAD_GRID_STEP = 3 / GRID_DENSITY;
const ROAD_GRID_MAX_AXIS = 160;

/** EN 13201-3 road field: three rows per lane, longitudinal step no more than 3 m. */
function roadGrid(r: Receiver, lanes: number): MeasureGrid {
  return {
    ...r,
    nu: Math.min(ROAD_GRID_MAX_AXIS, Math.max(1, Math.ceil(len(r.u) / ROAD_GRID_STEP))),
    nv: Math.round(3 * lanes * GRID_DENSITY),
  };
}

export function buildScene(p: SceneParams): BuiltScene {
  const boxes: SceneBox[] = [];
  const lamps: SceneLamp[] = [];
  const rot = luminaireRotation(p.rotation * DEG, p.tilt * DEG);

  switch (p.scene) {
    case 'open': {
      const grid = p.count >= 9 ? 3 : 1;
      const cols = p.count >= 9 ? 3 : p.count;
      for (const y of rowPositions(grid, p.spacing)) {
        for (const x of rowPositions(cols, p.spacing)) lamps.push({ position: [x, y, p.height], rotation: rot });
      }
      if (p.showFigure) figure([1.4, -0.9, 0], boxes);
      const extent = 2 * (Math.max(8, p.height * 2.2) + (Math.max(cols, grid) - 1) * p.spacing * 0.5);
      const ground: Receiver = { origin: [-extent, -extent, 0], u: [2 * extent, 0, 0], v: [0, 2 * extent, 0], normal: [0, 0, 1] };
      return {
        boxes,
        lamps,
        ground: 1,
        outdoor: true,
        gridLines: true,
        view: {
          target: [0, 0, Math.min(1.2, p.height * 0.4)],
          yaw: -32 * DEG,
          pitch: 30 * DEG,
          distance: Math.max(9, p.height * 2.3 + (cols - 1) * p.spacing * 0.6),
        },
        limits: { minPitch: 3 * DEG, maxDistance: 140 },
        receivers: [ground],
        grids: [fixedGrid(ground, OPEN_GRID_STEP, OPEN_GRID_MAX_AXIS)],
        floorZ: 0,
      };
    }

    case 'street': {
      const sidewalkMaxY = ROAD_HALF_WIDTH + SIDEWALK_WIDTH;
      boxes.push(
        box([-400, ROAD_HALF_WIDTH, 0], [400, sidewalkMaxY, CURB], MAT.SIDEWALK),
        box([-400, -sidewalkMaxY, 0], [400, -ROAD_HALF_WIDTH, CURB], MAT.SIDEWALK),
        box([-400, sidewalkMaxY, 0], [400, sidewalkMaxY + VERGE_WIDTH, VERGE_TOP], MAT.GRASS, false),
        box([-400, -(sidewalkMaxY + VERGE_WIDTH), 0], [400, -sidewalkMaxY, VERGE_TOP], MAT.GRASS, false),
      );
      const poleY = ROAD_HALF_WIDTH + POLE_OFFSET;
      const lampY = poleY - ARM_OVERHANG;
      const addPole = (x: number, side: 1 | -1) => {
        const py = -side * poleY;
        const ly = -side * lampY;
        boxes.push(box([x - 0.07, py - 0.07, CURB], [x + 0.07, py + 0.07, p.height + 0.16], MAT.METAL));
        boxes.push(box([x - 0.04, Math.min(py, ly), p.height + 0.07], [x + 0.04, Math.max(py, ly), p.height + 0.14], MAT.METAL, false));
        const r = side === 1 ? rot : luminaireRotation(p.rotation * DEG, p.tilt * DEG, Math.PI);
        lamps.push({ position: [x, ly, p.height], rotation: r });
      };
      const xs = rowPositions(p.count, p.spacing);
      for (const x of xs) addPole(x, 1);
      if (p.streetLayout === 'opposite') for (const x of xs) addPole(x, -1);
      if (p.streetLayout === 'staggered') for (const x of xs) addPole(x + p.spacing / 2, -1);
      if (p.showFigure) figure([2.2, -(ROAD_HALF_WIDTH + 1.6), CURB], boxes);
      const halfLength = Math.max(20, (p.count * p.spacing) / 2 + p.height * 2);
      const road: Receiver = { origin: [-halfLength, -ROAD_HALF_WIDTH, 0], u: [2 * halfLength, 0, 0], v: [0, 2 * ROAD_HALF_WIDTH, 0], normal: [0, 0, 1] };
      const columns = roadGrid(road, 2).nu;
      const walk = (y0: number): MeasureGrid => ({
        origin: [-halfLength, y0, CURB],
        u: [2 * halfLength, 0, 0],
        v: [0, SIDEWALK_WIDTH, 0],
        normal: [0, 0, 1],
        nu: columns,
        nv: Math.round(3 * GRID_DENSITY),
      });
      const verge = (y0: number): MeasureGrid => ({
        origin: [-halfLength, y0, VERGE_TOP],
        u: [2 * halfLength, 0, 0],
        v: [0, VERGE_WIDTH, 0],
        normal: [0, 0, 1],
        nu: columns,
        nv: Math.round(4 * GRID_DENSITY),
      });
      return {
        boxes,
        lamps,
        ground: 2,
        outdoor: true,
        gridLines: false,
        view: {
          target: [0, 0, 1.2],
          yaw: 58 * DEG,
          pitch: 20 * DEG,
          distance: Math.max(20, p.height * 2.6 + (p.count - 1) * p.spacing * 0.45),
        },
        limits: { minPitch: 2 * DEG, maxDistance: 200 },
        receivers: [
          road,
          { origin: [-halfLength, -sidewalkMaxY, CURB], u: [2 * halfLength, 0, 0], v: [0, SIDEWALK_WIDTH, 0], normal: [0, 0, 1] },
        ],
        grids: [
          roadGrid(road, 2),
          walk(-sidewalkMaxY),
          walk(ROAD_HALF_WIDTH),
          verge(-(sidewalkMaxY + VERGE_WIDTH)),
          verge(sidewalkMaxY),
        ],
        floorZ: 0,
      };
    }

    case 'wall': {
      const d = p.wallDistance;
      const wallHeight = Math.max(5, p.height + 2);
      boxes.push(box([-16, d, 0], [16, d + 0.3, wallHeight], p.wallFinish === 'brick' ? MAT.BRICK : MAT.PLASTER));
      for (const x of rowPositions(p.count, p.spacing)) lamps.push({ position: [x, 0, p.height], rotation: rot });
      if (p.showFigure) figure([Math.max(1.6, ((p.count - 1) * p.spacing) / 2 + 1.2), Math.max(-1.4, d - 0.9), 0], boxes);
      const halfWidth = Math.max(6, (p.count * p.spacing) / 2 + 3);
      const wallFace: Receiver = { origin: [-halfWidth, d, 0], u: [2 * halfWidth, 0, 0], v: [0, 0, wallHeight], normal: [0, -1, 0] };
      const front: Receiver = { origin: [-halfWidth, d - 6, 0], u: [2 * halfWidth, 0, 0], v: [0, 6, 0], normal: [0, 0, 1] };
      return {
        boxes,
        lamps,
        ground: 1,
        outdoor: true,
        // The washer is close to the wall, so the usual night key lifts the
        // bounced light above the lamp until it looks directly lit.
        keyLux: 200,
        gridLines: true,
        view: {
          target: [0, d, Math.min(2, wallHeight / 2)],
          yaw: -22 * DEG,
          pitch: 14 * DEG,
          distance: Math.max(8, halfWidth * 1.35),
        },
        limits: { minPitch: 2 * DEG, maxDistance: 80 },
        receivers: [wallFace, front],
        grids: [normGrid(wallFace), normGrid(front)],
        floorZ: 0,
      };
    }

    case 'room':
    default: {
      const H = p.ceilingHeight;
      const hw = ROOM_W / 2;
      const hd = ROOM_D / 2;
      const t = 0.2;
      const cut = (point: Vec3, inward: Vec3): SceneBox['cutaway'] => ({ point, inward });
      boxes.push(
        box([-hw - t, -hd - t, -t], [hw + t, hd + t, 0], MAT.WOOD_FLOOR),
        { ...box([-hw - t, -hd - t, H], [hw + t, hd + t, H + t], MAT.CEILING), cutaway: cut([0, 0, H], [0, 0, -1]) },
        { ...box([-hw - t, -hd - t, 0], [-hw, hd + t, H], MAT.PLASTER), cutaway: cut([-hw, 0, 0], [1, 0, 0]) },
        { ...box([hw, -hd - t, 0], [hw + t, hd + t, H], MAT.PLASTER), cutaway: cut([hw, 0, 0], [-1, 0, 0]) },
        { ...box([-hw, -hd - t, 0], [hw, -hd, H], MAT.PLASTER), cutaway: cut([0, -hd, 0], [0, 1, 0]) },
        { ...box([-hw, hd, 0], [hw, hd + t, H], MAT.PLASTER), cutaway: cut([0, hd, 0], [0, -1, 0]) },
      );
      // Table with legs, a sideboard and a sofa block.
      const tx = 0.4;
      const ty = 0.1;
      boxes.push(box([tx - 0.9, ty - 0.45, 0.72], [tx + 0.9, ty + 0.45, 0.76], MAT.WOOD));
      for (const [lx, ly] of [
        [-0.82, -0.37],
        [0.77, -0.37],
        [-0.82, 0.32],
        [0.77, 0.32],
      ]) {
        boxes.push(box([tx + lx, ty + ly, 0], [tx + lx + 0.05, ty + ly + 0.05, 0.72], MAT.WOOD));
      }
      boxes.push(box([-hw + 0.3, hd - 0.46, 0], [-hw + 2.4, hd, 0.82], MAT.WHITE));
      boxes.push(box([-hw, -hd + 0.4, 0], [-hw + 0.9, -hd + 2.6, 0.42], MAT.FABRIC));
      boxes.push(box([-hw, -hd + 0.4, 0.42], [-hw + 0.25, -hd + 2.6, 0.85], MAT.FABRIC));

      const layouts: Record<number, [number, number]> = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2] };
      const [cols, rows] = layouts[p.count] ?? [1, 1];
      const z = Math.min(p.height, roomMountLimit(p));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = (c - (cols - 1) / 2) * (ROOM_W / cols);
          const y = (r - (rows - 1) / 2) * (ROOM_D / rows);
          lamps.push({ position: [x, y, z], rotation: rot });
          const top = applyMat3(rot, [0, 0, 1]);
          const anchor: Vec3 = [x + top[0] * 0.07, y + top[1] * 0.07, z + 0.07];
          if (anchor[2] < H) {
            boxes.push(box([anchor[0] - 0.006, anchor[1] - 0.006, anchor[2]], [anchor[0] + 0.006, anchor[1] + 0.006, H], MAT.METAL, false));
          }
        }
      }
      if (p.showFigure) figure([1.9, -1.2, 0], boxes);
      // Floor and all four walls; the ones facing away from the camera are culled when drawn.
      const roomSurfaces: Receiver[] = [
        { origin: [-hw, -hd, 0], u: [ROOM_W, 0, 0], v: [0, ROOM_D, 0], normal: [0, 0, 1] },
        { origin: [-hw, hd, 0], u: [ROOM_W, 0, 0], v: [0, 0, H], normal: [0, -1, 0] },
        { origin: [-hw, -hd, 0], u: [ROOM_W, 0, 0], v: [0, 0, H], normal: [0, 1, 0] },
        { origin: [-hw, -hd, 0], u: [0, ROOM_D, 0], v: [0, 0, H], normal: [1, 0, 0] },
        { origin: [hw, -hd, 0], u: [0, ROOM_D, 0], v: [0, 0, H], normal: [-1, 0, 0] },
      ];
      return {
        boxes,
        lamps,
        ground: 0,
        outdoor: false,
        gridLines: false,
        view: { target: [0, 0, 1.1], yaw: 28 * DEG, pitch: 38 * DEG, distance: 12.5 },
        limits: { minPitch: 2 * DEG, maxDistance: 40 },
        receivers: [
          { origin: [-hw, -hd, 0], u: [ROOM_W, 0, 0], v: [0, ROOM_D, 0], normal: [0, 0, 1] },
          { origin: [-hw, hd, 0], u: [ROOM_W, 0, 0], v: [0, 0, H], normal: [0, -1, 0] },
          { origin: [-hw, -hd, 0], u: [0, ROOM_D, 0], v: [0, 0, H], normal: [1, 0, 0] },
          { origin: [-hw, -hd, H], u: [ROOM_W, 0, 0], v: [0, ROOM_D, 0], normal: [0, 0, -1] },
        ],
        grids: roomSurfaces.map(normGrid),
        floorZ: 0,
      };
    }
  }
}

/** Default luminaire orientation per scene, aiming asymmetric throw toward the road / wall. */
export function autoRotation(scene: SceneId, throwAngle: number, asymmetry: number): number {
  const asymmetric = asymmetry > 0.12;
  let r = 0;
  if (scene === 'street') r = asymmetric ? -throwAngle : -90;
  if (scene === 'wall') r = asymmetric ? -throwAngle : 0;
  r = ((r % 360) + 540) % 360 - 180;
  return Math.round(r);
}

/** Illuminance on the receivers ignoring occlusion; used for exposure and the false-color scale. */
export function estimateIlluminance(scene: BuiltScene, candela: (c: number, g: number) => number): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  let count = 0;
  const N = 28;
  for (const r of scene.receivers) {
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const s = i / N;
        const t = j / N;
        const p: Vec3 = [
          r.origin[0] + r.u[0] * s + r.v[0] * t,
          r.origin[1] + r.u[1] * s + r.v[1] * t,
          r.origin[2] + r.u[2] * s + r.v[2] * t,
        ];
        let E = 0;
        for (const lamp of scene.lamps) {
          const dx = p[0] - lamp.position[0];
          const dy = p[1] - lamp.position[1];
          const dz = p[2] - lamp.position[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          const d = Math.sqrt(d2);
          if (d < 0.05) continue;
          const cosI = -(r.normal[0] * dx + r.normal[1] * dy + r.normal[2] * dz) / d;
          if (cosI <= 0) continue;
          const m = lamp.rotation;
          const lx = (m[0] * dx + m[1] * dy + m[2] * dz) / d;
          const ly = (m[3] * dx + m[4] * dy + m[5] * dz) / d;
          const lz = (m[6] * dx + m[7] * dy + m[8] * dz) / d;
          const g = Math.acos(Math.max(-1, Math.min(1, -lz))) / DEG;
          let c = Math.atan2(-lx, ly) / DEG;
          if (c < 0) c += 360;
          E += (candela(c, g) * cosI) / d2;
        }
        if (E > max) max = E;
        if (E > 0) {
          sum += E;
          count++;
        }
      }
    }
  }
  return { max, mean: count ? sum / count : 0 };
}

/** JS-side occlusion test used for the glare term (camera -> lamp visibility). */
export function segmentBlocked(scene: BuiltScene, from: Vec3, to: Vec3): boolean {
  const dir: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  for (const b of scene.boxes) {
    if (!b.castsShadow) continue;
    let t0 = 0;
    let t1 = 0.995;
    let hit = true;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-9) {
        if (from[a] < b.min[a] || from[a] > b.max[a]) {
          hit = false;
          break;
        }
        continue;
      }
      let ta = (b.min[a] - from[a]) / dir[a];
      let tb = (b.max[a] - from[a]) / dir[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}
