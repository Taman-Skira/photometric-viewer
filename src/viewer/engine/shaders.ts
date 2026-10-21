import { MAX_BOXES, MAX_LAMPS } from './scenes';

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Progressive path tracer over analytic primitives (ground plane + AABBs).
 * Ported from taman-frontend's WGSL tracer: PCG RNG, GGX/Lambert BSDF, NEE
 * with Li = candela / r^2 and IES lookup in the Type C lamp frame
 * (gamma = acos(-z), C = atan2(-x, y)).
 *
 * Output 0: running mean of radiance (cd/m^2, since candela / m^2 = lux).
 * Output 1: running mean of (illuminance at the primary hit, hit coverage, primary hit distance).
 *
 * With PROBE defined, each fragment is a measurement point instead of a pixel
 * and output 0 accumulates the illuminance on that point.
 */
export const TRACE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

#define MAX_BOXES ${MAX_BOXES}
#define MAX_LAMPS ${MAX_LAMPS}
#define PI 3.14159265358979
#define INV_PI 0.31830988618379
#define EPS 1.0e-3
#define FAR 1.0e20

#define MAT_CONCRETE 0
#define MAT_STREET 1
#define MAT_SIDEWALK 2
#define MAT_PLASTER 3
#define MAT_BRICK 4
#define MAT_WOOD_FLOOR 5
#define MAT_CEILING 6
#define MAT_METAL 7
#define MAT_WOOD 8
#define MAT_FABRIC 9
#define MAT_FIGURE 10
#define MAT_WHITE 11
#define MAT_GRASS 12

uniform vec2 uResolution;
uniform uint uFrame;
uniform float uBlend;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform sampler2D uPrevColor;
uniform sampler2D uPrevLux;

uniform sampler2D uIes;
uniform vec2 uIesSize;
uniform float uIesScale;
uniform vec3 uLightTint;
uniform int uLampCount;
uniform vec3 uLampPos[MAX_LAMPS];
uniform mat3 uLampRot[MAX_LAMPS];
uniform float uLampGlare[MAX_LAMPS];
uniform vec2 uLumHalf;
uniform int uLumRound;
uniform vec3 uHousingHalf;

uniform int uBoxCount;
uniform vec3 uBoxMin[MAX_BOXES];
uniform vec3 uBoxMax[MAX_BOXES];
uniform vec4 uBoxInfo[MAX_BOXES];
uniform int uGround;
uniform float uGridLines;
uniform float uRoadHalf;

uniform int uMaxBounces;
uniform float uOutdoor;
uniform float uSkyScale;
uniform float uAmbient;
uniform float uHaze;
uniform float uGlare;
uniform float uClamp;
uniform float uTintLuma;

#define LUMA vec3(0.2126, 0.7152, 0.0722)

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outLux;

// ---------- RNG (PCG, as in pathtrace.wgsl) ----------
uint gSeed;
uint pcgHash(inout uint s) {
  uint state = s * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  s = word;
  return (word >> 22u) ^ word;
}
float rnd() { return float(pcgHash(gSeed)) * (1.0 / 4294967296.0); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.7 + 13.1) + 0.2 * vnoise(p * 7.3 + 5.7); }

// ---------- IES ----------
float iesCandela(int li, vec3 dirFromLamp) {
  vec3 l = transpose(uLampRot[li]) * dirFromLamp;
  float el = acos(clamp(-l.z, -1.0, 1.0));
  float az = atan(-l.x, l.y);
  if (az < 0.0) az += 2.0 * PI;
  vec2 uv = vec2(az / (2.0 * PI) + 0.5 / uIesSize.x, (el / PI * (uIesSize.y - 1.0) + 0.5) / uIesSize.y);
  return textureLod(uIes, uv, 0.0).r * uIesScale;
}

vec3 sampleEmitterLocal() {
  float u1 = rnd();
  float u2 = rnd();
  if (uLumRound == 1) {
    float r = sqrt(u1) * uLumHalf.x;
    float a = 2.0 * PI * u2;
    return vec3(r * cos(a), r * sin(a), 0.0);
  }
  return vec3((u1 * 2.0 - 1.0) * uLumHalf.x, (u2 * 2.0 - 1.0) * uLumHalf.y, 0.0);
}

// ---------- Geometry ----------
vec3 safeInv(vec3 d) {
  return 1.0 / vec3(abs(d.x) < 1e-9 ? 1e-9 : d.x, abs(d.y) < 1e-9 ? 1e-9 : d.y, abs(d.z) < 1e-9 ? 1e-9 : d.z);
}

vec2 slabs(vec3 ro, vec3 inv, vec3 bmin, vec3 bmax) {
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 ts = min(t0, t1);
  vec3 tb = max(t0, t1);
  return vec2(max(max(ts.x, ts.y), ts.z), min(min(tb.x, tb.y), tb.z));
}

