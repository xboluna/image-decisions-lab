"use client";
import { Lock } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ALL, type PrCurve } from "@/lib/metrics";
import { cx } from "./ui";

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function ChartCard({ title, subtitle, right, children, legend, className }: { title: string; subtitle?: ReactNode; right?: ReactNode; children: ReactNode; legend?: ReactNode; className?: string }) {
  return (
    <div data-chart-surface className={cx("flex min-w-0 flex-col rounded-xl border border-line bg-surface p-3", className)}>
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink">{title}</div>
          {subtitle && <div className="text-[11.5px] leading-snug text-muted">{subtitle}</div>}
        </div>
        {right}
      </div>
      {legend && <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">{legend}</div>}
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function LegendKey({ color, label, shape = "square", muted, onClick, active = true }: { color: string; label: ReactNode; shape?: "square" | "line" | "dot"; muted?: boolean; onClick?: () => void; active?: boolean }) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cx("inline-flex items-center gap-1.5 text-[11.5px]", muted ? "text-muted" : "text-ink-2", onClick && "rounded px-0.5 hover:text-ink", !active && "opacity-40")}
    >
      <span
        className={cx("chart-mark inline-block shrink-0", shape === "square" && "size-2.5 rounded-[3px]", shape === "line" && "h-[3px] w-3.5 rounded-full", shape === "dot" && "size-2.5 rounded-full")}
        style={{ background: color }}
      />
      {label}
    </Tag>
  );
}

type Tip = { x: number; y: number; content: ReactNode } | null;

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x + 12, 4), width - 170);
  return (
    <div className="pointer-events-none absolute z-10 min-w-[140px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px] shadow-pop" style={{ left, top: Math.max(0, tip.y - 8) }}>
      {tip.content}
    </div>
  );
}

const M = { l: 34, r: 14, t: 18, b: 30 };
const HM = { l: 34, r: 14, t: 30, b: 30 };

/**
 * Score histogram with a draggable threshold and a drag-to-select score range. When onThreshold is missing the
 * threshold is locked (the test set uses the training set's threshold).
 */
