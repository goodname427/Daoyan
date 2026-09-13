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
  const manaValue = cost.manaBudget.dynamic
    ? `${cost.manaBudget.value} + 动态`
    : String(cost.manaBudget.value);
  const tickValue = cost.tickBudget.dynamic
    ? `${cost.tickBudget.value} + 动态 tick`
    : `${cost.tickBudget.value} tick`;
  return (
    <div className="cost-card">
      <div className="stat-row">
        <Stat
          label={cost.manaBudget.dynamic ? '法力预算' : '法力上界'}
          value={manaValue}
          hint={
            cost.manaBudget.dynamic
              ? '包含已知基础成本；剩余部分由施法时的请求效果计算'
              : '按列表容量计算的最坏情况'
          }
        />
        <Stat
          label={cost.tickBudget.dynamic ? '耗时预算' : '耗时上界'}
          value={tickValue}
          hint={
            cost.tickBudget.dynamic
              ? '包含已知基础耗时；剩余部分由施法时的请求效果计算'
              : '按列表容量计算的最坏情况'
          }
        />
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