vec3 boxNormal(vec3 p, vec3 bmin, vec3 bmax) {
  vec3 c = 0.5 * (bmin + bmax);
  vec3 h = max(0.5 * (bmax - bmin), vec3(1e-5));
  vec3 d = (p - c) / h;
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) return vec3(sign(d.x), 0.0, 0.0);
  if (a.y >= a.z) return vec3(0.0, sign(d.y), 0.0);
  return vec3(0.0, 0.0, sign(d.z));
}

struct Hit { float t; vec3 n; int mat; };

Hit traceScene(vec3 ro, vec3 rd, bool primary) {
  Hit h;
  h.t = FAR;
  h.mat = -1;
  h.n = vec3(0.0, 0.0, 1.0);
  if (uGround > 0 && rd.z < 0.0 && ro.z > 0.0) {
    h.t = -ro.z / rd.z;
    h.mat = uGround == 2 ? MAT_STREET : MAT_CONCRETE;
  }
  vec3 inv = safeInv(rd);
  int best = -1;
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= uBoxCount) break;
    vec4 info = uBoxInfo[i];
    if (primary && info.z > 0.5) continue;
    vec2 tt = slabs(ro, inv, uBoxMin[i], uBoxMax[i]);
    if (tt.x <= tt.y && tt.y > EPS) {
      float t = tt.x > EPS ? tt.x : tt.y;
      if (t < h.t) {
        h.t = t;
        best = i;
      }
    }
  }
  if (best >= 0) {
    h.mat = int(uBoxInfo[best].x + 0.5);
    h.n = boxNormal(ro + rd * h.t, uBoxMin[best], uBoxMax[best]);
  }
  return h;
}

bool occluded(vec3 ro, vec3 rd, float tMax) {
  vec3 inv = safeInv(rd);
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= uBoxCount) break;
    if (uBoxInfo[i].y < 0.5) continue;
    vec2 tt = slabs(ro, inv, uBoxMin[i], uBoxMax[i]);
    if (tt.x <= tt.y && tt.y > EPS && tt.x < tMax) return true;
  }
  return false;
}

// ---------- Materials ----------
struct Mat { vec3 albedo; float rough; float metal; };

Mat makeMat(vec3 a, float r, float m) { Mat o; o.albedo = a; o.rough = r; o.metal = m; return o; }

float gridLine(float x, float w) {
  float d = abs(fract(x + 0.5) - 0.5);
  return 1.0 - smoothstep(w * 0.5, w, d);
}

