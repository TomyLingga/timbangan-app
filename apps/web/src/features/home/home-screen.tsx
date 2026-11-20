"use client";

import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, RefreshCw } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { isApiError } from "@/lib/api-client";
import { API_URL } from "@/lib/config";
import { formatDateTime, formatNumber } from "@/lib/format";
import { errorMessage } from "@/lib/messages";
import { isStaff, roleLabels } from "@/lib/roles";
import { api } from "@/lib/session";
import { latestRunPerEntity, syncEntityLabel, syncStatusInfo } from "@/lib/status";
import type { SyncRunList, User } from "@/lib/types";

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b px-4 py-2 sm:px-5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

function AccountPanel({ user }: { user: User }) {
  const roles = roleLabels(user.roles);
  return (
    <Panel title="Akun yang sedang masuk">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">Nama</dt>
        <dd className="font-medium break-words">{user.fullName}</dd>
        <dt className="text-muted-foreground">Nama pengguna</dt>
        <dd className="break-words">{user.username}</dd>
        <dt className="text-muted-foreground">Jenis akun</dt>
        <dd>{user.kind === "INTERNAL" ? "Karyawan INL" : "Perusahaan partner"}</dd>
        {user.partner ? (
          <>
            <dt className="text-muted-foreground">Perusahaan</dt>
            <dd className="break-words">{user.partner.name}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Peran</dt>
        <dd className="flex flex-wrap gap-1.5">
          {roles.length > 0
            ? roles.map((role) => (
                <Badge key={role} variant="outline">
                  {role}
                </Badge>
              ))
            : "-"}
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
      action={
        <Button variant="ghost" size="sm" onClick={health.reload} disabled={health.isLoading}>
          <RefreshCw className={health.isLoading ? "animate-spin" : undefined} aria-hidden="true" />
          Periksa lagi
        </Button>
      }
    >
      <div aria-live="polite" className="text-sm">
        {health.isLoading ? (
          <Skeleton className="h-5 w-40" />
        ) : health.hasError ? (
          <p className="flex items-start gap-2 text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium">Tidak terhubung.</span> {errorMessage(health.error)}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2 text-success">
            <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
            <span className="font-medium">Terhubung</span>
          </p>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Alamat</dt>
        <dd className="break-all">{API_URL}</dd>
        <dt className="text-muted-foreground">Diperiksa</dt>
        <dd className="tabular-nums">
          {health.settledAt ? formatDateTime(new Date(health.settledAt).toISOString()) : "-"}
        </dd>
      </dl>
    </Panel>
  );
}

function SyncPanel() {
  const runs = useApiQuery("sync-runs", (signal) =>
    api.request<SyncRunList>("/api/admin/sync/runs", { query: { limit: 12 }, signal }),
  );
  const latest = runs.data ? latestRunPerEntity(runs.data.items) : [];
  const forbidden = isApiError(runs.error) && runs.error.status === 403;

  return (
    <Panel
      title="Salinan data dari Odoo"
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
        <p className="text-sm text-muted-foreground">Belum ada pengambilan data dari Odoo yang tercatat.</p>
      ) : (
        <ul className="flex flex-col divide-y text-sm">
          {latest.map((run) => (
            <li key={run.id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <span className="font-medium">{syncEntityLabel(run.entity)}</span>
              <StatusBadge info={syncStatusInfo(run.status)} />
              <span className="text-muted-foreground tabular-nums">
                {formatDateTime(run.finishedAt ?? run.startedAt)}
              </span>
              <span className="text-right text-muted-foreground tabular-nums">
                {run.rowsUpserted === null ? "-" : `${formatNumber(run.rowsUpserted)} baris`}
              </span>
              {run.error ? (
                <span className="col-span-2 text-xs break-words text-destructive">Pesan server: {run.error}</span>
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
      <h1 className="text-xl font-semibold tracking-tight">Beranda</h1>
      <div className="grid items-start gap-4 lg:grid-cols-[3fr_2fr]">
        <AccountPanel user={user} />
        <div className="flex flex-col gap-4">
          <HealthPanel />
          {isStaff(user) ? <SyncPanel /> : null}
        </div>
      </div>
    </div>
  );
}