export function Histogram(props: {
  edges: number[];
  series: { key: string; label: string; counts: number[]; color: string }[];
  threshold: number;
  fitted: number | null;
  thresholdTitle: string;
  onThreshold?: (v: number) => void;
  span: [number, number] | null;
  onSpan: (span: [number, number] | null) => void;
  xLabel: string;
  role: string;
  height?: number;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const height = props.height ?? 220;
  const M = HM;
  const W = Math.max(0, width - M.l - M.r);
  const H = height - M.t - M.b;
  const bins = props.edges.length - 1;
  const totals = Array.from({ length: bins }, (_, i) => props.series.reduce((s, x) => s + x.counts[i], 0));
  const maxCount = Math.max(1, ...totals);
  const niceMax = maxCount <= 5 ? maxCount : Math.ceil(maxCount / 5) * 5;
  const x = (v: number) => M.l + v * W;
  const y = (c: number) => M.t + H - (c / niceMax) * H;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<null | { kind: "threshold" } | { kind: "span"; from: number }>(null);
  const [tip, setTip] = useState<Tip>(null);
  const toValue = useCallback(
    (clientX: number) => {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r || W <= 0) return 0;
      return Math.min(1, Math.max(0, (clientX - r.left - M.l) / W));
    },
    [W],
  );

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const v = toValue(e.clientX);
      if (drag.kind === "threshold") props.onThreshold?.(Math.round(v * 200) / 200);
      else props.onSpan([Math.min(drag.from, v), Math.max(drag.from, v)]);
    };
    const up = (e: PointerEvent) => {
      if (drag.kind === "span") {
        const v = toValue(e.clientX);
        if (Math.abs(v - drag.from) < 0.008) props.onSpan(null);
        else props.onSpan([Math.round(Math.min(drag.from, v) * 1000) / 1000, Math.round(Math.max(drag.from, v) * 1000) / 1000]);
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, toValue, props]);

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const yTicks = niceMax <= 5 ? Array.from({ length: niceMax + 1 }, (_, i) => i) : [0, niceMax / 5, (2 * niceMax) / 5, (3 * niceMax) / 5, (4 * niceMax) / 5, niceMax];
  const bw = W / bins;
  const barW = Math.max(2, Math.min(24, bw - 2));
  const locked = !props.onThreshold;
  const tx = x(props.threshold);

  return (
    <div ref={wrap} className="relative w-full select-none" style={{ height }}>
      {width > 0 && (
        <svg
          ref={svgRef}
          width={width}
          height={height}
          data-export={props.role}
          data-chart="score_histogram"
          className={cx("block", drag?.kind === "span" ? "cursor-col-resize" : "cursor-crosshair")}
          onPointerDown={(e) => {
            if ((e.target as Element).closest("[data-handle]")) return;
            const v = toValue(e.clientX);
            setDrag({ kind: "span", from: v });
            setTip(null);
          }}
          onPointerMove={(e) => {
            if (drag) return;
            const r = svgRef.current!.getBoundingClientRect();
            const v = (e.clientX - r.left - M.l) / W;
            if (v < 0 || v > 1) return setTip(null);
            const i = Math.min(bins - 1, Math.floor(v * bins));
            setTip({
              x: e.clientX - r.left,
              y: e.clientY - r.top,
              content: (
                <div>
                  <div className="mb-1 font-medium text-ink tabular">
                    {props.edges[i].toFixed(2)}–{props.edges[i + 1].toFixed(2)}
                  </div>
                  {[...props.series].reverse().map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-3 text-ink-2">
                      <LegendKey color={s.color} label={s.label} />
                      <span className="tabular text-ink">{s.counts[i]}</span>
                    </div>
                  ))}
                  <div className="mt-1 text-[10.5px] text-muted">Drag across bars to filter images</div>
                </div>
              ),
            });
          }}
          onPointerLeave={() => setTip(null)}
        >
          <title>{`Score histogram (${props.xLabel})`}</title>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + W} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={M.l - 6} y={y(t)} fontSize={10} fill="var(--muted)" textAnchor="end" dominantBaseline="middle" className="tabular">
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          ))}
          {props.span && <rect x={x(props.span[0])} y={M.t} width={Math.max(1, x(props.span[1]) - x(props.span[0]))} height={H} fill="var(--accent)" opacity={0.12} rx={3} />}
          {props.span && (
            <>
              <line x1={x(props.span[0])} x2={x(props.span[0])} y1={M.t} y2={M.t + H} stroke="var(--accent)" strokeWidth={1} />
              <line x1={x(props.span[1])} x2={x(props.span[1])} y1={M.t} y2={M.t + H} stroke="var(--accent)" strokeWidth={1} />
            </>
          )}
          {Array.from({ length: bins }, (_, i) => {
            let acc = 0;
            const cx0 = M.l + i * bw + (bw - barW) / 2;
            const nonzero = props.series.filter((s) => s.counts[i] > 0);
            return (
              <g key={i}>
                {props.series.map((s) => {
                  const c = s.counts[i];
                  if (!c) return null;
                  const y0 = y(acc);
                  acc += c;
                  const y1 = y(acc);
                  const isTop = nonzero[nonzero.length - 1]?.key === s.key;
                  const h = Math.max(1, y0 - y1 - (acc > c ? 2 : 0));
                  const r = isTop ? Math.min(4, barW / 2, h) : 0;
                  const top = y0 - h;
                  const d = `M${cx0},${y0} L${cx0},${top + r} Q${cx0},${top} ${cx0 + r},${top} L${cx0 + barW - r},${top} Q${cx0 + barW},${top} ${cx0 + barW},${top + r} L${cx0 + barW},${y0} Z`;
                  return <path key={s.key} d={d} fill={s.color} className="chart-mark" />;
                })}
              </g>
            );
          })}
          <line x1={M.l} x2={M.l + W} y1={M.t + H} y2={M.t + H} stroke="var(--axis)" strokeWidth={1} />
          {ticks.map((t) => (
            <text key={t} x={x(t)} y={M.t + H + 14} fontSize={10} fill="var(--muted)" textAnchor="middle" className="tabular">
              {t}
            </text>
          ))}
          <text x={M.l + W / 2} y={height - 3} fontSize={10.5} fill="var(--ink-2)" textAnchor="middle">
            {props.xLabel}
          </text>
          {props.fitted != null && Math.abs(props.fitted - props.threshold) > 0.001 && (
            <g>
              <line x1={x(props.fitted)} x2={x(props.fitted)} y1={M.t} y2={M.t + H} stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 3" />
              <text x={x(props.fitted) + 3} y={M.t + 8} fontSize={9.5} fill="var(--muted)" textAnchor="start">
                fitted
              </text>
            </g>
          )}
          <g
            data-handle
            role="slider"
            tabIndex={locked ? -1 : 0}
            aria-label={props.thresholdTitle}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={props.threshold}
            aria-readonly={locked}
            className={locked ? "cursor-not-allowed" : "cursor-ew-resize"}
            onPointerDown={(e) => {
              if (locked) return;
              e.stopPropagation();
              setDrag({ kind: "threshold" });
            }}
            onKeyDown={(e) => {
              if (locked) return;
              const step = e.shiftKey ? 0.05 : 0.01;
              if (e.key === "ArrowLeft") props.onThreshold?.(Math.max(0, Math.round((props.threshold - step) * 1000) / 1000));
              if (e.key === "ArrowRight") props.onThreshold?.(Math.min(1, Math.round((props.threshold + step) * 1000) / 1000));
            }}
          >
            <rect x={tx - 8} y={M.t - 4} width={16} height={H + 4} fill="transparent" />
            <line x1={tx} x2={tx} y1={M.t} y2={M.t + H} stroke="var(--ink)" strokeWidth={2} />
            <rect x={Math.min(Math.max(tx - 19, M.l - 19), M.l + W - 19)} y={M.t - 24} width={38} height={17} rx={5} fill="var(--ink)" />
            <path d={`M${tx - 4},${M.t - 7} L${tx + 4},${M.t - 7} L${tx},${M.t - 2} Z`} fill="var(--ink)" />
            <text x={Math.min(Math.max(tx, M.l), M.l + W)} y={M.t - 15} fontSize={10} fontWeight={600} fill="var(--surface)" textAnchor="middle" dominantBaseline="middle" className="tabular">
              {props.threshold.toFixed(2)}
            </text>
          </g>
        </svg>
      )}
      {locked && (
        <div className="pointer-events-none absolute right-1 top-0 inline-flex items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[10.5px] text-ink-2">
          <Lock className="size-3" /> from training set
        </div>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/** Precision-recall curves. The dot on each curve is the current operating point. */
export function PrChart(props: {
  curves: (PrCurve & { color: string })[];
  operating: { key: string; precision: number | null; recall: number | null }[];
  onPick?: (threshold: number, key: string) => void;
  role: string;
  height?: number;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const height = props.height ?? 210;
  const W = Math.max(0, width - M.l - M.r);
  const H = height - M.t - M.b;
  const x = (r: number) => M.l + r * W;
  const y = (p: number) => M.t + (1 - p) * H;
  const [tip, setTip] = useState<Tip>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = props.curves.filter((c) => !hidden.has(c.key));
  const paths = useMemo(
    () =>
      visible.map((c) => {
        const pts = c.points;
        if (!pts.length) return { c, d: "" };
        // Step from (recall 0, first precision) through every operating point.
        let d = `M${x(0)},${y(pts[0].precision)}`;
        for (const p of pts) d += ` L${x(p.recall)},${y(p.precision)}`;
        return { c, d };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, W, H],
  );
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const svgRef = useRef<SVGSVGElement>(null);

  function nearest(clientX: number, clientY: number) {
    const r = svgRef.current!.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    let best: { c: PrCurve & { color: string }; p: PrCurve["points"][number]; d: number } | null = null;
    for (const c of visible)
      for (const p of c.points) {
        const d = Math.hypot(x(p.recall) - px, y(p.precision) - py);
        if (!best || d < best.d) best = { c, p, d };
      }
    return best && best.d < 28 ? { ...best, px, py } : null;
  }

  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1">
        {props.curves.map((c) => (
          <LegendKey
            key={c.key}
            shape="line"
            color={c.color}
            active={!hidden.has(c.key)}
            onClick={
              props.curves.length > 1
                ? () =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(c.key)) n.delete(c.key);
                      else n.add(c.key);
                      return n;
                    })
                : undefined
            }
            label={
              <span>
                {c.label} <span className="tabular text-muted">AP {c.ap == null ? "—" : c.ap.toFixed(2)}</span>
              </span>
            }
          />
        ))}
      </div>
      <div ref={wrap} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            data-export={props.role}
            data-chart="precision_recall"
            className={props.onPick ? "cursor-pointer" : undefined}
            onPointerMove={(e) => {
              const n = nearest(e.clientX, e.clientY);
              if (!n) return setTip(null);
              setTip({
                x: n.px,
                y: n.py,
                content: (
                  <div>
                    <LegendKey color={n.c.color} shape="line" label={<span className="font-medium text-ink">{n.c.label}</span>} />
                    <div className="mt-1 grid grid-cols-[auto_auto] gap-x-3 tabular text-ink-2">
                      <span>Threshold</span>
                      <span className="text-right text-ink">≥ {n.p.threshold.toFixed(3)}</span>
                      <span>Precision</span>
                      <span className="text-right text-ink">{(n.p.precision * 100).toFixed(1)}%</span>
                      <span>Recall</span>
                      <span className="text-right text-ink">{(n.p.recall * 100).toFixed(1)}%</span>
                    </div>
                    {props.onPick && <div className="mt-1 text-[10.5px] text-muted">Click to use this threshold</div>}
                  </div>
                ),
              });
            }}
            onPointerLeave={() => setTip(null)}
            onClick={(e) => {
              if (!props.onPick) return;
              const n = nearest(e.clientX, e.clientY);
              if (n) props.onPick(n.p.threshold, n.c.key);
            }}
          >
            <title>Precision-recall curves</title>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={M.l} x2={M.l + W} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
                <text x={M.l - 6} y={y(t)} fontSize={10} fill="var(--muted)" textAnchor="end" dominantBaseline="middle" className="tabular">
                  {t}
                </text>
                <text x={x(t)} y={M.t + H + 14} fontSize={10} fill="var(--muted)" textAnchor="middle" className="tabular">
                  {t}
                </text>
              </g>
            ))}
            <line x1={M.l} x2={M.l + W} y1={M.t + H} y2={M.t + H} stroke="var(--axis)" strokeWidth={1} />
            <text x={M.l + W / 2} y={height - 3} fontSize={10.5} fill="var(--ink-2)" textAnchor="middle">
              Recall
            </text>
            <text x={10} y={M.t + H / 2} fontSize={10.5} fill="var(--ink-2)" textAnchor="middle" transform={`rotate(-90 10 ${M.t + H / 2})`}>
              Precision
            </text>
            {paths.map(({ c, d }) => (
              <path key={c.key} d={d} fill="none" stroke={c.color} strokeWidth={c.key === ALL ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" className="chart-mark" />
            ))}
            {props.operating
              .filter((o) => o.precision != null && o.recall != null && !hidden.has(o.key))
              .map((o) => {
                const c = props.curves.find((cc) => cc.key === o.key);
                return (
                  <circle key={o.key} cx={x(o.recall as number)} cy={y(o.precision as number)} r={5} fill={c?.color ?? "var(--ink)"} stroke="var(--surface)" strokeWidth={2} className="chart-mark">
                    <title>Current threshold</title>
                  </circle>
                );
              })}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </div>
  );
}

