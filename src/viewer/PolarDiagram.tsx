import React, { useMemo } from 'react';
import type { LoadedPhotometry } from '../photometry';
import { niceCeil } from './engine/renderer';

const SIZE = 240;
const C = SIZE / 2;
const R = SIZE / 2 - 18;

/** Polar light distribution curve (C0-C180 solid, C90-C270 dashed), in cd/klm. */
const PolarDiagram: React.FC<{ photometry: LoadedPhotometry; unitLabel: string }> = ({ photometry, unitLabel }) => {
  const { paths, rings, maxValue } = useMemo(() => {
    const { sample, data, stats } = photometry;
    const flux = data.lampFlux ?? stats.flux;
    const k = flux > 0 ? 1000 / flux : 1;
    const curve = (c: number) => {
      const pts: [number, number][] = [];
      for (let a = -180; a <= 180; a += 1) pts.push([a, (a >= 0 ? sample(c, a) : sample(c + 180, -a)) * k]);
      return pts;
    };
    const c0 = curve(0);
    const c90 = curve(90);
    const max = niceCeil(Math.max(...c0.map((p) => p[1]), ...c90.map((p) => p[1])));
    const toPath = (pts: [number, number][]) =>
      pts
        .map(([a, v], i) => {
          const r = (v / max) * R;
          const rad = (a * Math.PI) / 180;
          return `${i ? 'L' : 'M'}${(C + Math.sin(rad) * r).toFixed(1)},${(C + Math.cos(rad) * r).toFixed(1)}`;
        })
        .join('') + 'Z';
    return { paths: [toPath(c0), toPath(c90)], rings: [0.25, 0.5, 0.75, 1].map((f) => f * max), maxValue: max };
  }, [photometry]);

  return (
    <div className="flex flex-col items-center gap-3">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full max-w-[260px]" role="img" aria-label="Polar light distribution diagram">
        {rings.map((v) => (
          <circle key={v} cx={C} cy={C} r={(v / maxValue) * R} fill="none" stroke="rgba(255,255,255,0.1)" />
        ))}
        {[0, 30, 60, 90, 120, 150].map((a) => {
          const rad = (a * Math.PI) / 180;
          return (
            <line
              key={a}
              x1={C - Math.sin(rad) * R}
              y1={C - Math.cos(rad) * R}
              x2={C + Math.sin(rad) * R}
              y2={C + Math.cos(rad) * R}
              stroke="rgba(255,255,255,0.08)"
            />
          );
        })}
        {rings.map((v) => (
          <text key={`t${v}`} x={C + 3} y={C + (v / maxValue) * R - 3} fontSize="8" fill="rgba(255,255,255,0.4)">
            {Math.round(v)}
          </text>
        ))}
        <path d={paths[1]} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.75)" strokeWidth="1.3" strokeDasharray="4 3" />
        <path d={paths[0]} fill="rgba(179,236,73,0.12)" stroke="#B3EC49" strokeWidth="1.8" />
        <text x={C} y={SIZE - 3} fontSize="9" textAnchor="middle" fill="rgba(255,255,255,0.45)">0°</text>
        <text x={C} y={10} fontSize="9" textAnchor="middle" fill="rgba(255,255,255,0.45)">180°</text>
        <text x={SIZE - 2} y={C + 3} fontSize="9" textAnchor="end" fill="rgba(255,255,255,0.45)">90°</text>
        <text x={2} y={C + 3} fontSize="9" fill="rgba(255,255,255,0.45)">90°</text>
      </svg>
      <div className="flex items-center gap-4 text-xs text-white/60">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-[var(--taman-primary)]" /> C0–C180
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t border-dashed border-white/75" /> C90–C270
        </span>
        <span className="text-white/40">{unitLabel}</span>
      </div>
    </div>
  );
};

export default PolarDiagram;
