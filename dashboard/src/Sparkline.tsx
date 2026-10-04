interface Props {
  values: (number | null)[];
  color: string;
  height?: number;
  /** Fixed y-axis max (e.g. 1 for rates); defaults to the series max. */
  max?: number;
  label?: string;
}

/** Dependency-free SVG sparkline with a soft area fill. Nulls render as gaps. */
export function Sparkline({ values, color, height = 44, max, label }: Props) {
  const w = 240;
  const h = height;
  const nums = values.filter((v): v is number => v !== null);
  const top = max ?? Math.max(1, ...nums) * 1.1;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const y = (v: number) => h - 2 - (Math.min(v, top) / top) * (h - 4);

  const segments: string[] = [];
  let cur = '';
  values.forEach((v, i) => {
    if (v === null) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (cur) segments.push(cur);

  const id = `g${color.replace(/[^a-z0-9]/gi, '')}`;
  const lastIdx = values.map((v, i) => (v === null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {segments.map((d, i) => {
        const xs = d.match(/[ML]([\d.]+),/g)!.map((m) => m.slice(1, -1));
        return (
          <g key={i}>
            <path d={`${d}L${xs[xs.length - 1]},${h}L${xs[0]},${h}Z`} fill={`url(#${id})`} />
            <path d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </g>
        );
      })}
      {lastIdx >= 0 && <circle cx={lastIdx * step} cy={y(values[lastIdx] as number)} r="2.6" fill={color} className="spark-dot" />}
    </svg>
  );
}
