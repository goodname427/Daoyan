import type { SpellCost } from '../core/index';

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export function CostCard({ cost }: { cost: SpellCost }) {
  return (
    <div className="cost-card">
      <div className="stat-row">
        <Stat label="法力上界" value={String(cost.manaWorst)} hint="按列表容量计算的最坏情况" />
        <Stat label="耗时上界" value={`${cost.tickWorst} tick`} hint="按列表容量计算的最坏情况" />
        <Stat label="神识峰值" value={String(cost.shenshiPeak)} hint="变量同时存在时的最大占用" />
      </div>
      {cost.errors.length > 0 && (
        <ul className="errors">
          {cost.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <b>{value}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
