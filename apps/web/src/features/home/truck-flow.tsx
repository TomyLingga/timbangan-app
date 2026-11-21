"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { CircleAlert, RefreshCw } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { MOTION_EASE, MOTION_SPRING } from "@/lib/motion";
import { filterFlow, type FlowCounts, type StageKey } from "@/lib/truck-flow";
import { cn } from "@/lib/utils";

// "Aliran truk": the trucks of today drawn as two streams of thin curves, one
// for incoming and one for outgoing, running through the stages of the plant
// from left to right. At each stage a stream is as wide and as bright as the
// number of trucks there; the busiest stage is picked out in the signal colour.
// With no trucks the streams lie flat and dim. The chips under the drawing
// carry the same numbers as text, and a hidden summary reads them out.

const W = 1000;
const H = 300;
const CY = 140;
const X0 = 70;
const X1 = 930;
const STRANDS = 6;

type Direction = "IN" | "OUT";
type Filter = Direction | "ALL";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "ALL", label: "Semua" },
  { value: "IN", label: "Incoming" },
  { value: "OUT", label: "Outgoing" },
];

const stageX = (index: number, count: number) => X0 + (index * (X1 - X0)) / Math.max(count - 1, 1);

/** Width of a stream at a stage: pinched when empty, growing with the square root of the count. */
const spreadFor = (count: number, max: number) => (count === 0 ? 3 : 12 + 70 * Math.sqrt(count / max));

/** A smooth curve through the points (Catmull-Rom as cubic Béziers). Same command count for any data. */
function curve(points: ReadonlyArray<readonly [number, number]>): string {
  let d = `M ${points[0][0]} ${points[0][1].toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(index - 1, 0)];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(index + 2, points.length - 1)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0]} ${p2[1].toFixed(2)}`;
  }
  return d;
}

/** The strands of one stream. The weave comes from fixed phases, so it never jumps between renders. */
function strandPaths(counts: readonly number[], max: number, shift: number, phase: number): string[] {
  return Array.from({ length: STRANDS }, (_, strand) => {
    const points: Array<readonly [number, number]> = [[18, CY + shift * 0.4]];
    counts.forEach((count, stage) => {
      const weave = Math.sin(strand * 1.9 + stage * 1.15 + phase) * (0.45 + (0.55 * (strand + 1)) / STRANDS);
      points.push([stageX(stage, counts.length), CY + shift + spreadFor(count, max) * weave]);
    });
    points.push([982, CY + shift * 0.4]);
    return curve(points);
  });
}

interface StreamProps {
  id: string;
  paths: string[];
  /** The same strands lying flat: where the drawing starts from. */
  flat: string[];
  gradient: string;
  colour: string;
  lit: boolean;
  reduceMotion: boolean;
  delay: number;
}

