"use client";

import Link from "next/link";
import { CircleAlert, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { STAGES, type FlowCounts, type StageKey } from "@/lib/truck-flow";
import { cn } from "@/lib/utils";

// Beranda for staff who see the trip list but not the control room: the trucks per stage as a plain list, from
// GET /api/trips/flow. No drawing and no animation; the stage with the most trucks is marked.

export interface StageListProps {
  counts: FlowCounts | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** A page that lists the trucks of a stage, where one exists. */
  links: Partial<Record<StageKey, string>>;
}

export function StageList({ counts, loading, error, onRetry, links }: StageListProps) {
  const stages = counts?.stages ?? null;
  const peak = counts?.peak ?? null;
  return (
    <section aria-labelledby="tahap-judul" className="rounded-3xl border bg-card p-4 shadow-panel sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="tahap-judul" className="text-base font-semibold">
          Truk per tahap
        </h2>
        <p className="text-xs text-muted-foreground">Dari gerbang sampai keluar, hari ini</p>
      </div>

      {error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Coba lagi
          </Button>
        </div>
      ) : (
        <ol aria-label="Truk per tahap" aria-busy={loading} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          {STAGES.map((stage, index) => {
            const count = stages?.[index] ?? null;
            const isPeak = index === peak;
            const href = links[stage.key];
            const body = (
              <>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="font-mono text-faint">{index + 1}</span>
                  <span className="truncate">{stage.label}</span>
                </span>
                {count ? (
                  <>
                    <span className={cn("display mt-1 block text-2xl leading-none font-semibold tabular-nums", count.total === 0 && "text-faint")}>
                      {formatNumber(count.total)}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
                      {formatNumber(count.incoming)} in · {formatNumber(count.outgoing)} out
                    </span>
                  </>
                ) : loading ? (
                  <Skeleton className="mt-1.5 h-6 w-10" />
                ) : (
                  <span className="mt-1 block text-2xl leading-none text-faint">-</span>
                )}
              </>
            );
            const box = cn(
              "block h-full min-w-0 rounded-2xl border bg-surface px-3 py-2.5",
              isPeak && "border-signal/50 bg-signal-subtle",
            );
            return (
              <li key={stage.key}>
                {href ? (
                  <Link
                    href={href}
                    className={cn(box, "outline-none hover:border-line-strong focus-visible:ring-3 focus-visible:ring-ring/50")}
                    aria-label={`${stage.label}: ${formatNumber(count?.total ?? 0)} truk. Buka daftarnya`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={box}>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {counts && counts.unplaced > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="flow-unplaced">
          {formatNumber(counts.unplaced)} truk di dalam pabrik berada di langkah yang belum dikenal halaman ini, jadi tidak dihitung di atas.
        </p>
      ) : null}
    </section>
  );
}
