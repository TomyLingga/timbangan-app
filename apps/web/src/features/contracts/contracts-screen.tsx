"use client";

import { useId, useState } from "react";
import { CircleAlert, CircleCheck, RefreshCw, Search, X } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/auth-provider";
import { ContractList } from "@/features/contracts/contract-list";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatDuration, formatNumber } from "@/lib/format";
import { syncErrorMessage } from "@/lib/messages";
import { MOTION_FAST } from "@/lib/motion";
import { canSyncOdoo } from "@/lib/roles";
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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Kontrak</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Kontrak disalin dari Odoo dan hanya dibaca di sini.
          </p>
        </div>
        {canSyncOdoo(user) ? (
          <Button variant="outline" onClick={handleSync} disabled={sync.phase === "running"}>
            <RefreshCw className={sync.phase === "running" ? "animate-spin" : undefined} aria-hidden="true" />
            {sync.phase === "running" ? "Mengambil dari Odoo" : "Ambil dari Odoo"}
          </Button>
        ) : null}
      </div>

      <div aria-live="polite">
        {sync.phase === "done" ? (
          <p className="flex items-start gap-2 rounded-md border border-success/30 bg-success-subtle px-3 py-2.5 text-sm text-success">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {syncSummary(sync.result)}
          </p>
        ) : sync.phase === "failed" ? (
          <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2.5 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {sync.message}
          </p>
        ) : null}
      </div>

      <Tabs
        value={direction}
        onValueChange={(value) => {
          if (isDirection(value)) setDirection(value);
        }}
        className="gap-4"
      >
        <TabsList variant="line" className="h-auto w-full justify-start gap-0 rounded-none border-b p-0">
          {TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="h-11 flex-none rounded-none px-3 after:hidden sm:px-4"
            >
              {tab.label}
              {direction === tab.value ? (
                <motion.span
                  layoutId={`${ids}-tab-indicator`}
                  transition={{ duration: MOTION_FAST }}
                  aria-hidden="true"
                  className="absolute inset-x-0 -bottom-px h-0.5 bg-primary"
                />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex w-full flex-col gap-2 sm:max-w-sm">
            <Label htmlFor={`${ids}-search`}>Cari kontrak</Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id={`${ids}-search`}
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                spellCheck={false}
                placeholder="Nomor kontrak atau nama partner"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                className="pr-11 pl-9 [&::-webkit-search-cancel-button]:hidden"
              />
              {searchText ? (
                <button
                  type="button"
                  onClick={() => setSearchText("")}
                  aria-label="Hapus pencarian"
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-10 items-center gap-2.5">
            <Switch id={`${ids}-closed`} checked={includeClosed} onCheckedChange={setIncludeClosed} />
            <Label htmlFor={`${ids}-closed`} className="cursor-pointer py-2 font-normal">
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
