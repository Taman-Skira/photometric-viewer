import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrickWall, LandPlot, Orbit, RotateCcw, Route, Sofa, Upload } from 'lucide-react';
import {
  buildIntensityTexture,
  kelvinToCssHex,
  loadPhotometricFile,
  loadPhotometricUrl,
  type LoadedPhotometry,
} from '../photometry';
import { tv } from '../strings';
import { PhotometricRenderer, type FrameInfo, type LuminaireShape, type PointHit, type ViewMode } from './engine/renderer';
import { autoRotation, buildScene, CEILING_CLEARANCE, roomMountLimit, type SceneId, type SceneParams } from './engine/scenes';
import ConvertDownload from './ConvertDownload';
import PolarDiagram from './PolarDiagram';
import { IconButton, Section, Segmented, Slider, Toggle } from './ui';

type ViewportId = SceneId | 'ldc';

interface Sample {
  id: string;
  file: string;
  labelKey: string;
  scene: SceneId;
  /** Scenes this example can be shown in. 3D LDC is always added. */
  scenes: SceneId[];
  params?: Partial<SceneParams>;
}

const SAMPLES: Sample[] = [
  { id: 'street', file: 'taman-street-luminaire.ies', labelKey: 'street', scene: 'street', scenes: ['street', 'open'] },
  { id: 'known', file: 'well-known-street-luminaire.ies', labelKey: 'known', scene: 'street', scenes: ['street', 'open'] },
  { id: 'washer', file: 'asymmetric-wall-washer.ldt', labelKey: 'washer', scene: 'wall', scenes: ['wall', 'open'] },
  { id: 'spot', file: 'narrow-spot-downlight.ies', labelKey: 'spot', scene: 'open', scenes: ['open', 'wall', 'room'] },
  { id: 'downlight', file: 'wide-downlight.ldt', labelKey: 'downlight', scene: 'room', scenes: ['open', 'wall', 'room'] },
  { id: 'pendant', file: 'linear-batwing-pendant.ies', labelKey: 'pendant', scene: 'room', scenes: ['open', 'room'], params: { height: 2.3, count: 2 } },
];

const ALL_VIEWPORTS: ViewportId[] = ['street', 'open', 'wall', 'room', 'ldc'];

/** Examples keep their own scenes plus open area and the 3D LDC. An upload unlocks every scene. */
function viewportsFor(sampleId: string | null): ViewportId[] {
  const sample = SAMPLES.find((s) => s.id === sampleId);
  if (!sample) return ALL_VIEWPORTS;
  const allowed = new Set<ViewportId>([...sample.scenes, 'open', 'ldc']);
  return ALL_VIEWPORTS.filter((id) => allowed.has(id));
}

const DEFAULTS: Record<SceneId, SceneParams> = {
  open: { scene: 'open', height: 4, tilt: 0, rotation: 0, count: 1, spacing: 6, wallDistance: 0.5, ceilingHeight: 3, wallFinish: 'plaster', streetLayout: 'single', showFigure: true },
  street: { scene: 'street', height: 7.2, tilt: 0, rotation: 0, count: 1, spacing: 28, wallDistance: 0.5, ceilingHeight: 3, wallFinish: 'plaster', streetLayout: 'single', showFigure: true },
  wall: { scene: 'wall', height: 2.6, tilt: 0, rotation: 0, count: 1, spacing: 1.4, wallDistance: 0.5, ceilingHeight: 3, wallFinish: 'plaster', streetLayout: 'single', showFigure: true },
  room: { scene: 'room', height: 3 - CEILING_CLEARANCE, tilt: 0, rotation: 0, count: 1, spacing: 2, wallDistance: 0.5, ceilingHeight: 3, wallFinish: 'plaster', streetLayout: 'single', showFigure: true },
};

const HEIGHT_RANGE: Record<SceneId, [number, number]> = { open: [0.3, 25], street: [3, 16], wall: [0.1, 8], room: [1.2, 5] };
/** Used when a file does not declare its own color temperature. */
const DEFAULT_CCT = 3000;