function Stream({ id, paths, flat, gradient, colour, lit, reduceMotion, delay }: StreamProps) {
  // The strands open out of the flat skeleton, and move again when the numbers change.
  const transition = reduceMotion
    ? { duration: 0 }
    : { d: { duration: 0.9, ease: MOTION_EASE, delay }, opacity: { duration: 0.5, delay } };
  return (
    <g>
      {/* Soft glow under the strands, on the dark theme only (--glow is 0 in the light one). */}
      <g filter={`url(#${id}-blur)`} style={{ opacity: "calc(0.6 * var(--glow))" }}>
        {paths.map((d, index) => (
          <motion.path
            key={`glow-${index}`}
            initial={reduceMotion ? false : { d: flat[index], opacity: 0 }}
            animate={{ d, opacity: 1 }}
            transition={transition}
            fill="none"
            stroke={`url(#${gradient})`}
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
      {paths.map((d, index) => (
        <motion.path
          key={index}
          initial={reduceMotion ? false : { d: flat[index], opacity: 0 }}
          animate={{ d, opacity: 1 }}
          transition={transition}
          fill="none"
          stroke={`url(#${gradient})`}
          strokeWidth={index === 2 ? 1.6 : 1.1}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {/* Light travelling along the stream while there are trucks in it. */}
      {lit ? (
        <motion.path
          className="motion-only"
          animate={{ d: paths[2] }}
          transition={{ d: { duration: 0.8, ease: MOTION_EASE } }}
          fill="none"
          stroke={colour}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="1.5 118.5"
          vectorEffect="non-scaling-stroke"
          style={{ animation: "stream-flow 3.6s linear infinite", opacity: 0.85 }}
        />
      ) : null}
    </g>
  );
}

export interface TruckFlowProps {
  counts: FlowCounts | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Some list held more trucks than one page returns; the counts cover the first page only. */
  partial: boolean;
  /** A page that lists the trucks of a stage, where one exists. */
  links: Partial<Record<StageKey, string>>;
}

export function TruckFlow({ counts, loading, error, onRetry, partial, links }: TruckFlowProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const reduceMotion = useReducedMotion() ?? false;
  const [filter, setFilter] = useState<Filter>("ALL");
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  const shown = useMemo(() => (counts ? filterFlow(counts, filter) : null), [counts, filter]);
  const stages = shown?.stages ?? [];
  const stageCount = 8;
  const max = Math.max(1, ...stages.map((stage) => stage.total));
  const peak = shown?.peak ?? null;
  const active = hovered ?? pinned ?? peak;
  const empty = !loading && !error && shown !== null && peak === null;

  const both = filter === "ALL";
  const incoming = stages.length ? stages.map((stage) => stage.incoming) : Array<number>(stageCount).fill(0);
  const outgoing = stages.length ? stages.map((stage) => stage.outgoing) : Array<number>(stageCount).fill(0);
  const inPaths = strandPaths(incoming, max, both ? -12 : 0, 0);
  const outPaths = strandPaths(outgoing, max, both ? 12 : 0, 2.4);
  const zeros = Array<number>(stageCount).fill(0);
  const inFlat = strandPaths(zeros, 1, both ? -12 : 0, 0);
  const outFlat = strandPaths(zeros, 1, both ? 12 : 0, 2.4);

  const stops = (values: readonly number[], colour: string) => [
    <stop key="start" offset="0" style={{ stopColor: colour, stopOpacity: 0.12 }} />,
    ...values.map((count, index) => (
      <stop
        key={index}
        offset={(stageX(index, values.length) / W).toFixed(4)}
        style={{
          stopColor: index === peak && count > 0 ? "var(--signal)" : colour,
          stopOpacity: count === 0 ? 0.14 : 0.35 + 0.65 * Math.sqrt(count / max),
          transition: "stop-opacity 0.6s, stop-color 0.6s",
        }}
      />
    )),
    <stop key="end" offset="1" style={{ stopColor: colour, stopOpacity: 0.12 }} />,
  ];

  const peakSpread = peak === null ? 0 : spreadFor(stages[peak].total, max) + (both ? 12 : 0);
  const activeStage = active !== null ? stages[active] : null;
  const percent = (index: number) => (stageX(index, stageCount) / W) * 100;

  const summary = shown
    ? `Aliran truk saat ini. ${stages.map((stage) => `${stage.label} ${formatNumber(stage.total)}`).join(", ")}.${
        peak !== null ? ` Paling ramai: ${stages[peak].label}.` : " Belum ada truk."
      }${partial ? " Dihitung dari halaman pertama tiap daftar." : ""}`
    : "";

  return (
    <section aria-labelledby={`${uid}-title`} className="relative overflow-hidden rounded-3xl border bg-card shadow-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2 id={`${uid}-title`} className="text-lg font-semibold">
            Aliran truk
          </h2>
          <LayoutGroup id={`${uid}-filter`}>
            <div role="group" aria-label="Arah truk" className="flex h-9 items-center gap-0.5 rounded-full border bg-surface p-0.5">
              {FILTERS.map((option) => {
                const on = filter === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setFilter(option.value);
                      setPinned(null);
                    }}
                    className={cn(
                      "relative h-8 rounded-full px-3.5 text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      on ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {on ? (
                      <motion.span layoutId="flow-filter" transition={MOTION_SPRING} aria-hidden="true" className="absolute inset-0 rounded-full bg-primary" />
                    ) : null}
                    <span className="relative">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </div>
        <ul aria-hidden="true" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-stream-in" />
            Incoming
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-stream-out" />
            Outgoing
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-signal" />
            Paling ramai
          </li>
        </ul>
      </div>

      <p className="sr-only" aria-live="polite">
        {summary}
      </p>

      {/* The drawing. Pointer only; the chips below give the same to keyboard and screen readers. */}
      <div className="relative mt-2" onPointerLeave={() => setHovered(null)} aria-hidden="true">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[13.5rem] w-full sm:h-[19rem]" focusable="false">
          <defs>
            <linearGradient id={`${uid}-in`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2="0">
              {stops(incoming, "var(--stream-in)")}
            </linearGradient>
            <linearGradient id={`${uid}-out`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2="0">
              {stops(outgoing, "var(--stream-out)")}
            </linearGradient>
            <radialGradient id={`${uid}-peak`}>
              <stop offset="0" stopColor="var(--signal)" stopOpacity="0.5" />
              <stop offset="1" stopColor="var(--signal)" stopOpacity="0" />
            </radialGradient>
            <filter id={`${uid}-blur`} x="-10%" y="-50%" width="120%" height="200%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>

          {/* Stage columns. */}
          {Array.from({ length: stageCount }, (_, index) => (
            <line
              key={index}
              x1={stageX(index, stageCount)}
              x2={stageX(index, stageCount)}
              y1="18"
              y2={H - 18}
              stroke="var(--border)"
              strokeDasharray="2 6"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {peak !== null ? (
            <g>
              <ellipse
                cx={stageX(peak, stageCount)}
                cy={CY}
                rx="120"
                ry={peakSpread + 50}
                fill={`url(#${uid}-peak)`}
                style={{ opacity: "calc(0.25 + 0.5 * var(--glow))", transition: "opacity 0.4s" }}
              />
              {/* Focus brackets around the busiest stage. */}
              {[
                [-1, -1],
                [1, -1],
                [-1, 1],
                [1, 1],
              ].map(([sx, sy]) => {
                const x = stageX(peak, stageCount) + sx * 34;
                const y = CY + sy * (peakSpread * 0.75 + 14);
                return (
                  <path
                    key={`${sx}${sy}`}
                    d={`M ${x} ${y - sy * 10} L ${x} ${y} L ${x - sx * 10} ${y}`}
                    fill="none"
                    stroke="var(--signal)"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>
          ) : null}

          {filter !== "OUT" ? (
            <Stream
              id={uid}
              paths={inPaths}
              flat={inFlat}
              gradient={`${uid}-in`}
              colour="var(--stream-in)"
              lit={incoming.some((count) => count > 0)}
              reduceMotion={reduceMotion}
              delay={0}
            />
          ) : null}
          {filter !== "IN" ? (
            <Stream
              id={uid}
              paths={outPaths}
              flat={outFlat}
              gradient={`${uid}-out`}
              colour="var(--stream-out)"
              lit={outgoing.some((count) => count > 0)}
              reduceMotion={reduceMotion}
              delay={0.15}
            />
          ) : null}

          {/* The stage the tooltip speaks about. */}
          {activeStage && activeStage.total > 0 ? (
            <line
              x1={stageX(active as number, stageCount)}
              x2={stageX(active as number, stageCount)}
              y1="40"
              y2={CY}
              stroke={active === peak ? "var(--signal)" : "var(--primary)"}
              strokeOpacity="0.7"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {/* Pointer targets, one column per stage. */}
          {Array.from({ length: stageCount }, (_, index) => (
            <rect
              key={index}
              x={stageX(index, stageCount) - (X1 - X0) / 14}
              y="0"
              width={(X1 - X0) / 7}
              height={H}
              fill="transparent"
              onPointerEnter={() => setHovered(index)}
            />
          ))}
        </svg>

        {/* Tooltip card. */}
        {activeStage && activeStage.total > 0 ? (
          <div
            className="pointer-events-none absolute top-2 w-52 rounded-xl border bg-popover/95 px-3.5 py-2.5 shadow-raised backdrop-blur-sm sm:w-60"
            style={{ left: percent(active as number) < 32 ? `calc(${percent(active as number)}% + 0.75rem)` : `max(0.5rem, calc(${percent(active as number)}% - 16rem))` }}
          >
            <p className={cn("kicker text-[0.625rem]", active === peak ? "text-signal-ink" : "text-primary-ink")}>
              {active === peak ? "Paling ramai" : `Tahap ${(active as number) + 1}`}
            </p>
            <p className="mt-1 text-sm font-semibold">{activeStage.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {formatNumber(activeStage.total)} truk, {formatNumber(activeStage.incoming)} incoming, {formatNumber(activeStage.outgoing)} outgoing
            </p>
          </div>
        ) : null}

        {empty ? (
          <p className="absolute inset-x-0 top-[66%] text-center text-sm text-muted-foreground">
            Belum ada truk di jalur hari ini.
          </p>
        ) : null}

        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card/80 px-4 text-center">
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              Coba lagi
            </Button>
          </div>
        ) : null}

        {/* Stage numbers under the columns. */}
        <div className="relative mx-0 h-5 font-mono text-[0.6875rem] text-faint">
          {Array.from({ length: stageCount }, (_, index) => (
            <span key={index} className="absolute -translate-x-1/2" style={{ left: `${percent(index)}%` }}>
              {index + 1}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 px-4 pt-3 sm:px-6">
        <span className="kicker text-faint">Gerbang</span>
        <span className="h-px flex-1 bg-border" />
        <span className="kicker text-faint">Keluar pabrik</span>
      </div>

      {/* The same numbers as text: one chip per stage. */}
      <ul aria-label="Truk per tahap" aria-busy={loading} className="flex flex-wrap gap-2 px-4 pt-3 pb-4 sm:px-6 sm:pb-6">
        {(stages.length ? stages : Array.from({ length: stageCount }, () => null)).map((stage, index) => {
          if (!stage) {
            return (
              <li key={index}>
                <Skeleton className="h-9 w-32 rounded-full" />
              </li>
            );
          }
          const isPeak = index === peak;
          const isActive = index === active && stage.total > 0;
          const body = (
            <>
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[0.6875rem] font-semibold",
                  isPeak ? "bg-signal text-signal-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              <span className="whitespace-nowrap">{stage.label}</span>
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", stage.total === 0 ? "bg-line-strong" : isPeak ? "bg-signal" : "bg-primary")}
              />
              <span className="font-semibold tabular-nums">{formatNumber(stage.total)}</span>
            </>
          );
          const chip = cn(
            "flex h-9 items-center gap-2 rounded-full border bg-surface pr-3.5 pl-2 text-sm transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            isActive ? "border-line-strong bg-muted text-foreground" : "text-muted-foreground hover:border-line-strong hover:text-foreground",
            stage.total > 0 && "text-foreground",
          );
          const events = {
            onPointerEnter: () => setHovered(index),
            onPointerLeave: () => setHovered(null),
            onFocus: () => setHovered(index),
            onBlur: () => setHovered(null),
          };
          const href = links[stage.key];
          return (
            <li key={stage.key}>
              {href ? (
                <Link href={href} className={chip} {...events} aria-label={`${stage.label}: ${formatNumber(stage.total)} truk. Buka daftarnya`}>
                  {body}
                </Link>
              ) : (
                <button
                  type="button"
                  className={chip}
                  {...events}
                  aria-pressed={pinned === index}
                  onClick={() => setPinned(pinned === index ? null : index)}
                  aria-label={`${stage.label}: ${formatNumber(stage.total)} truk`}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {partial ? (
        <p className="-mt-2 px-4 pb-4 text-xs text-muted-foreground sm:px-6">Dihitung dari 50 truk pertama di tiap daftar.</p>
      ) : null}
    </section>
  );
}
