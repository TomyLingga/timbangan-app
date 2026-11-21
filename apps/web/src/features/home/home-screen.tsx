"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CircleAlert, Database, RefreshCw, Server, UserRound } from "lucide-react";

import { CountUp } from "@/components/count-up";
import { Panel } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-provider";
import { TruckFlow } from "@/features/home/truck-flow";
import { useApiQuery, type ApiQuery } from "@/hooks/use-api-query";
import { isApiError } from "@/lib/api-client";
import { API_URL } from "@/lib/config";
import { formatDateTime, formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { accessSummary, canSeeSyncRuns, canView, isStaff } from "@/lib/permissions";
import { api } from "@/lib/session";
import { latestRunPerEntity, runsBySource, syncEntityLabel, syncStatusInfo } from "@/lib/status";
import { countFlow, insideTotal, type FlowAnswer } from "@/lib/truck-flow";
import type { Page, SyncRun, SyncRunList, User } from "@/lib/types";

const PLANT_TIME_ZONE = "Asia/Jakarta";

function todayLabel(): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone: PLANT_TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(),
  );
}

function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("") || "?";
}

// --- today: the truck flow and the key figures, from GET /api/trips/flow ------------

/** A key figure in the line under the title: the number, then what it counts. */
function Figure({ value, label, loading }: { value: number | undefined; label: string; loading: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      {value !== undefined ? (
        <CountUp value={value} className="font-semibold text-foreground tabular-nums" />
      ) : loading ? (
        <Skeleton className="inline-block h-4 w-5 self-center" />
      ) : (
        <span className="font-semibold text-foreground">-</span>
      )}
      {label}
    </span>
  );
}

function Today({ user }: { user: User }) {
  // GET /api/trips/flow: staff, with gate or registrations at view level (the same as the trip list).
  const seesTrips = isStaff(user) && (canView(user, "gate") || canView(user, "registrations"));
  const seesRegistrations = canView(user, "registrations");
  const atPost = isStaff(user) && canView(user, "gate");

  const flow = useApiQuery(seesTrips ? "trip-flow" : null, (signal) => api.request<FlowAnswer>("/api/trips/flow", { signal }));
  const waiting = useApiQuery(seesRegistrations ? "home-waiting" : null, (signal) =>
    api.request<Page<unknown>>("/api/registrations", { query: { status: "SUBMITTED", limit: 1 }, signal }),
  );

  // a partner account gets no trip routes (403); it sees its own registrations and delivery orders
  const partnerView = !isStaff(user);
  const ownRegistrations = useApiQuery(partnerView && seesRegistrations ? "home-own-registrations" : null, (signal) =>
    api.request<Page<unknown>>("/api/registrations", { query: { limit: 1 }, signal }),
  );
  const ownOrders = useApiQuery(partnerView && canView(user, "delivery_orders") ? "home-own-orders" : null, (signal) =>
    api.request<Page<unknown>>("/api/delivery-orders", { query: { limit: 1 }, signal }),
  );

  const counts = useMemo(() => (flow.data ? countFlow(flow.data) : null), [flow.data]);
  const answer = flow.data;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="kicker mb-2 text-primary-ink">Hari ini</p>
          <h1 className="text-[1.875rem] leading-tight font-semibold sm:text-[2.25rem]">Beranda</h1>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.9375rem] text-muted-foreground">
            {seesTrips ? (
              <>
                <Figure value={answer ? answer.upcoming.in + answer.upcoming.out : undefined} label="akan datang" loading={flow.isLoading} />
                <Figure value={answer ? insideTotal(answer) : undefined} label="di dalam pabrik" loading={flow.isLoading} />
                <Figure
                  value={answer ? answer.finishedToday.in + answer.finishedToday.out : undefined}
                  label="selesai hari ini"
                  loading={flow.isLoading}
                />
              </>
            ) : null}
            {partnerView && seesRegistrations ? (
              <Link href="/registrasi" className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                <Figure value={ownRegistrations.data?.total} label="registrasi" loading={ownRegistrations.isLoading} />
              </Link>
            ) : null}
            {partnerView && canView(user, "delivery_orders") ? (
              <Link href="/delivery-order" className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                <Figure value={ownOrders.data?.total} label="delivery order" loading={ownOrders.isLoading} />
              </Link>
            ) : null}
            {seesRegistrations ? (
              <Link href="/registrasi?status=SUBMITTED" className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                <Figure value={waiting.data?.total} label="menunggu tinjauan" loading={waiting.isLoading} />
              </Link>
            ) : null}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{todayLabel()}</p>
      </div>

      {seesTrips ? (
        <TruckFlow
          counts={counts}
          loading={flow.isLoading && !flow.data}
          error={flow.hasError ? errorMessage(flow.error) : null}
          onRetry={flow.reload}
          links={atPost ? { upcoming: "/pos", gate: "/pos" } : {}}
        />
      ) : null}
    </>
  );
}

// --- account, API, sync -----------------------------------------------------------

