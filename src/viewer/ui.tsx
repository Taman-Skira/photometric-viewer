import React, { useId } from 'react';

export const Section: React.FC<{ title: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <section className="pv-surface rounded-2xl p-5">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/50">{title}</h2>
      {aside}
    </div>
    <div className="flex flex-col gap-5">{children}</div>
  </section>
);

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onCommit?: () => void;
  emphasis?: boolean;
  trailing?: React.ReactNode;
  swatch?: string;
}

export const Slider: React.FC<SliderProps> = ({ label, value, min, max, step, unit, format, onChange, onCommit, emphasis, trailing, swatch }) => {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className={`text-sm ${emphasis ? 'text-white' : 'text-white/75'}`}>
          {label}
        </label>
        <div className="flex items-center gap-2">
          {trailing}
          {swatch && <span className="h-3 w-3 rounded-full ring-1 ring-white/20" style={{ background: swatch }} />}
          <output htmlFor={id} className={`pv-num ${emphasis ? 'text-lg text-[var(--taman-primary)]' : 'text-sm text-white'}`}>
            {format ? format(value) : value}
            {unit && <span className="ml-0.5 text-white/45">{unit}</span>}
          </output>
        </div>
      </div>
      <input
        id={id}
        type="range"
        className="pv-range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pct': `${Math.max(0, Math.min(100, pct))}%` } as React.CSSProperties}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </div>
  );
};

interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  ariaLabel,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="pv-segmented flex rounded-xl bg-white/[0.06] p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`pv-press flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background-color,color] duration-200 ${
              size === 'sm' ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'
            } ${
              o.disabled
                ? 'cursor-not-allowed text-white/25'
                : active
                  ? 'bg-[var(--taman-primary)] text-black'
                  : 'text-white/65 hover:bg-white/[0.07] hover:text-white'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }> = ({ label, checked, onChange, hint }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="group flex w-full items-center justify-between gap-4 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--taman-primary)]"
  >
    <span className="flex flex-col">
      <span className="text-sm text-white/75 group-hover:text-white">{label}</span>
      {hint && <span className="text-xs leading-snug text-white/40">{hint}</span>}
    </span>
    <span
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-[transform,background-color] duration-200 group-active:scale-95 ${checked ? 'bg-[var(--taman-primary)]' : 'bg-white/15'}`}
    >
      <span
        className={`pv-spring absolute top-1 left-1 h-4 w-4 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.4)] ${
          checked ? 'translate-x-5 bg-black' : 'translate-x-0 bg-white'
        }`}
      />
    </span>
  </button>
);

export const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }> = ({
  label,
  active,
  className = '',
  children,
  ...rest
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={`pv-press pv-float flex h-10 w-10 items-center justify-center rounded-xl text-white/80 transition-[background-color,color] duration-200 hover:bg-white/15 hover:text-white ${
      active ? 'bg-[var(--taman-primary)] text-black hover:bg-[var(--taman-primary-hover)] hover:text-black' : 'bg-black/55'
    } ${className}`}
    {...rest}
  >
    {children}
  </button>
);