Mat material(int id, vec3 p, inout vec3 n) {
  if (id == MAT_CONCRETE) {
    float v = 0.82 + 0.3 * fbm(p.xy * 1.7) + 0.08 * vnoise(p.xy * 40.0);
    vec3 a = vec3(0.30, 0.295, 0.285) * v;
    if (uGridLines > 0.5 && n.z > 0.5) {
      float g1 = max(gridLine(p.x, 0.012), gridLine(p.y, 0.012));
      float g5 = max(gridLine(p.x / 5.0, 0.006), gridLine(p.y / 5.0, 0.006));
      a *= 1.0 - 0.35 * g1 - 0.35 * g5;
    }
    return makeMat(a, 0.9, 0.0);
  }
  if (id == MAT_STREET) {
    float ay = abs(p.y);
    if (ay < uRoadHalf) {
      float grain = 0.75 + 0.35 * fbm(p.xy * 3.0) + 0.25 * vnoise(p.xy * 60.0);
      vec3 a = vec3(0.075, 0.075, 0.08) * grain;
      bool dash = ay < 0.06 && mod(p.x + 1.5, 9.0) < 3.0;
      bool edge = abs(ay - (uRoadHalf - 0.3)) < 0.06;
      if (dash || edge) a = vec3(0.55, 0.55, 0.52) * (0.85 + 0.15 * vnoise(p.xy * 30.0));
      return makeMat(a, 0.8, 0.0);
    }
    float g = 0.6 + 0.8 * fbm(p.xy * 2.3);
    return makeMat(vec3(0.035, 0.06, 0.025) * g, 1.0, 0.0);
  }
  if (id == MAT_SIDEWALK) {
    if (n.z < 0.5) return makeMat(vec3(0.36, 0.355, 0.34), 0.9, 0.0);
    vec2 tile = p.xy / 0.5;
    vec2 cell = floor(tile);
    vec2 f = fract(tile);
    float joint = step(min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)), 0.018);
    float v = 0.85 + 0.25 * hash12(cell) + 0.1 * vnoise(p.xy * 25.0);
    vec3 a = mix(vec3(0.27, 0.26, 0.245) * v, vec3(0.12), joint);
    return makeMat(a, 0.85, 0.0);
  }
  if (id == MAT_PLASTER) {
    return makeMat(vec3(0.74, 0.72, 0.68) * (0.96 + 0.06 * fbm(p.xz * 3.0 + p.y)), 0.95, 0.0);
  }
  if (id == MAT_BRICK) {
    if (abs(n.y) < 0.5) return makeMat(vec3(0.42, 0.4, 0.37), 0.9, 0.0);
    float bw = 0.225;
    float bh = 0.075;
    float row = floor(p.z / bh);
    float x = p.x / bw + 0.5 * mod(row, 2.0);
    float col = floor(x);
    vec2 f = vec2(fract(x) * bw, fract(p.z / bh) * bh);
    float mortar = 0.01;
    vec2 q = f - vec2(mortar);
    vec2 size = vec2(bw, bh) - vec2(mortar);
    if (q.x < 0.0 || q.y < 0.0) {
      return makeMat(vec3(0.46, 0.44, 0.40) * (0.9 + 0.2 * vnoise(p.xz * 80.0)), 1.0, 0.0);
    }
    float bevel = 0.007;
    float gx = -max(0.0, 1.0 - q.x / bevel) + max(0.0, 1.0 - (size.x - q.x) / bevel);
    float gz = -max(0.0, 1.0 - q.y / bevel) + max(0.0, 1.0 - (size.y - q.y) / bevel);
    float rough = vnoise(p.xz * 90.0) - 0.5;
    n = normalize(n + vec3(gx * 0.9 + rough * 0.25, 0.0, gz * 0.9 + (vnoise(p.xz * 70.0 + 3.1) - 0.5) * 0.25));
    float h = hash12(vec2(col, row));
    vec3 a = mix(vec3(0.32, 0.12, 0.07), vec3(0.42, 0.2, 0.12), h) * (0.8 + 0.35 * vnoise(p.xz * 30.0));
    return makeMat(a, 0.95, 0.0);
  }
  if (id == MAT_WOOD_FLOOR) {
    if (n.z < 0.5) return makeMat(vec3(0.2, 0.15, 0.1), 0.8, 0.0);
    float pw = 0.19;
    float row = floor(p.y / pw);
    float x = p.x / 1.35 + hash12(vec2(row, 3.0));
    float plank = floor(x);
    float fy = fract(p.y / pw);
    float fx = fract(x);
    float seam = step(min(fy, 1.0 - fy), 0.02) + step(min(fx, 1.0 - fx), 0.004);
    float h = hash12(vec2(plank, row));
    float grain = 0.9 + 0.1 * sin(p.x * 55.0 + 6.0 * vnoise(vec2(p.x * 2.0, p.y * 40.0)));
    vec3 a = mix(vec3(0.36, 0.23, 0.13), vec3(0.5, 0.35, 0.21), h) * grain;
    a = mix(a, vec3(0.1, 0.07, 0.05), clamp(seam, 0.0, 1.0));
    return makeMat(a, 0.42, 0.0);
  }
  if (id == MAT_CEILING) return makeMat(vec3(0.82), 0.95, 0.0);
  if (id == MAT_METAL) return makeMat(vec3(0.16, 0.165, 0.17), 0.45, 0.35);
  if (id == MAT_WOOD) return makeMat(vec3(0.3, 0.18, 0.1) * (0.9 + 0.2 * vnoise(p.xy * vec2(3.0, 30.0))), 0.4, 0.0);
  if (id == MAT_FABRIC) return makeMat(vec3(0.16, 0.19, 0.2), 1.0, 0.0);
  if (id == MAT_FIGURE) return makeMat(vec3(0.52, 0.52, 0.54), 0.7, 0.0);
  if (id == MAT_GRASS) {
    float g = 0.7 + 0.5 * fbm(p.xy * 1.6) + 0.15 * vnoise(p.xy * 14.0);
    return makeMat(vec3(0.11, 0.22, 0.06) * g, 1.0, 0.0);
  }
  return makeMat(vec3(0.72, 0.72, 0.7), 0.55, 0.0);
}

// ---------- BSDF (from pathtrace.wgsl) ----------
mat3 tangentFrame(vec3 n) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float b = n.x * n.y * a;
  vec3 t = vec3(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  vec3 bb = vec3(b, s + n.y * n.y * a, -n.y);
  return mat3(t, bb, n);
}

float ggxD(float NdotH, float a2) {
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(1e-8, PI * d * d);
}

float smithG(float NdotL, float NdotV, float a2) {
  float gl = NdotV * sqrt(a2 + (1.0 - a2) * NdotL * NdotL);
  float gv = NdotL * sqrt(a2 + (1.0 - a2) * NdotV * NdotV);
  return 2.0 * NdotL * NdotV / max(1e-8, gl + gv);
}

vec3 fresnel(float c, vec3 F0) { return F0 + (1.0 - F0) * pow(max(1.0 - c, 0.0), 5.0); }

float specProb(Mat m) {
  vec3 F0 = mix(vec3(0.04), m.albedo, m.metal);
  return clamp(0.5 * (1.0 - (1.0 - m.metal) * (1.0 - dot(F0, vec3(0.333)))), 0.1, 0.9);
}