function AccountPanel({ user }: { user: User }) {
  const summary = accessSummary(user.permissions, [], user.kind);
  const parts = summary.includes(":") ? summary.split(" · ") : [summary];
  return (
    <Panel title="Akun yang sedang masuk" icon={UserRound}>
      <div className="flex items-center gap-4">
        <span
          aria-hidden="true"
          className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-secondary font-mono text-lg font-semibold text-secondary-foreground"
        >
          {initials(user.fullName)}
        </span>
        <div className="min-w-0">
          <p className="display text-xl leading-tight font-semibold wrap-break-word">{user.fullName}</p>
          <p className="mt-0.5 truncate font-mono text-sm text-muted-foreground">{user.username}</p>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 border-t pt-4 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted-foreground">Jenis akun</dt>
        <dd>{user.kind === "INTERNAL" ? "Karyawan INL" : "Perusahaan partner"}</dd>
        {user.partner ? (
          <>
            <dt className="text-muted-foreground">Perusahaan</dt>
            <dd className="wrap-break-word">{user.partner.name}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Hak akses</dt>
        <dd data-testid="access-summary" className="flex flex-wrap gap-1.5">
          {parts.map((part) => (
            <span key={part} className="rounded-sm border bg-surface px-2 py-0.5 text-xs leading-5">
              {part}
            </span>
          ))}
        </dd>
      </dl>
    </Panel>
  );
}

function HealthPanel() {
  const health = useApiQuery("health", (signal) => api.request("/api/health", { auth: false, signal }));

  return (
    <Panel
      title="Server API"
      icon={Server}
      action={
        <Button variant="ghost" size="sm" onClick={health.reload} disabled={health.isLoading}>
          <RefreshCw className={health.isLoading ? "animate-spin" : undefined} aria-hidden="true" />
          Periksa lagi
        </Button>
      }
    >
      <div aria-live="polite" className="text-sm">
        {health.isLoading ? (
          <Skeleton className="h-6 w-32" />
        ) : health.hasError ? (
          <p className="flex items-start gap-2 text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium">Tidak terhubung.</span> {errorMessage(health.error)}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2.5 text-success">
            <span className="relative flex size-2.5" aria-hidden="true">
              <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-40 [animation-duration:2.4s]" />
              <span className="relative size-2.5 rounded-full bg-success" />
            </span>
            <span className="font-medium">Terhubung</span>
          </p>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Alamat</dt>
        <dd className="font-mono text-[0.8125rem] break-all">{API_URL}</dd>
        <dt className="text-muted-foreground">Diperiksa</dt>
        <dd className="tabular-nums">
          {health.settledAt ? formatDateTime(new Date(health.settledAt).toISOString()) : "-"}
        </dd>
      </dl>
    </Panel>
  );
}

type RunsQuery = ApiQuery<SyncRunList>;

/** Odoo (contracts, partners, products) and VCF (drivers, transporters) share one run history. */
function SyncPanels() {
  const runs = useApiQuery("sync-runs", (signal) =>
    api.request<SyncRunList>("/api/admin/sync/runs", { query: { limit: 50 }, signal }),
  );
  const bySource = runsBySource(runs.data?.items ?? []);

  return (
    <>
      <SyncPanel
        title="Salinan data dari Odoo"
        emptyText="Belum ada pengambilan data dari Odoo yang tercatat."
        runs={runs}
        items={bySource.odoo}
      />
      <SyncPanel
        title="Salinan data dari VCF"
        emptyText="Belum ada pengambilan data dari VCF yang tercatat."
        runs={runs}
        items={bySource.vcf}
      />
    </>
  );
}

function SyncPanel({
  title,
  emptyText,
  runs,
  items,
}: {
  title: string;
  emptyText: string;
  runs: RunsQuery;
  items: SyncRun[];
}) {
  const latest = latestRunPerEntity(items);
  const forbidden = isApiError(runs.error) && runs.error.status === 403;

  return (
    <Panel
      title={title}
      icon={Database}
      action={
        <Button variant="ghost" size="sm" onClick={runs.reload} disabled={runs.isLoading}>
          <RefreshCw className={runs.isLoading ? "animate-spin" : undefined} aria-hidden="true" />
          Muat ulang
        </Button>
      }
    >
      {runs.isLoading ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : runs.hasError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {forbidden ? "Riwayat pengambilan data hanya bisa dibuka admin." : errorMessage(runs.error)}
        </p>
      ) : latest.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col divide-y text-sm">
          {latest.map((run) => (
            <li key={run.id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <span className="font-medium">{syncEntityLabel(run.entity)}</span>
              <StatusBadge info={syncStatusInfo(run.status)} />
              <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(run.finishedAt ?? run.startedAt)}</span>
              <span className="text-right font-mono text-xs text-muted-foreground">
                {run.rowsUpserted === null ? "-" : `${formatNumber(run.rowsUpserted)} baris`}
              </span>
              {run.error ? (
                <span className="col-span-2 text-xs wrap-break-word text-destructive">Pesan server: {run.error}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function HomeScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  const { user } = state;

  return (
    <div className="flex flex-col gap-6">
      <Today user={user} />

      <div className="grid items-start gap-5 lg:grid-cols-[3fr_2fr]">
        <AccountPanel user={user} />
        <div className="flex flex-col gap-5">
          <HealthPanel />
          {canSeeSyncRuns(user) ? <SyncPanels /> : null}
        </div>
      </div>
    </div>
  );
}
