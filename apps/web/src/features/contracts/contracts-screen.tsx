"use client";

import { useId, useState } from "react";
import { RefreshCw } from "lucide-react";
import { motion } from "motion/react";

import { AccessDenied, Notice, PageHeader, SearchField } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/auth-provider";
import { ContractList } from "@/features/contracts/contract-list";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatDuration, formatNumber } from "@/lib/format";
import { syncErrorMessage } from "@/lib/messages";
import { MOTION_SPRING } from "@/lib/motion";
import { canSyncOdoo, canView } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { Direction, SyncResult } from "@/lib/types";

const SEARCH_DEBOUNCE_MS = 300;

const TABS: ReadonlyArray<{ value: Direction; label: string }> = [
  { value: "IN", label: "Incoming (pembelian)" },
  { value: "OUT", label: "Outgoing (penjualan)" },
];

type SyncState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: SyncResult }
  | { phase: "failed"; message: string };

function isDirection(value: string): value is Direction {
  return value === "IN" || value === "OUT";
}

function syncSummary(result: SyncResult): string {
  const copied = [
    `${formatNumber(result.contracts)} kontrak`,
    `${formatNumber(result.partners)} partner`,
    `${formatNumber(result.products)} barang`,
  ].join(", ");
  const skipped = result.skipped > 0 ? ` Dilewati: ${formatNumber(result.skipped)}.` : "";
  return `Selesai dalam ${formatDuration(result.durationMs)}. Disalin dari Odoo: ${copied}.${skipped}`;
}

export function ContractsScreen() {
  const { state } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;

  const [direction, setDirection] = useState<Direction>("IN");
  const [searchText, setSearchText] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [sync, setSync] = useState<SyncState>({ phase: "idle" });

  const search = useDebouncedValue(searchText.trim(), SEARCH_DEBOUNCE_MS);
  const ids = useId();

  async function handleSync() {
    if (sync.phase === "running") return;
    setSync({ phase: "running" });
    try {
      const result = await api.request<SyncResult>("/api/admin/sync/odoo", { method: "POST" });
      setSync({ phase: "done", result });
      setReloadToken((token) => token + 1);
    } catch (error) {
      setSync({ phase: "failed", message: syncErrorMessage(error) });
    }
  }

  if (!user) return null;
  if (!canView(user, "contracts")) return <AccessDenied module="contracts" />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Kontrak" description="Kontrak disalin dari Odoo dan hanya dibaca di sini.">
        {canSyncOdoo(user) ? (
          <Button variant="outline" onClick={handleSync} disabled={sync.phase === "running"}>
            <RefreshCw className={sync.phase === "running" ? "animate-spin" : undefined} aria-hidden="true" />
            {sync.phase === "running" ? "Mengambil dari Odoo" : "Ambil dari Odoo"}
          </Button>
        ) : null}
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {sync.phase === "done" ? (
          <Notice tone="success">{syncSummary(sync.result)}</Notice>
        ) : sync.phase === "failed" ? (
          <Notice tone="error">{sync.message}</Notice>
        ) : null}
      </div>

      <Tabs
        value={direction}
        onValueChange={(value) => {
          if (isDirection(value)) setDirection(value);
        }}
        className="gap-5"
      >
        <TabsList className="h-auto w-fit group-data-horizontal/tabs:h-auto max-w-full gap-1 self-start rounded-full border bg-surface p-1">
          {TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="h-9 flex-none rounded-full border-0 px-4 text-sm transition-colors duration-150 data-active:bg-transparent data-active:text-primary-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent dark:data-active:text-primary-foreground"
            >
              {direction === tab.value ? (
                <motion.span
                  layoutId={`${ids}-tab-indicator`}
                  transition={MOTION_SPRING}
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-primary"
                />
              ) : null}
              <span className="relative">{tab.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <SearchField
            id={`${ids}-search`}
            label="Cari kontrak"
            placeholder="Nomor kontrak atau nama partner"
            value={searchText}
            onChange={setSearchText}
          />

          <div className="flex min-h-10 items-center gap-2.5 rounded-md border bg-card px-3 shadow-panel">
            <Switch id={`${ids}-closed`} checked={includeClosed} onCheckedChange={setIncludeClosed} />
            <Label htmlFor={`${ids}-closed`} className="cursor-pointer py-2.5 font-normal">
              Tampilkan yang sudah tutup
            </Label>
          </div>
        </div>

        {TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <ContractList
              direction={tab.value}
              search={search}
              includeClosed={includeClosed}
              reloadToken={reloadToken}
              onClearSearch={() => setSearchText("")}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