// Returns f * NdotL; pdf of the mixture sampler in 'pdf'.
vec3 evalBsdf(vec3 N, vec3 V, vec3 L, Mat m, out float pdf) {
  pdf = 0.0;
  float NdotL = dot(N, L);
  float NdotV = dot(N, V);
  if (NdotL <= 0.0 || NdotV <= 0.0) return vec3(0.0);
  float a = max(0.04, m.rough) * max(0.04, m.rough);
  float a2 = a * a;
  vec3 H = normalize(L + V);
  float NdotH = clamp(dot(N, H), 0.0, 1.0);
  float VdotH = clamp(dot(V, H), 0.0, 1.0);
  vec3 F0 = mix(vec3(0.04), m.albedo, m.metal);
  vec3 F = fresnel(VdotH, F0);
  float D = ggxD(NdotH, a2);
  float G = smithG(NdotL, NdotV, a2);
  vec3 spec = (D * G * F) / max(1e-8, 4.0 * NdotL * NdotV);
  vec3 diff = (1.0 - F) * (1.0 - m.metal) * m.albedo * INV_PI;
  float ps = specProb(m);
  pdf = (1.0 - ps) * NdotL * INV_PI + ps * (D * NdotH) / max(1e-8, 4.0 * VdotH);
  return (diff + spec) * NdotL;
}

vec3 sampleGGXVNDF(vec3 Vl, float a, float u1, float u2) {
  vec3 Vh = normalize(vec3(a * Vl.x, a * Vl.y, Vl.z));
  float lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  vec3 T1 = lensq > 0.0 ? vec3(-Vh.y, Vh.x, 0.0) * inversesqrt(lensq) : vec3(1.0, 0.0, 0.0);
  vec3 T2 = cross(Vh, T1);
  float r = sqrt(u1);
  float phi = 2.0 * PI * u2;
  float t1 = r * cos(phi);
  float t2 = r * sin(phi);
  float s = 0.5 * (1.0 + Vh.z);
  t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * t2;
  vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3(a * Nh.x, a * Nh.y, max(0.0, Nh.z)));
}

bool sampleBsdf(vec3 N, vec3 V, Mat m, out vec3 L, out vec3 weight, out float pdfOut) {
  pdfOut = 0.0;
  float a = max(0.04, m.rough) * max(0.04, m.rough);
  mat3 frame = tangentFrame(N);
  float u0 = rnd();
  float u1 = rnd();
  float u2 = rnd();
  if (u0 < specProb(m)) {
    vec3 H = frame * sampleGGXVNDF(transpose(frame) * V, a, u1, u2);
    L = reflect(-V, H);
    if (dot(N, L) <= 0.0) return false;
  } else {
    float r = sqrt(u1);
    float phi = 2.0 * PI * u2;
    L = frame * vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
  }
  float pdf;
  vec3 f = evalBsdf(N, V, L, m, pdf);
  if (pdf <= 1e-8) return false;
  weight = f / pdf;
  pdfOut = pdf;
  return true;
}

// ---------- Lights ----------
vec3 directLight(vec3 p, vec3 N, vec3 V, Mat m, out float E) {
  E = 0.0;
  vec3 sum = vec3(0.0);
  for (int li = 0; li < MAX_LAMPS; li++) {
    if (li >= uLampCount) break;
    vec3 sp = uLampPos[li] + uLampRot[li] * sampleEmitterLocal();
    vec3 toL = sp - p;
    float d2 = dot(toL, toL);
    float d = sqrt(d2);
    vec3 wi = toL / max(d, 1e-6);
    float NdotL = dot(N, wi);
    if (NdotL <= 0.0) continue;
    float I = iesCandela(li, -wi);
    if (I <= 0.0) continue;
    if (occluded(p + N * EPS, wi, d - 2.0 * EPS)) continue;
    float En = I / max(d2, 1e-4);
    E += En * NdotL;
    float pdf;
    sum += evalBsdf(N, V, wi, m, pdf) * En;
  }
  return sum * uLightTint;
}

// Primary-ray hit test against the luminaire housings. part: 1 = luminous face, 2 = housing.
float hitLuminaires(vec3 ro, vec3 rd, float tMax, out int lamp, out int part, out vec3 nW) {
  float best = tMax;
  lamp = -1;
  part = 0;
  nW = vec3(0.0, 0.0, 1.0);
  vec3 hmin = vec3(-uHousingHalf.x, -uHousingHalf.y, 0.0);
  vec3 hmax = vec3(uHousingHalf.x, uHousingHalf.y, uHousingHalf.z * 2.0);
  for (int li = 0; li < MAX_LAMPS; li++) {
    if (li >= uLampCount) break;
    mat3 Rt = transpose(uLampRot[li]);
    vec3 o = Rt * (ro - uLampPos[li]);
    vec3 d = Rt * rd;
    vec2 tt = slabs(o, safeInv(d), hmin, hmax);
    if (tt.x <= tt.y && tt.x > EPS && tt.x < best) {
      best = tt.x;
      lamp = li;
      vec3 lp = o + d * tt.x;
      vec3 ln = boxNormal(lp, hmin, hmax);
      bool inside = uLumRound == 1 ? length(lp.xy) <= uLumHalf.x : (abs(lp.x) <= uLumHalf.x && abs(lp.y) <= uLumHalf.y);
      part = (ln.z < -0.5 && inside) ? 1 : 2;
      nW = uLampRot[li] * ln;
    }
  }
  return best;
}