function luminaireShape(p: LoadedPhotometry, scene: SceneId): LuminaireShape {
  let L = p.data.luminousLength;
  let W = p.data.luminousWidth;
  let round = p.data.round;
  if (L < 0.01 && W < 0.01) {
    if (scene === 'street') [L, W, round] = [0.55, 0.26, false];
    else [L, W, round] = [0.14, 0.14, true];
  }
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  if (round) {
    const r = clamp(Math.max(L, W) / 2, 0.02, 0.4);
    return { halfX: r, halfY: r, round: true, housingHalf: [r + 0.015, r + 0.015, 0.035] };
  }
  const hx = clamp(W / 2, 0.01, 0.8);
  const hy = clamp(L / 2, 0.01, 0.8);
  return { halfX: hx, halfY: hy, round: false, housingHalf: [hx + 0.02, hy + 0.02, 0.035] };
}

const PointPopup: React.FC<{ point: PointHit; positionLabel: string; valueLabel: string }> = ({ point, positionLabel, valueLabel }) => (
  <div
    className="pointer-events-none absolute z-20 min-w-[168px] rounded-[10px] border border-white/10 bg-[rgba(18,18,20,0.82)] px-3 py-2.5 text-[11.5px] text-white/95 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-md"
    style={{ left: point.cssX, top: point.cssY, transform: 'translate(14px, -50%)' }}
  >
    <p className="mb-1 text-[9.5px] font-semibold tracking-[0.08em] text-white/45 uppercase">{positionLabel} (m)</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
      {(['x', 'y', 'z'] as const).map((axis, i) => (
        <React.Fragment key={axis}>
          <dt className="text-white/55">{axis}</dt>
          <dd className="pv-num text-right">{point.position[i].toFixed(2)}</dd>
        </React.Fragment>
      ))}
    </dl>
    <div className="my-2 h-px bg-white/10" />
    <p className="mb-1 text-[9.5px] font-semibold tracking-[0.08em] text-white/45 uppercase">{valueLabel}</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4">
      <dt className="text-white/55">E</dt>
      <dd className="pv-num text-right">{point.lux.toFixed(2)} lx</dd>
    </dl>
  </div>
);

const fmt = (v: number | undefined, digits = 0) =>
  v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });

const PhotometricViewer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<PhotometricRenderer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [supported, setSupported] = useState(true);
  const [photometry, setPhotometry] = useState<LoadedPhotometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSample, setActiveSample] = useState<string | null>('street');
  const [params, setParams] = useState<SceneParams>(DEFAULTS.street);
  const [autoRotate, setAutoRotate] = useState(true);
  const [mode, setMode] = useState<ViewMode>('render');
  const litMode = useRef<Exclude<ViewMode, 'ldc'>>('render');
  const [cct, setCct] = useState(DEFAULT_CCT);
  const [haze, setHaze] = useState(0.05);
  const [glare, setGlare] = useState(true);
  const [exposureEv, setExposureEv] = useState(0);
  const [frame, setFrame] = useState<FrameInfo | null>(null);
  const [hoverPoint, setHoverPoint] = useState<PointHit | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const lastLux = useRef(0);
  const progressRef = useRef<HTMLDivElement>(null);
  const previewAnchorRef = useRef<HTMLDivElement>(null);
  const sceneChanged = useRef<'jump' | 'animate' | 'keep'>('jump');
  const [previewDocked, setPreviewDocked] = useState(false);

  // Renderer lifecycle
  useEffect(() => {
    if (!canvasRef.current) return;
    if (!PhotometricRenderer.isSupported()) {
      setSupported(false);
      return;
    }
    let r: PhotometricRenderer;
    try {
      r = new PhotometricRenderer(canvasRef.current);
    } catch (e) {
      console.error(e);
      setSupported(false);
      return;
    }
    r.onHover = setHoverPoint;
    r.onFrame = (info) => {
      const bar = progressRef.current;
      if (bar) {
        const p = Math.min(1, info.samples / info.maxSamples);
        bar.style.transform = `scaleX(${p})`;
        bar.style.opacity = p >= 1 ? '0' : '0.8';
      }
      // Lux scale only changes with the scene, not with each sample. Updating
      // React on every pass re-renders the whole page and fights scrolling.
      const prev = lastLux.current;
      if (prev !== info.luxMax) {
        lastLux.current = info.luxMax;
        setFrame(info);
      }
    };
    setRenderer(r);
    const onVisibility = () => r.setActive(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      r.dispose();
      setRenderer(null);
    };
  }, []);

  // On a phone the settings sit below the preview. Once it leaves the screen,
  // keep a small copy pinned so slider changes stay visible.
  useEffect(() => {
    const anchor = previewAnchorRef.current;
    if (!anchor) return;
    const mq = window.matchMedia('(max-width: 1023px)');
    const observer = new IntersectionObserver(
      ([entry]) => {
        // A single threshold never fires again once the preview has slipped
        // past it, so a normal scroll left the dock stuck off.
        setPreviewDocked(mq.matches && entry.intersectionRatio < 0.15);
      },
      { threshold: [0, 0.15, 1] },
    );
    observer.observe(anchor);
    const onChange = () => {
      if (!mq.matches) setPreviewDocked(false);
    };
    mq.addEventListener('change', onChange);
    return () => {
      observer.disconnect();
      mq.removeEventListener('change', onChange);
    };
  }, []);

  const returnToPreview = () => {
    previewAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const applyPhotometry = useCallback((p: LoadedPhotometry, scene: SceneId, overrides?: Partial<SceneParams>) => {
    setPhotometry(p);
    setError(null);
    // A file with no declared CCT must not keep the previous luminaire's value,
    // and the exposure offset belongs to the picture you were just looking at.
    setCct(p.data.cct ?? DEFAULT_CCT);
    setExposureEv(0);
    setAutoRotate(true);
    setParams((prev) => {
      const base = prev.scene === scene && !overrides ? prev : { ...DEFAULTS[scene], ...overrides };
      return { ...base, rotation: autoRotation(scene, p.stats.throwAngle, p.stats.asymmetry) };
    });
  }, []);

  const loadSample = useCallback(
    async (s: Sample) => {
      setLoading(true);
      try {
        const p = await loadPhotometricUrl(`/photometry/${s.file}`, s.file);
        sceneChanged.current = 'animate';
        applyPhotometry(p, s.scene, s.params ?? {});
        setActiveSample(s.id);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [applyPhotometry],
  );

  const loadFile = useCallback(
    async (file: File) => {
      setLoading(true);
      try {
        const p = await loadPhotometricFile(file);
        applyPhotometry(p, params.scene);
        setActiveSample(null);
      } catch (e) {
        setError(tv('fileError', { message: (e as Error).message }));
      } finally {
        setLoading(false);
      }
    },
    [applyPhotometry, params.scene],
  );

  // Initial sample
  useEffect(() => {
    if (supported) loadSample(SAMPLES[0]);
  }, [supported, loadSample]);

  // Push scene to renderer
  const intensityTexture = useMemo(() => (photometry ? buildIntensityTexture(photometry.sample) : null), [photometry]);
  useEffect(() => {
    if (renderer && photometry && intensityTexture) renderer.setPhotometry(intensityTexture, photometry.sample);
  }, [renderer, photometry, intensityTexture]);

  const shape = useMemo(() => (photometry ? luminaireShape(photometry, params.scene) : null), [photometry, params.scene]);
  const scene = useMemo(() => buildScene({ ...params, housingHalf: shape?.housingHalf }), [params, shape]);
  const sceneRenderer = useRef<PhotometricRenderer | null>(null);
  useEffect(() => {
    if (!renderer || !photometry) return;
    if (shape) renderer.setLuminaireShape(shape);
    const fresh = sceneRenderer.current !== renderer;
    sceneRenderer.current = renderer;
    renderer.setScene(scene, fresh ? 'jump' : sceneChanged.current);
    sceneChanged.current = 'keep';
  }, [renderer, scene, photometry, shape]);

  useEffect(() => {
    renderer?.setSettings({ mode, isolines: mode === 'isolines', cct, haze, glare, exposureEv });
  }, [renderer, mode, cct, haze, glare, exposureEv]);

  const update = (patch: Partial<SceneParams>) => setParams((p) => ({ ...p, ...patch }));

  const switchScene = (id: SceneId) => {
    if (id === params.scene) return;
    sceneChanged.current = 'animate';
    const next = { ...DEFAULTS[id] };
    if (photometry && autoRotate) next.rotation = autoRotation(id, photometry.stats.throwAngle, photometry.stats.asymmetry);
    setParams(next);
  };

  const selectViewport = (id: SceneId | 'ldc') => {
    if (id === 'ldc') {
      setMode('ldc');
      return;
    }
    if (mode === 'ldc') setMode(litMode.current);
    switchScene(id);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  };

  const [hMin, hMax] = HEIGHT_RANGE[params.scene];
  const mountLimit = (p: SceneParams) => Math.max(hMin, roomMountLimit({ ...p, housingHalf: shape?.housingHalf }));
  const heightMax = params.scene === 'room' ? mountLimit(params) : hMax;
  const stats = photometry?.stats;
  const meta = photometry?.data.meta;

  const allowedViewports = viewportsFor(activeSample);
  const sceneChoices: { value: ViewportId; label: React.ReactNode }[] = [
    { value: 'street', label: <><Route className="h-4 w-4" /> <span className="hidden sm:inline">{tv('scenes.street')}</span></> },
    { value: 'open', label: <><LandPlot className="h-4 w-4" /> <span className="hidden sm:inline">{tv('scenes.open')}</span></> },
    { value: 'wall', label: <><BrickWall className="h-4 w-4" /> <span className="hidden sm:inline">{tv('scenes.wall')}</span></> },
    { value: 'room', label: <><Sofa className="h-4 w-4" /> <span className="hidden sm:inline">{tv('scenes.room')}</span></> },
    { value: 'ldc', label: <><Orbit className="h-4 w-4" /> <span className="hidden sm:inline">{tv('scenes.ldc')}</span></> },
  ];
  const scenes = sceneChoices.map((option) => {
    const enabled = allowedViewports.includes(option.value);
    return { ...option, disabled: !enabled, title: enabled ? undefined : tv('sceneUnavailable') };
  });

  const countOptions: Record<SceneId, number[]> = { open: [1, 3, 9], street: [1, 2, 3, 4, 5], wall: [1, 2, 3, 4, 5], room: [1, 2, 4, 6] };

  return (
    <div
      className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {/* Viewport */}
      <div ref={previewAnchorRef} className="scroll-mt-4 lg:col-start-2 lg:row-start-1">
        {previewDocked && <div className="h-[55.8vh] min-h-[342px]" aria-hidden />}
        <div className={previewDocked ? 'fixed top-4 right-4 z-[80] flex w-56 flex-col gap-2' : undefined}>
        <div
          data-lenis-prevent
          className={
            previewDocked
              ? 'pv-viewport relative h-36 overflow-hidden rounded-2xl bg-[#07080a] shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)]'
              : 'pv-viewport relative h-[55.8vh] min-h-[342px] overflow-hidden rounded-2xl bg-[#07080a] lg:h-[min(calc((100vh-8rem)*0.9),738px)]'
          }
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none cursor-grab active:cursor-grabbing" />
          {mode === 'points' && hoverPoint && <PointPopup point={hoverPoint} positionLabel={tv('pointPopup.position')} valueLabel={tv('pointPopup.illuminance')} />}

          {!supported && (
            <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-white/70">{tv('unsupported')}</div>
          )}

          <div className={`pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3 ${previewDocked ? 'hidden' : ''}`}>
            <div className="pointer-events-auto pv-float rounded-2xl bg-black/55 backdrop-blur-md">
              <Segmented ariaLabel={tv('sceneLabel')} options={scenes} value={mode === 'ldc' ? 'ldc' : params.scene} onChange={selectViewport} />
            </div>
            <IconButton className="pointer-events-auto" label={tv('resetView')} onClick={() => renderer?.resetCamera()}>
              <RotateCcw className="h-4 w-4" />
            </IconButton>
          </div>

          <div className={`pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap-reverse items-end justify-between gap-3 ${previewDocked ? 'hidden' : ''}`}>
            {mode !== 'ldc' && (
              <div className="pointer-events-auto pv-float rounded-2xl bg-black/55 backdrop-blur-md">
                <Segmented
                  ariaLabel={tv('viewModeLabel')}
                  size="sm"
                  options={[
                    { value: 'render', label: tv('modes.render') },
                    { value: 'isolines', label: tv('modes.isolines') },
                    { value: 'points', label: tv('modes.points') },
                  ]}
                  value={mode}
                  onChange={(next) => {
                    litMode.current = next;
                    setMode(next);
                  }}
                />
              </div>
            )}
            {mode === 'isolines' && frame && (
              <div className="pv-float rounded-xl bg-black/60 px-3 py-2 backdrop-blur-md">
                <div className="pv-heat-ramp h-2 w-48 rounded-full" />
                <div className="pv-num mt-1 flex justify-between text-[10px] text-white/60">
                  <span>0</span>
                  <span>{fmt(frame.luxMax / 2)}</span>
                  <span>{fmt(frame.luxMax)} lx</span>
                </div>
              </div>
            )}
            {mode === 'ldc' && stats && (
              <div className="pv-float rounded-xl bg-black/60 px-3 py-2 backdrop-blur-md">
                <div className="flex items-center gap-3 text-[11px] text-white/75">
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded-full bg-[var(--taman-primary)]" />
                    {tv('ldc.c0')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 border-t border-dashed border-white/75" />
                    {tv('ldc.c90')}
                  </span>
                </div>
                <p className="pv-num mt-1 text-[11px] text-white/80">
                  {fmt(stats.maxIntensity)} cd
                  <span className="ml-1.5 text-white/45">{tv('ldc.scale')}</span>
                </p>
              </div>
            )}
          </div>

          {mode !== 'ldc' && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/5">
              <div
                ref={progressRef}
                className="h-full origin-left scale-x-0 bg-[var(--taman-primary)] transition-opacity duration-500"
              />
            </div>
          )}

          {(dragOver || loading) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="rounded-2xl border border-dashed border-[var(--taman-primary)] px-8 py-6 text-[var(--taman-primary)]">
                {loading ? tv('loading') : tv('dropHere')}
              </div>
            </div>
          )}
        </div>
        {previewDocked && (
          <button
            type="button"
            onClick={returnToPreview}
            className="pv-press rounded-full bg-black/80 px-3 py-1.5 text-xs text-white shadow-[0_8px_24px_-12px_rgba(0,0,0,0.9)] backdrop-blur-md transition-[background-color,color] duration-200 hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--taman-primary)] active:bg-white/80"
          >
            {tv('returnToPreview')}
          </button>
        )}
        </div>
        <p className="mt-2 px-1 text-xs text-white/40">{tv('controlsHint')}</p>
      </div>

      {photometry && stats && (
        <div className="order-2 min-w-0 lg:col-start-2 lg:row-start-2">
          <Section title={tv('sections.photometry')}>
            <div className="grid items-center gap-6 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
            <PolarDiagram photometry={photometry} unitLabel="cd/klm" />
            <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              {[
                [tv('stats.flux'), `${fmt(stats.flux)} lm`],
                [tv('stats.maxIntensity'), `${fmt(stats.maxIntensity)} cd`],
                [tv('stats.beamAngle'), `${fmt(stats.beamAngleC0, 1)}° / ${fmt(stats.beamAngleC90, 1)}°`],
                [tv('stats.fieldAngle'), `${fmt(stats.fieldAngleC0, 1)}° / ${fmt(stats.fieldAngleC90, 1)}°`],
                [tv('stats.upward'), `${fmt(stats.upwardRatio, 1)} %`],
                [tv('stats.efficacy'), stats.efficacy ? `${fmt(stats.efficacy)} lm/W` : '—'],
                [tv('stats.power'), photometry.data.inputWatts ? `${fmt(photometry.data.inputWatts, 1)} W` : '—'],
                [tv('stats.symmetry'), tv(`symmetry.${photometry.data.symmetry}`)],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <dt className="text-xs text-white/45">{k}</dt>
                  <dd className="pv-num text-white">{v}</dd>
                </div>
              ))}
            </dl>
            {stats.upwardRatio < 0.5 && <p className="rounded-lg bg-[var(--taman-primary)]/10 px-3 py-2 text-xs text-[var(--taman-primary)]">{tv('darkSky')}</p>}
            </div>
            </div>
          </Section>
        </div>
      )}

      {/* Sidebar */}
      <div className="order-1 flex flex-col gap-4 lg:col-start-1 lg:row-start-1 lg:row-span-2">
        <Section title={tv('sections.luminaire')}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="pv-press group flex w-full items-center gap-4 rounded-xl border border-dashed border-white/20 p-4 text-left transition-[border-color,background-color] duration-200 hover:border-[var(--taman-primary)] hover:bg-white/[0.03]"
          >
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--taman-primary)] text-black">
              <Upload className="h-5 w-5" />
            </span>
            <span className="flex flex-col">
              <span className="text-sm font-medium text-white">{tv('upload')}</span>
              <span className="text-xs text-white/45">{tv('uploadHint')}</span>
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ies,.ldt,.eul,.IES,.LDT"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadFile(f);
              e.target.value = '';
            }}
          />
          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

          <div>
            <p className="mb-2 text-xs text-white/45">{tv('samplesTitle')}</p>
            <div className="flex flex-wrap gap-2">
              {SAMPLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => loadSample(s)}
                  className={`pv-press rounded-full px-3 py-1.5 text-xs transition-[background-color,color] duration-200 ${
                    activeSample === s.id ? 'bg-[var(--taman-primary)] text-black' : 'bg-white/[0.07] text-white/75 hover:bg-white/15 hover:text-white'
                  }`}
                >
                  {tv(`samples.${s.labelKey}`)}
                </button>
              ))}
            </div>
          </div>

          {photometry && (
            <div className="rounded-xl bg-white/[0.04] p-3">
              <p className="truncate text-sm font-medium text-white">{meta?.luminaire || meta?.fileName}</p>
              <p className="truncate text-xs text-white/45">
                {[meta?.manufacturer, meta?.catalog, photometry.data.format.toUpperCase()].filter(Boolean).join(' · ')}
              </p>
              {photometry.data.warnings.includes('notTypeC') && <p className="mt-2 text-xs text-amber-300/80">{tv('notTypeC')}</p>}
              <ConvertDownload photometry={photometry} />
            </div>
          )}
        </Section>

        <Section title={tv('sections.placement')}>
          {mode !== 'ldc' && (
            <Slider
              emphasis
              label={params.scene === 'room' ? tv('controls.heightRoom') : tv('controls.height')}
              value={Math.min(params.height, heightMax)}
              min={hMin}
              max={heightMax}
              step={0.05}
              unit=" m"
              format={(v) => v.toFixed(2)}
              onChange={(v) => update({ height: v })}
            />
          )}
          {mode !== 'ldc' && params.scene === 'room' && (
            <Slider
              label={tv('controls.ceiling')}
              value={params.ceilingHeight}
              min={2.4}
              max={5}
              step={0.05}
              unit=" m"
              format={(v) => v.toFixed(2)}
              onChange={(v) => update({ ceilingHeight: v, height: Math.min(params.height, mountLimit({ ...params, ceilingHeight: v })) })}
            />
          )}
          {mode !== 'ldc' && params.scene === 'wall' && (
            <Slider
              label={tv('controls.wallDistance')}
              value={params.wallDistance}
              min={0.1}
              max={4}
              step={0.05}
              unit=" m"
              format={(v) => v.toFixed(2)}
              onChange={(v) => update({ wallDistance: v })}
            />
          )}
          <Slider label={tv('controls.tilt')} value={params.tilt} min={-90} max={90} step={1} unit="°" onChange={(v) => update({ tilt: v })} />
          <Slider
            label={tv('controls.rotation')}
            value={params.rotation}
            min={-180}
            max={180}
            step={1}
            unit="°"
            format={(v) => v.toFixed(0)}
            onChange={(v) => {
              setAutoRotate(false);
              update({ rotation: v });
            }}
          />
          {mode !== 'ldc' && (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-sm text-white/75">{tv('controls.count')}</span>
                <Segmented
                  ariaLabel={tv('controls.count')}
                  size="sm"
                  options={countOptions[params.scene].map((n) => ({ value: n, label: params.scene === 'open' && n === 9 ? '3×3' : String(n) }))}
                  value={params.count}
                  onChange={(v) => update({ count: v })}
                />
              </div>
              {params.scene === 'street' && (
                <Segmented
                  ariaLabel={tv('controls.layout')}
                  size="sm"
                  options={[
                    { value: 'single', label: tv('layouts.single') },
                    { value: 'opposite', label: tv('layouts.opposite') },
                    { value: 'staggered', label: tv('layouts.staggered') },
                  ]}
                  value={params.streetLayout}
                  onChange={(v) => update({ streetLayout: v })}
                />
              )}
              {params.scene !== 'room' && params.count > 1 && (
                <Slider
                  label={tv('controls.spacing')}
                  value={params.spacing}
                  min={params.scene === 'street' ? 10 : 0.5}
                  max={params.scene === 'street' ? 50 : 12}
                  step={0.1}
                  unit=" m"
                  format={(v) => v.toFixed(1)}
                  onChange={(v) => update({ spacing: v })}
                />
              )}
              {params.scene === 'wall' && (
                <Segmented
                  ariaLabel={tv('controls.wallFinish')}
                  size="sm"
                  options={[
                    { value: 'plaster', label: tv('finishes.plaster') },
                    { value: 'brick', label: tv('finishes.brick') },
                  ]}
                  value={params.wallFinish}
                  onChange={(v) => update({ wallFinish: v })}
                />
              )}
              <Toggle label={tv('controls.figure')} checked={params.showFigure} onChange={(v) => update({ showFigure: v })} />
            </>
          )}
        </Section>

        {mode !== 'ldc' && (
          <Section title={tv('sections.light')}>
            <Slider
              label={tv('controls.cct')}
              value={cct}
              min={2000}
              max={6500}
              step={50}
              unit=" K"
              swatch={kelvinToCssHex(cct)}
              onChange={setCct}
            />
            <Slider label={tv('controls.haze')} value={haze} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}`} unit="%" onChange={setHaze} />
            <Slider label={tv('controls.exposure')} value={exposureEv} min={-4} max={4} step={0.1} format={(v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} unit=" EV" onChange={setExposureEv} />
            <Toggle label={tv('controls.glare')} hint={tv('controls.glareHint')} checked={glare} onChange={setGlare} />
          </Section>
        )}
      </div>
    </div>
  );
};

export default PhotometricViewer;
