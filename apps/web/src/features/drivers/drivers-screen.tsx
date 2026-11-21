"use client";

import { useId, useState } from "react";
import { CircleAlert, Clock, Plus, RefreshCw } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { ExpiryDate } from "@/components/expiry-date";
import { SelectField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import {
  AccessDenied,
  ListEmpty,
  ListError,
  ListSkeleton,
  Notice,
  PageHeader,
  ResultCount,
  SearchField,
} from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { refusedFields, useAction, useFormValues } from "@/hooks/use-form";
import { formatDateTime, formatNumber } from "@/lib/format";
import { driverPayload, EMPTY_DRIVER, LICENCE_CLASSES, validateDriver, type DriverValues } from "@/lib/forms";
import { saveErrorMessage, vcfSyncErrorMessage } from "@/lib/messages";
import { canSyncVcf, canWriteDrivers, isStaff } from "@/lib/roles";
import { api } from "@/lib/session";
import { latestRunPerEntity, registryStatusInfo, runsBySource } from "@/lib/status";
import type { Driver, Page, RegistryPush, RegistryStatus, SyncRunList, User, VcfSyncResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { driverSavedMessage, registryPushInfo, vcfSyncSummary } from "@/lib/vcf";

const LIST_LIMIT = 50;

const STATUS_FILTERS: ReadonlyArray<{ value: RegistryStatus | ""; label: string }> = [
  { value: "", label: "Semua" },
  { value: "NORMAL", label: "Normal" },
  { value: "WARNING", label: "Warning" },
  { value: "BLACKLIST", label: "Blacklist" },
  { value: "UNKNOWN", label: "Belum ada di VCF" },
];

const PUSH_FILTERS: ReadonlyArray<{ value: RegistryPush | ""; label: string }> = [
  { value: "", label: "Semua" },
  { value: "PENDING", label: "Menunggu dikirim" },
  { value: "FAILED", label: "Gagal dikirim" },
];

/** Second, smaller mark under the VCF status: still to be sent, or failed (reason on request). */
function PushState({ driver }: { driver: Driver }) {
  const [showReason, setShowReason] = useState(false);
  const reasonId = useId();
  const info = registryPushInfo(driver.registryPush);
  if (!info) return null;

  const failed = info.tone === "destructive";
  const Icon = failed ? CircleAlert : Clock;
  const reason = driver.registryPushError?.trim();
  return (
    <span className="mt-1.5 flex flex-col items-start gap-0.5">
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium",
          failed ? "text-destructive" : info.tone === "warning" ? "text-warning" : "text-muted-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {info.label}
      </span>
      {failed ? (
        <>
          <button
            type="button"
            aria-expanded={showReason}
            aria-controls={reasonId}
            onClick={() => setShowReason((shown) => !shown)}
            className="-mx-1 inline-flex min-h-8 items-center rounded px-1 text-xs text-foreground underline underline-offset-2 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {showReason ? "Sembunyikan alasan" : "Lihat alasan"}
          </button>
          <span id={reasonId} hidden={!showReason} className="max-w-64 text-xs whitespace-normal text-muted-foreground">
            {reason ? `Pesan server: ${reason}` : "Server tidak memberi alasan."}
          </span>
        </>
      ) : null}
    </span>
  );
}

const COLUMNS: ReadonlyArray<Column<Driver>> = [
  {
    id: "name",
    header: "Nama",
    primary: true,
    cell: (driver) => (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{driver.fullName}</span>
        {driver.isActive ? null : <StatusBadge info={{ label: "Nonaktif", tone: "neutral" }} />}
      </span>
    ),
  },
  { id: "licenceNo", header: "Nomor SIM", cell: (driver) => <span className="tabular-nums">{driver.licenceNo}</span> },
  { id: "licenceClass", header: "Jenis SIM", cell: (driver) => driver.licenceClass || "-" },
  {
    id: "validUntil",
    header: "SIM berlaku sampai",
    cell: (driver) => <ExpiryDate value={driver.licenceValidUntil} expired={driver.licenceExpired} />,
  },
  {
    id: "status",
    header: "Status VCF",
    cell: (driver) => (
      <>
        <StatusBadge info={registryStatusInfo(driver.registryStatus)} />
        <PushState driver={driver} />
      </>
    ),
  },
];

interface DriverFilter {
  search: string;
  status: string;
  push: string;
}

function fetchDrivers({ search, status, push }: DriverFilter, limit: number, signal: AbortSignal) {
  return api.request<Page<Driver>>("/api/drivers", { query: { q: search, status, push, limit }, signal });
}

/** Totals per chip. The list has no totals per value, so each chip asks for one row and reads `total`. */
async function countPerValue(
  values: readonly string[],
  filterFor: (value: string) => DriverFilter,
  signal: AbortSignal,
): Promise<Record<string, number>> {
  const pages = await Promise.all(values.map((value) => fetchDrivers(filterFor(value), 1, signal)));
  return Object.fromEntries(values.map((value, index) => [value, pages[index].total]));
}

function FilterChips<T extends string>({
  label,
  caption,
  filters,
  selected,
  counts,
  onSelect,
}: {
  label: string;
  caption: string;
  filters: ReadonlyArray<{ value: T; label: string }>;
  selected: T;
  counts: Record<string, number> | undefined;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
        {caption}
      </span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-2">
        {filters.map((filter) => {
          const pressed = selected === filter.value;
          const count = counts?.[filter.value];
          return (
            <button
              key={filter.value || "all"}
              type="button"
              aria-pressed={pressed}
              onClick={() => onSelect(filter.value)}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm transition-colors duration-150 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                pressed
                  ? "border-transparent bg-secondary font-medium text-secondary-foreground"
                  : "bg-card text-foreground hover:bg-muted",
              )}
            >
              {filter.label}
              <span className={cn("tabular-nums", pressed ? "text-secondary-foreground/80" : "text-muted-foreground")}>
                {count === undefined ? "…" : formatNumber(count)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DriverFormSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (driver: Driver) => void }) {
  const form = useFormValues<DriverValues>(EMPTY_DRIVER);
  const save = useAction();
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit() {
    const errors = validateDriver(form.values);
    form.setErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    const outcome = await save.run(() =>
      api.request<{ driver: Driver }>("/api/drivers", { method: "POST", body: driverPayload(form.values) }),
    );
    if (outcome.ok) {
      onSaved(outcome.value.driver);
    } else {
      form.setErrors(refusedFields(outcome.error));
      setFormError(saveErrorMessage(outcome.error, "Nomor SIM ini sudah terdaftar."));
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Supir baru"
      description="Supir yang ditambahkan di sini juga dikirim ke VCF."
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <TextField
        label="Nama"
        name="fullName"
        value={form.values.fullName}
        onChange={(value) => form.set("fullName", value)}
        error={form.errors.fullName}
        autoCapitalize="words"
      />
      <TextField
        label="Nomor SIM"
        name="licenceNo"
        value={form.values.licenceNo}
        onChange={(value) => form.set("licenceNo", value)}
        error={form.errors.licenceNo}
        autoCapitalize="characters"
        spellCheck={false}
      />
      <SelectField
        label="Jenis SIM"
        name="licenceClass"
        value={form.values.licenceClass}
        onChange={(value) => form.set("licenceClass", value)}
        error={form.errors.licenceClass}
        emptyLabel="Pilih jenis SIM"
        options={LICENCE_CLASSES.map((code) => ({ value: code, label: code }))}
      />
      <TextField
        label="Tanggal berlaku SIM"
        name="licenceValidUntil"
        type="date"
        value={form.values.licenceValidUntil}
        onChange={(value) => form.set("licenceValidUntil", value)}
        error={form.errors.licenceValidUntil}
      />
      <TextField
        label="Telepon"
        name="phone"
        type="tel"
        inputMode="tel"
        optional
        value={form.values.phone}
        onChange={(value) => form.set("phone", value)}
        error={form.errors.phone}
      />
    </FormSheet>
  );
}

type SyncState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: VcfSyncResult }
  | { phase: "failed"; message: string };

function DriversPage({ user }: { user: User }) {
  const ids = useId();
  const [searchText, setSearchText] = useState("");
  const [status, setStatus] = useState<RegistryStatus | "">("");
  const [push, setPush] = useState<RegistryPush | "">("");
  const [reloadToken, setReloadToken] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [saved, setSaved] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [sync, setSync] = useState<SyncState>({ phase: "idle" });

  const search = useDebouncedValue(searchText.trim(), 300);

  const list = useApiQuery(
    `${search}|${status}|${push}|${reloadToken}`,
    (signal) => fetchDrivers({ search, status, push }, LIST_LIMIT, signal),
    { keepPrevious: true },
  );

  // Each chip row counts with the other row's choice applied, so the numbers match what a click shows.
  const statusCounts = useApiQuery(
    `${search}|${push}|${reloadToken}`,
    (signal) =>
      countPerValue(
        STATUS_FILTERS.map((filter) => filter.value),
        (value) => ({ search, status: value, push }),
        signal,
      ),
    { keepPrevious: true },
  );
  const pushCounts = useApiQuery(
    `${search}|${status}|${reloadToken}`,
    (signal) =>
      countPerValue(
        PUSH_FILTERS.map((filter) => filter.value),
        (value) => ({ search, status, push: value }),
        signal,
      ),
    { keepPrevious: true },
  );

  const runs = useApiQuery(`runs|${reloadToken}`, (signal) =>
    api.request<SyncRunList>("/api/admin/sync/runs", { query: { limit: 50 }, signal }),
  );
  const lastDriverRun = runs.data
    ? latestRunPerEntity(runsBySource(runs.data.items).vcf).find((run) => run.entity.toLowerCase().startsWith("driver"))
    : undefined;

  async function handleSync() {
    if (sync.phase === "running") return;
    setSync({ phase: "running" });
    setSaved(null);
    try {
      const result = await api.request<VcfSyncResult>("/api/admin/sync/vcf", { method: "POST" });
      setSync({ phase: "done", result });
      setReloadToken((token) => token + 1);
    } catch (error) {
      setSync({ phase: "failed", message: vcfSyncErrorMessage(error) });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Supir"
        description={
          <>
            Data supir dan statusnya di VCF.{" "}
            {lastDriverRun ? (
              <span className="whitespace-nowrap">
                Terakhir diambil dari VCF {formatDateTime(lastDriverRun.finishedAt ?? lastDriverRun.startedAt)}.
              </span>
            ) : runs.data ? (
              "Belum pernah diambil dari VCF."
            ) : null}
          </>
        }
      >
        {canSyncVcf(user) ? (
          <Button variant="outline" onClick={handleSync} disabled={sync.phase === "running"}>
            <RefreshCw className={sync.phase === "running" ? "animate-spin" : undefined} aria-hidden="true" />
            {sync.phase === "running" ? "Mengambil dari VCF" : "Ambil dari VCF"}
          </Button>
        ) : null}
        {canWriteDrivers(user) ? (
          <Button onClick={() => setFormOpen(true)}>
            <Plus aria-hidden="true" />
            Supir baru
          </Button>
        ) : null}
      </PageHeader>

      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {sync.phase === "done" ? (
          <Notice tone="success">{vcfSyncSummary(sync.result)}</Notice>
        ) : sync.phase === "failed" ? (
          <Notice tone="error">{sync.message}</Notice>
        ) : null}
        {saved ? <Notice tone={saved.tone}>{saved.text}</Notice> : null}
      </div>

      <div className="flex flex-col gap-4">
        <SearchField
          id={`${ids}-search`}
          label="Cari supir"
          placeholder="Nama atau nomor SIM"
          value={searchText}
          onChange={setSearchText}
        />
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          <FilterChips
            label="Saring menurut status VCF"
            caption="Status VCF"
            filters={STATUS_FILTERS}
            selected={status}
            counts={statusCounts.data}
            onSelect={setStatus}
          />
          <FilterChips
            label="Saring menurut pengiriman ke VCF"
            caption="Pengiriman ke VCF"
            filters={PUSH_FILTERS}
            selected={push}
            counts={pushCounts.data}
            onSelect={setPush}
          />
        </div>
      </div>

      {list.hasError ? (
        <ListError title="Daftar supir belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar supir" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada supir yang cocok"
          hint={
            search
              ? "Periksa lagi nama atau nomor SIM yang dicari."
              : status || push
                ? "Tidak ada supir dengan pilihan saringan ini."
                : "Belum ada data supir. Ambil dari VCF atau tambahkan supir baru."
          }
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="supir" />
          <DataList columns={COLUMNS} rows={list.data.items} rowKey={(driver) => driver.id} stale={list.isStale} />
        </div>
      )}

      {formOpen ? (
        <DriverFormSheet
          onClose={() => setFormOpen(false)}
          onSaved={(driver) => {
            setFormOpen(false);
            setSync({ phase: "idle" });
            const failed = registryPushInfo(driver.registryPush)?.tone === "destructive";
            setSaved({ tone: failed ? "error" : "success", text: driverSavedMessage(driver) });
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}
    </div>
  );
}

export function DriversScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!isStaff(state.user)) return <AccessDenied reason="Data supir hanya bisa dibuka karyawan." />;
  return <DriversPage user={state.user} />;
}