float henyeyGreenstein(float c, float g) {
  float d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (4.0 * PI * d * sqrt(d));
}

// Single scattering in a homogeneous medium, equiangular sampling per lamp.
vec3 hazeInscatter(vec3 ro, vec3 rd, float tMax) {
  vec3 sum = vec3(0.0);
  for (int li = 0; li < MAX_LAMPS; li++) {
    if (li >= uLampCount) break;
    vec3 lp = uLampPos[li];
    float delta = dot(lp - ro, rd);
    float D = max(length(ro + rd * delta - lp), 1e-3);
    float thA = atan(-delta, D);
    float thB = atan(tMax - delta, D);
    float ang = mix(thA, thB, rnd());
    float t = delta + D * tan(clamp(ang, -1.5707, 1.5707));
    if (!(t >= 0.0 && t <= tMax)) continue;
    float pdf = D / max(1e-6, (thB - thA) * (D * D + (t - delta) * (t - delta)));
    vec3 x = ro + rd * t;
    vec3 toL = lp - x;
    float d2 = dot(toL, toL);
    float d = sqrt(d2);
    vec3 wi = toL / max(d, 1e-6);
    float I = iesCandela(li, -wi);
    if (I <= 0.0) continue;
    if (occluded(x, wi, d - 0.05)) continue;
    float tr = exp(-uHaze * (t + d));
    sum += I / max(d2, 1e-3) * henyeyGreenstein(dot(wi, rd), 0.35) * uHaze * tr / pdf;
  }
  return sum * uLightTint;
}

vec3 sky(vec3 rd) {
  if (uOutdoor < 0.5) return vec3(0.0);
  float h = clamp(rd.z, 0.0, 1.0);
  vec3 c = mix(vec3(0.030, 0.038, 0.060), vec3(0.004, 0.006, 0.014), pow(h, 0.45));
  vec2 sp = rd.xy / (rd.z + 1.0) * 180.0;
  float star = step(0.9965, hash12(floor(sp))) * smoothstep(0.08, 0.35, h);
  return (c + star * vec3(0.5, 0.55, 0.65) * hash12(floor(sp) + 7.0)) * uSkyScale;
}

#ifdef PROBE
uniform sampler2D uProbePos;
uniform sampler2D uProbeNrm;
uniform sampler2D uPrevProbe;
uniform int uProbeSamples;

