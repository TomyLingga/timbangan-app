"use client";

import { useId, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField } from "@/components/form-fields";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, ResultCount, SearchField } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { TotalFigure } from "@/components/total-figure";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUrlFilter } from "@/hooks/use-url-filter";
import { formatNumber } from "@/lib/format";
import { syncErrorMessage } from "@/lib/messages";
import { canSeePlantMasters, canSyncOdoo, canToggleTanks } from "@/lib/permissions";
import { tankProductText, tankSyncSummary } from "@/lib/plant-masters";
import { api } from "@/lib/session";
import type { StorageTank, SyncResult, User } from "@/lib/types";

const ACTIVE_FILTERS = [
  { value: "true", label: "Aktif" },
  { value: "false", label: "Nonaktif" },
];

type SyncState = { phase: "idle" } | { phase: "running" } | { phase: "done"; text: string } | { phase: "failed"; text: string };

function TanksPage({ user }: { user: User }) {
  const ids = useId();
  const [searchText, setSearchText] = useUrlFilter("q");
  const [active, setActive] = useUrlFilter("aktif");
  const [reloadToken, setReloadToken] = useState(0);
  const [togglingId, setTogglingId] = useState<string | number | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [sync, setSync] = useState<SyncState>({ phase: "idle" });
  const search = useDebouncedValue(searchText.trim(), 300);
  const mayToggle = canToggleTanks(user);

  const list = useApiQuery(
    `${search}|${active}|${reloadToken}`,
    (signal) => api.request<{ items: StorageTank[] }>("/api/tanks", { query: { q: search, active }, signal }),
    { keepPrevious: true },
  );

  async function toggle(tank: StorageTank, isActive: boolean) {
    setTogglingId(tank.id);
    setNotice(null);
    try {
      await api.request(`/api/tanks/${encodeURIComponent(String(tank.id))}`, { method: "PATCH", body: { isActive } });
      setNotice({ tone: "success", text: `Tangki ${tank.code} ${isActive ? "diaktifkan" : "dinonaktifkan"}.` });
      setReloadToken((token) => token + 1);
    } catch {
      setNotice({ tone: "error", text: `Tangki ${tank.code} belum bisa diubah. Coba lagi.` });
    } finally {
      setTogglingId(null);
    }
  }

  async function runSync() {
    if (sync.phase === "running") return;
    setSync({ phase: "running" });
    try {
      const result = await api.request<SyncResult>("/api/admin/sync/odoo", { method: "POST" });
      setSync({ phase: "done", text: tankSyncSummary(result.tanks) });
      setReloadToken((token) => token + 1);
    } catch (error) {
      setSync({ phase: "failed", text: syncErrorMessage(error) });
    }
  }

  const columns = useMemo<ReadonlyArray<Column<StorageTank>>>(
    () => [
      {
        id: "code",
        header: "Kode",
        primary: true,
        cell: (tank) => (
          <>
            <span className="font-mono font-medium">{tank.code}</span>
            <span className="block text-xs text-muted-foreground">{tank.source === "ODOO" ? "Dari Odoo" : "Dibuat di aplikasi ini"}</span>
          </>
        ),
      },
      { id: "name", header: "Nama", wide: true, cellClassName: "max-w-72 whitespace-normal wrap-break-word", cell: (tank) => tank.name ?? "-" },
      {
        id: "product",
        header: "Produk",
        cell: (tank) => (
          <>
            <span className="block">{tankProductText(tank)}</span>
            {!tank.product && tank.productLabel ? <span className="block text-xs text-muted-foreground">Nama produk dari Odoo</span> : null}
          </>
        ),
      },
      {
        id: "capacity",
        header: "Kapasitas",
        align: "right",
        cell: (tank) => (tank.capacityKg === null ? "-" : <span className="tabular-nums">{formatNumber(tank.capacityKg)} kg</span>),
      },
      { id: "source", header: "Sumber", cell: (tank) => <StatusBadge info={tank.source === "ODOO" ? { label: "Odoo", tone: "success" } : { label: "Lokal", tone: "neutral" }} /> },
      {
        id: "active",
        header: "Aktif",
        cell: (tank) => (
          <span className="flex items-center gap-2">
            <Switch
              checked={tank.isActive}
              disabled={!mayToggle || togglingId === tank.id}
              onCheckedChange={(checked) => void toggle(tank, checked)}
              aria-label={`Tangki ${tank.code} aktif`}
            />
            <span className="text-muted-foreground">{tank.isActive ? "Aktif" : "Nonaktif"}</span>
          </span>
        ),
      },
    ],
    [mayToggle, togglingId],
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Tangki"
        figures={list.data ? <TotalFigure value={list.data.items.length} noun="tangki" /> : null}
        description="Tangki timbun tempat muat dan bongkar. Form bongkar dan QC loading memilih tangki menurut produk truk."
      >
        {canSyncOdoo(user) ? (
          <Button variant="outline" onClick={() => void runSync()} disabled={sync.phase === "running"}>
            <RefreshCw className={sync.phase === "running" ? "animate-spin" : undefined} aria-hidden="true" />
            {sync.phase === "running" ? "Mengambil dari Odoo" : "Ambil dari Odoo"}
          </Button>
        ) : null}
      </PageHeader>

      <Notice tone="warning">
        Data tangki dikelola di Odoo. Kode, nama, dan produk diubah di Odoo lalu diambil ulang ke sini; di aplikasi ini tangki hanya bisa diaktifkan atau dinonaktifkan.
      </Notice>

      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {sync.phase === "done" ? <Notice tone="success">{sync.text}</Notice> : null}
        {sync.phase === "failed" ? <Notice tone="error">{sync.text}</Notice> : null}
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <SearchField id={`${ids}-search`} label="Cari tangki" placeholder="Kode, nama, atau produk" value={searchText} onChange={setSearchText} />
        <SelectField
          label="Status"
          name="activeFilter"
          value={active}
          onChange={setActive}
          emptyLabel="Semua tangki"
          options={ACTIVE_FILTERS}
          className="w-full sm:max-w-56"
        />
      </div>

      {list.hasError ? (
        <ListError title="Daftar tangki belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar tangki" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada tangki yang cocok"
          hint={search || active ? "Ubah pencarian atau saringan status." : "Belum ada tangki. Ambil dari Odoo bila lokasi induk tangki sudah diatur di server."}
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3" data-testid="tank-list">
          <ResultCount shown={list.data.items.length} total={list.data.items.length} noun="tangki" />
          <DataList columns={columns} rows={list.data.items} rowKey={(tank) => tank.id} stale={list.isStale} />
        </div>
      )}
    </div>
  );
}

export function TanksScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canSeePlantMasters(state.user)) return <AccessDenied module="plant_masters" />;
  return <TanksPage user={state.user} />;
}