/** Confusion matrix: rows are the actual class, columns the predicted class. Cells are clickable filters. */
export function ConfusionChart(props: {
  labels: string[];
  keys: string[];
  cells: number[][];
  colors: string[];
  selected: { actual: string; predicted: string } | null;
  onSelect: (cell: { actual: string; predicted: string } | null) => void;
  role: string;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const n = props.labels.length;
  const labelW = Math.min(110, Math.max(54, ...props.labels.map((l) => l.length * 6.6 + 18)));
  const top = 34;
  const cell = Math.max(28, Math.min(64, Math.floor((width - labelW - 8) / Math.max(1, n))));
  const height = top + cell * n + 22;
  const rowTotals = props.cells.map((r) => r.reduce((a, b) => a + b, 0));
  const [tip, setTip] = useState<Tip>(null);
  const shade = (frac: number) => `color-mix(in oklab, var(--s1) ${Math.round(8 + frac * 82)}%, var(--surface))`;
  return (
    <div ref={wrap} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} data-export={props.role} data-chart="confusion_matrix">
          <title>Confusion matrix</title>
          <text x={labelW + (cell * n) / 2} y={10} fontSize={10.5} fill="var(--ink-2)" textAnchor="middle">
            Predicted
          </text>
          {props.labels.map((l, j) => (
            <g key={`c${j}`}>
              <rect x={labelW + j * cell + cell / 2 - 14} y={18} width={8} height={8} rx={2} fill={props.colors[j]} className="chart-mark" />
              <text x={labelW + j * cell + cell / 2 - 3} y={22} fontSize={10.5} fill="var(--ink-2)" dominantBaseline="middle">
                {l.length > 8 && n > 2 ? `${l.slice(0, 7)}…` : l}
              </text>
            </g>
          ))}
          {props.labels.map((l, i) => (
            <g key={`r${i}`}>
              <rect x={2} y={top + i * cell + cell / 2 - 4} width={8} height={8} rx={2} fill={props.colors[i]} className="chart-mark" />
              <text x={14} y={top + i * cell + cell / 2} fontSize={10.5} fill="var(--ink-2)" dominantBaseline="middle">
                {l.length > 13 ? `${l.slice(0, 12)}…` : l}
              </text>
            </g>
          ))}
          {props.cells.map((row, i) =>
            row.map((v, j) => {
              const frac = rowTotals[i] ? v / rowTotals[i] : 0;
              const sel = props.selected?.actual === props.keys[i] && props.selected?.predicted === props.keys[j];
              const dark = frac > 0.5;
              return (
                <g
                  key={`${i}-${j}`}
                  className="cursor-pointer"
                  onClick={() => props.onSelect(sel ? null : { actual: props.keys[i], predicted: props.keys[j] })}
                  onPointerMove={(e) => {
                    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setTip({
                      x: e.clientX - r.left,
                      y: e.clientY - r.top,
                      content: (
                        <div className="tabular">
                          <div className="font-medium text-ink">
                            {v} image{v === 1 ? "" : "s"}
                          </div>
                          <div className="text-ink-2">
                            Actual <b className="font-medium text-ink">{props.labels[i]}</b>, predicted <b className="font-medium text-ink">{props.labels[j]}</b>
                          </div>
                          <div className="text-muted">{rowTotals[i] ? `${(frac * 100).toFixed(0)}% of actual ${props.labels[i]}` : ""}</div>
                          <div className="mt-1 text-[10.5px] text-muted">Click to filter</div>
                        </div>
                      ),
                    });
                  }}
                  onPointerLeave={() => setTip(null)}
                >
                  <rect x={labelW + j * cell + 1} y={top + i * cell + 1} width={cell - 2} height={cell - 2} rx={6} fill={v ? shade(frac) : "var(--surface-2)"} stroke={sel ? "var(--ink)" : i === j ? "var(--border-strong)" : "none"} strokeWidth={sel ? 2 : 1} />
                  <text x={labelW + j * cell + cell / 2} y={top + i * cell + cell / 2 - (cell > 40 ? 5 : 0)} fontSize={cell > 40 ? 13 : 11} fontWeight={600} fill={dark ? "#ffffff" : v ? "var(--ink)" : "var(--muted)"} textAnchor="middle" dominantBaseline="middle" className="tabular">
                    {v}
                  </text>
                  {cell > 40 && rowTotals[i] > 0 && (
                    <text x={labelW + j * cell + cell / 2} y={top + i * cell + cell / 2 + 10} fontSize={9.5} fill={dark ? "rgba(255,255,255,0.8)" : "var(--muted)"} textAnchor="middle" dominantBaseline="middle" className="tabular">
                      {(frac * 100).toFixed(0)}%
                    </text>
                  )}
                </g>
              );
            }),
          )}
          <text x={8} y={top - 6} fontSize={10.5} fill="var(--ink-2)">
            Actual
          </text>
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}