// Same estimator as the primary-hit illuminance in the camera pass, starting
// from a point and a normal instead of a camera ray.
float probeIrradiance(vec3 p, vec3 N) {
  float E;
  directLight(p, N, N, makeMat(vec3(0.0), 1.0, 0.0), E);
  float u1 = rnd();
  float phi = 2.0 * PI * rnd();
  float r = sqrt(u1);
  vec3 rd = tangentFrame(N) * vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
  vec3 ro = p + N * EPS;
  // Cosine sampling, so cos / pdf = PI.
  vec3 irrWeight = vec3(PI);
  for (int bounce = 1; bounce < 6; bounce++) {
    if (bounce >= uMaxBounces) break;
    Hit h = traceScene(ro, rd, false);
    if (h.mat < 0) break;
    vec3 hp = ro + rd * h.t;
    vec3 n = h.n;
    if (dot(n, rd) > 0.0) n = -n;
    vec3 geomN = n;
    Mat m = material(h.mat, hp, n);
    if (dot(n, rd) > 0.0) n = geomN;
    vec3 V = -rd;
    float En;
    vec3 Ld = directLight(hp, n, V, m, En);
    vec3 c = irrWeight * INV_PI * Ld;
    float mx = max(c.r, max(c.g, c.b));
    float k = mx > uClamp ? uClamp / mx : 1.0;
    E += dot(irrWeight * Ld * k, LUMA) / uTintLuma;
    vec3 L;
    vec3 w;
    float pdf;
    if (!sampleBsdf(n, V, m, L, w, pdf)) break;
    irrWeight *= w;
    if (bounce >= 2) {
      float q = clamp(max(irrWeight.r, max(irrWeight.g, irrWeight.b)) * INV_PI, 0.05, 0.95);
      if (rnd() > q) break;
      irrWeight /= q;
    }
    ro = hp + geomN * EPS;
    rd = L;
  }
  return E;
}

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  gSeed = uint(pix.x) + uint(pix.y) * 1973u + uFrame * 9277u + 11u;
  pcgHash(gSeed);
  pcgHash(gSeed);
  vec3 p = texelFetch(uProbePos, pix, 0).xyz;
  vec3 N = texelFetch(uProbeNrm, pix, 0).xyz;
  float sum = 0.0;
  for (int s = 0; s < 32; s++) {
    if (s >= uProbeSamples) break;
    sum += probeIrradiance(p, N);
  }
  float E = sum / float(max(uProbeSamples, 1));
  if (isnan(E) || isinf(E)) E = 0.0;
  float prev = uBlend >= 1.0 ? 0.0 : texelFetch(uPrevProbe, pix, 0).x;
  outColor = vec4(mix(prev, E, uBlend), 0.0, 0.0, 1.0);
  outLux = vec4(0.0);
}
#else
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  gSeed = uint(pix.x) + uint(pix.y) * 1973u + uFrame * 9277u + 7u;
  pcgHash(gSeed);
  pcgHash(gSeed);

  vec2 ndc = (gl_FragCoord.xy - 0.5 + vec2(rnd(), rnd())) / uResolution * 2.0 - 1.0;
  vec4 nearP = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 farP = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = uCamPos;
  vec3 rd = normalize(farP.xyz / farP.w - nearP.xyz / nearP.w);

  vec3 radiance = vec3(0.0);
  vec3 throughput = vec3(1.0);
  // Same path weight as throughput, except the first BSDF is replaced by
  // cos / pdf, so it turns incoming radiance at the primary hit into irradiance.
  vec3 irrWeight = vec3(0.0);
  float indirectE = 0.0;
  float primaryE = 0.0;
  float coverage = 0.0;
  float primaryT = FAR;

  for (int bounce = 0; bounce < 6; bounce++) {
    if (bounce >= uMaxBounces) break;
    bool primary = bounce == 0;
    Hit h = traceScene(ro, rd, primary);

    if (primary) {
      int lamp;
      int part;
      vec3 ln;
      float tl = hitLuminaires(ro, rd, h.t, lamp, part, ln);
      if (lamp >= 0) {
        primaryT = tl;
        if (part == 1) {
          vec3 nadir = uLampRot[lamp] * vec3(0.0, 0.0, -1.0);
          float c = max(0.03, dot(-rd, nadir));
          float area = uLumRound == 1 ? PI * uLumHalf.x * uLumHalf.x : 4.0 * uLumHalf.x * uLumHalf.y;
          radiance += iesCandela(lamp, -rd) / (area * c) * uLightTint;
        } else {
          radiance += vec3(0.05, 0.052, 0.056) * (0.35 + 0.65 * max(0.0, ln.z)) * uAmbient * 40.0;
        }
        break;
      }
    }

    if (h.mat < 0) {
      if (primary) {
        radiance += sky(rd);
      } else {
        radiance += throughput * uAmbient * (uOutdoor > 0.5 ? vec3(0.8, 0.88, 1.0) : vec3(1.0));
      }
      break;
    }

    vec3 p = ro + rd * h.t;
    vec3 N = h.n;
    if (dot(N, rd) > 0.0) N = -N;
    vec3 geomN = N;
    Mat m = material(h.mat, p, N);
    if (dot(N, rd) > 0.0) N = geomN;
    vec3 V = -rd;

    float E;
    vec3 Ld = directLight(p, N, V, m, E);
    if (primary) {
      primaryE = E;
      coverage = 1.0;
      primaryT = h.t;
      radiance += Ld;
    } else {
      vec3 c = throughput * Ld;
      float mx = max(c.r, max(c.g, c.b));
      float k = mx > uClamp ? uClamp / mx : 1.0;
      radiance += c * k;
      indirectE += dot(irrWeight * Ld * k, LUMA) / uTintLuma;
    }

    vec3 L;
    vec3 w;
    float pdf;
    if (!sampleBsdf(N, V, m, L, w, pdf)) break;
    if (primary) irrWeight = vec3(max(dot(N, L), 0.0) / pdf);
    else irrWeight *= w;
    throughput *= w;
    if (bounce >= 2) {
      float q = clamp(max(throughput.r, max(throughput.g, throughput.b)), 0.05, 0.95);
      if (rnd() > q) break;
      throughput /= q;
      irrWeight /= q;
    }
    ro = p + geomN * EPS;
    rd = L;
  }

  vec3 camRd = normalize(farP.xyz / farP.w - nearP.xyz / nearP.w);
  if (uHaze > 0.0) {
    // A short cap hid the beams once the camera was farther from the lamps than the cap.
    // Misses have no surface, so stop them at the projection far plane instead of FAR.
    float tMax = primaryT > 1.0e6 ? 500.0 : primaryT;
    radiance = radiance * exp(-uHaze * tMax) + hazeInscatter(uCamPos, camRd, tMax);
  }
  if (uGlare > 0.0) {
    float veil = 0.0;
    for (int li = 0; li < MAX_LAMPS; li++) {
      if (li >= uLampCount) break;
      vec3 toL = normalize(uLampPos[li] - uCamPos);
      float ang = degrees(acos(clamp(dot(camRd, toL), -1.0, 1.0)));
      veil += uLampGlare[li] * 10.0 / (ang * ang + 0.35);
    }
    radiance += veil * uGlare * uLightTint;
  }

  if (any(isnan(radiance)) || any(isinf(radiance))) radiance = vec3(0.0);

  float E = primaryE + indirectE;
  if (isnan(E) || isinf(E)) E = primaryE;
  vec4 luxSample = vec4(E, coverage, min(primaryT, 1.0e4), 1.0);
  if (uBlend >= 1.0) {
    outColor = vec4(radiance, 1.0);
    outLux = luxSample;
  } else {
    vec4 pc = texelFetch(uPrevColor, pix, 0);
    vec4 pl = texelFetch(uPrevLux, pix, 0);
    outColor = vec4(mix(pc.rgb, radiance, uBlend), 1.0);
    outLux = mix(pl, luxSample, uBlend);
  }
}
#endif
`;

export const PROBE_FS = TRACE_FS.replace('#version 300 es\n', '#version 300 es\n#define PROBE\n');

/** False-color ramp shared by the isoline view and the measurement points. */
const RAMP_GLSL = /* glsl */ `
vec3 ramp(float t) {
  const vec3 c0 = vec3(0.004, 0.006, 0.05);
  const vec3 c1 = vec3(0.0, 0.03, 0.55);
  const vec3 c2 = vec3(0.0, 0.35, 1.0);
  const vec3 c3 = vec3(0.0, 0.85, 0.9);
  const vec3 c4 = vec3(0.35, 0.92, 0.12);
  const vec3 c5 = vec3(1.0, 0.9, 0.0);
  const vec3 c6 = vec3(1.0, 0.32, 0.0);
  const vec3 c7 = vec3(0.85, 0.0, 0.08);
  t = clamp(t, 0.0, 1.0) * 7.0;
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  if (t < 4.0) return mix(c3, c4, t - 3.0);
  if (t < 5.0) return mix(c4, c5, t - 4.0);
  if (t < 6.0) return mix(c5, c6, t - 5.0);
  return mix(c6, c7, t - 6.0);
}
float luxRamp(float E, float luxMax) {
  float x = E / luxMax;
  return sqrt(max(x, 0.0)) * 0.15 + x * 0.85;
}
`;

/** Tonemapping (ACES, as in present.wgsl) or false-color illuminance with isolux lines. */
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uColor;
uniform sampler2D uLux;
uniform float uExposure;
uniform int uMode;
uniform float uLuxMax;
uniform float uIsoStep;
uniform float uIsolines;
uniform vec2 uResolution;

out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

${RAMP_GLSL}

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  vec3 radiance = texelFetch(uColor, pix, 0).rgb;
  vec4 lux = texelFetch(uLux, pix, 0);
  vec3 display = toSrgb(aces(radiance * uExposure));
  float E0 = lux.x / max(lux.y, 1e-4);
  // Interreflected light converges slowly, so read illuminance over a small
  // spot, like a meter head. Neighbours that differ a lot belong to another
  // surface and are left out, so edges stay sharp.
  float sumE = 0.0;
  float sumW = 0.0;
  ivec2 size = textureSize(uLux, 0);
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 q = clamp(pix + ivec2(dx, dy), ivec2(0), size - 1);
      vec4 l = texelFetch(uLux, q, 0);
      if (l.y < 0.5) continue;
      float En = l.x / l.y;
      float r = (En - E0) / max(0.2 * E0, 1e-3);
      float wgt = exp(-r * r);
      sumE += En * wgt;
      sumW += wgt;
    }
  }
  float E = sumW > 0.0 ? sumE / sumW : E0;

  if (uMode == 1) {
    float shade = dot(display, vec3(0.2126, 0.7152, 0.0722));
    if (lux.y < 0.02) {
      display = vec3(0.02, 0.022, 0.03) + shade * 0.25;
    } else {
      vec3 heat = ramp(luxRamp(E, uLuxMax));
      display = mix(heat, heat * (0.55 + 0.9 * shade), 0.18);
    }
  } else if (uMode == 2) {
    // Dim the same picture so the points read. Keep its color, including the
    // color temperature; pulling toward gray made a warm source look cooler.
    display *= 0.42;
  }

  if (uIsolines > 0.5 && lux.y > 0.5) {
    float f = E / uIsoStep;
    float w = fwidth(f);
    float d = abs(fract(f + 0.5) - 0.5);
    float line = (1.0 - smoothstep(0.5 * w, 1.5 * w, d)) * step(w, 0.45) * step(0.5, f);
    vec3 lineColor = uMode == 1 ? vec3(1.0) : vec3(0.70, 0.93, 0.29);
    display = mix(display, lineColor, line * 0.85);
  }

  fragColor = vec4(display, 1.0);
}
`;

/** Lit photometric solid. Normals and positions are in world space. */
export const LDC_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec3 aCol;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNrm;
out vec3 vCol;
void main() {
  vPos = aPos;
  vNrm = aNrm;
  vCol = aCol;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const LDC_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNrm;
in vec3 vCol;
uniform vec3 uEye;
uniform float uBack;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uEye - vPos);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = normalize(vec3(0.32, 0.62, 0.72));
  float ndl = clamp(dot(N, L), 0.0, 1.0);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
  vec3 col = vCol * (0.58 + 0.5 * ndl) + vec3(0.9, 1.0, 0.75) * fres * 0.14;
  if (uBack > 0.5) col *= 0.5;
  fragColor = vec4(col, uBack > 0.5 ? 0.38 : 0.94);
}
`;

/** Grid, scale rings and the C-plane ribbons. Color is RGBA. */
export const LDC_LINE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uViewProj;
out vec4 vCol;
void main() {
  vCol = aCol;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const LDC_LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vCol;
out vec4 fragColor;
void main() {
  fragColor = vCol;
}
`;

/**
 * Measurement point spheres, as screen-space quads. Flat colour, same gradient
 * as the Taman app: lighting would wash the scale out.
 * aAnchor: point in framebuffer pixels (y up), camera distance, kind (1 = sphere, 0 = glyph).
 * aRect: quad offset and size in pixels.
 * aUv: atlas rect for glyphs; for spheres (world radius, projected radius).
 * Glyphs are dropped when their anchor is behind a surface. Sphere fragments
 * are tested individually, so the sphere sinks into the surface it sits on.
 */
export const OVERLAY_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec4 aAnchor;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aUv;
layout(location = 3) in float aValue;
uniform vec2 uResolution;
uniform sampler2D uLux;
out vec2 vUv;
out vec2 vLocal;
out float vKind;
out float vValue;
out float vHalf;
out float vDist;
out vec2 vSphere;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  if (aAnchor.w < 0.5) {
    ivec2 size = textureSize(uLux, 0);
    ivec2 px = clamp(ivec2(aAnchor.xy), ivec2(0), size - 1);
    if (aAnchor.z > texelFetch(uLux, px, 0).z * 1.015 + 0.08) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
  }
  vec2 p = aAnchor.xy + aRect.xy + corner * aRect.zw;
  gl_Position = vec4(p / uResolution * 2.0 - 1.0, 0.0, 1.0);
  vUv = vec2(mix(aUv.x, aUv.z, corner.x), mix(aUv.w, aUv.y, corner.y));
  vLocal = corner * 2.0 - 1.0;
  vKind = aAnchor.w;
  vValue = aValue;
  vHalf = aRect.z * 0.5;
  vDist = aAnchor.z;
  vSphere = aUv.xy;
}
`;

export const OVERLAY_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vLocal;
in float vKind;
in float vValue;
in float vHalf;
in float vDist;
in vec2 vSphere;
uniform sampler2D uAtlas;
uniform sampler2D uLux;
uniform float uLuxMax;
out vec4 fragColor;
vec3 brandRamp(float t) {
  const vec3 c0 = vec3(0.122, 0.165, 0.369);
  const vec3 c1 = vec3(0.176, 0.702, 0.659);
  const vec3 c2 = vec3(0.702, 0.925, 0.286);
  const vec3 c3 = vec3(0.961, 0.831, 0.259);
  const vec3 c4 = vec3(0.902, 0.224, 0.275);
  t = clamp(t, 0.0, 1.0);
  if (t < 0.125) return mix(c0, c1, t / 0.125);
  if (t < 0.25) return mix(c1, c2, (t - 0.125) / 0.125);
  if (t < 0.5) return mix(c2, c3, (t - 0.25) / 0.25);
  return mix(c3, c4, (t - 0.5) / 0.5);
}
void main() {
  if (vKind < 0.5) {
    fragColor = texture(uAtlas, vUv);
    return;
  }
  float radiusPx = vSphere.y;
  vec2 q = vLocal * vHalf / radiusPx;
  float r = length(q);
  float coverage = 1.0 - smoothstep(1.0 - 0.9 / radiusPx, 1.0 + 0.9 / radiusPx, r);
  if (coverage <= 0.0) discard;
  float nz = sqrt(max(0.0, 1.0 - r * r));
  float dist = vDist - vSphere.x * nz;
  float depth = texelFetch(uLux, ivec2(gl_FragCoord.xy), 0).z;
  if (dist > depth * 1.003 + 0.01) discard;
  float x = vValue / uLuxMax;
  fragColor = vec4(brandRamp(sqrt(max(x, 0.0)) * 0.15 + x * 0.85), 0.92 * coverage);
}
`;
