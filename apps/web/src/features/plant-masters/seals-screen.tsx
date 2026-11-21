"use client";

import { useId, useState } from "react";
import { Ban, Plus } from "lucide-react";

import { ActionSheet } from "@/components/action-sheet";
import { DataList, type Column } from "@/components/data-list";
import { TextField } from "@/components/form-fields";
import { FilterChips } from "@/components/filter-chips";
import { FormSheet } from "@/components/form-sheet";
import { AccessDenied, ListEmpty, ListError, ListSkeleton, Notice, PageHeader, ResultCount, SearchField } from "@/components/page-parts";
import { Segmented } from "@/components/segmented";
import { StatusBadge } from "@/components/status-badge";
import { TotalFigure } from "@/components/total-figure";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useAction } from "@/hooks/use-form";
import { useUrlFilter } from "@/hooks/use-url-filter";
import { isApiError } from "@/lib/api-client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { canAddSeals, canSeePlantMasters, canVoidSeals } from "@/lib/permissions";
import { SEAL_KINDS, SEAL_STATUS_FILTERS, sealBatchPreview, type SealBatchField, type SealBatchValues } from "@/lib/plant-masters";
import { api } from "@/lib/session";
import { sealStatusInfo } from "@/lib/status";
import type { Page, Seal, SealBatchResult, User } from "@/lib/types";

const LIST_LIMIT = 50;
const kindLabel = (kind: string) => SEAL_KINDS.find((item) => item.value === kind)?.label ?? kind;

const COLUMNS: ReadonlyArray<Column<Seal>> = [
  {
    id: "no",
    header: "Nomor segel",
    primary: true,
    cell: (seal) => (
      <>
        <span className="font-mono font-medium">{seal.sealNo}</span>
        <span className="block text-xs text-muted-foreground">{kindLabel(seal.kind)}</span>
      </>
    ),
  },
  { id: "status", header: "Status", cell: (seal) => <StatusBadge info={sealStatusInfo(seal.status)} /> },
  {
    id: "trip",
    header: "Dipakai truk",
    cell: (seal) =>
      seal.trip ? (
        <>
          <span className="font-medium whitespace-nowrap">{seal.trip.plateNo ?? "-"}</span>
          {seal.trip.tripNo ? <span className="block text-xs text-muted-foreground">{seal.trip.tripNo}</span> : null}
        </>
      ) : (
        "-"
      ),
  },
  { id: "batch", header: "Gulungan", cell: (seal) => <span className="font-mono text-xs">{seal.batchRef ?? "-"}</span> },
  { id: "created", header: "Ditambahkan", cell: (seal) => <span className="whitespace-nowrap tabular-nums">{formatDateTime(seal.createdAt)}</span> },
];

function SealBatchSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (result: SealBatchResult) => void }) {
  const [values, setValues] = useState<SealBatchValues>({ kind: "LOCIS", prefix: "", from: "1", to: "", width: "6" });
  const [errors, setErrors] = useState<Partial<Record<SealBatchField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();
  const preview = sealBatchPreview(values);
  const set = (field: keyof SealBatchValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  async function handleSubmit() {
    setFormError(null);
    if (!preview.ok) {
      setErrors(preview.errors);
      return;
    }
    const outcome = await save.run(() => api.request<SealBatchResult>("/api/seals/batch", { method: "POST", body: preview.body }));
    if (outcome.ok) onSaved(outcome.value);
    else {
      const error = outcome.error;
      if (isApiError(error) && error.code === "VALIDATION") {
        setErrors(error.fieldMessages as Partial<Record<SealBatchField, string>>);
        setFormError("Periksa kolom yang ditandai.");
      } else setFormError("Segel belum bisa ditambahkan. Coba lagi.");
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Tambah segel"
      description="Satu gulungan segel: awalan dan nomor urut. Nomor yang sudah ada di stok dilewati."
      submitLabel="Tambah segel"
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Jenis segel</span>
        <Segmented label="Jenis segel" options={SEAL_KINDS} value={values.kind as "LOCIS" | "CUSTOMS"} onChange={(value) => set("kind", value)} />
      </div>
      <TextField
        label="Awalan"
        name="prefix"
        optional
        value={values.prefix}
        onChange={(value) => set("prefix", value)}
        error={errors.prefix}
        hint="Huruf di depan nomor, misalnya LC-."
        autoCapitalize="characters"
        className="[&_input]:font-mono [&_input]:uppercase"
      />
      <div className="grid grid-cols-2 gap-4">
        <TextField label="Nomor awal" name="from" inputMode="numeric" value={values.from} onChange={(value) => set("from", value)} error={errors.from} />
        <TextField label="Nomor akhir" name="to" inputMode="numeric" value={values.to} onChange={(value) => set("to", value)} error={errors.to} />
      </div>
      <TextField
        label="Lebar angka"
        name="width"
        inputMode="numeric"
        value={values.width}
        onChange={(value) => set("width", value)}
        error={errors.width}
        hint="Jumlah digit nomor, diisi nol di depan."
      />
      <p className="rounded-md bg-muted px-3 py-2.5 text-sm" data-testid="seal-preview" aria-live="polite">
        {preview.ok
          ? `${preview.first} sampai ${preview.last}: ${formatNumber(preview.count)} segel.`
          : "Isi nomor awal, nomor akhir, dan lebar angka untuk melihat nomornya."}
      </p>
    </FormSheet>
  );
}

function SealsPage({ user }: { user: User }) {
  const ids = useId();
  const [searchText, setSearchText] = useUrlFilter("q");
  const [status, setStatus] = useUrlFilter("status");
  const [reloadToken, setReloadToken] = useState(0);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Seal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const search = useDebouncedValue(searchText.trim(), 300);

  const list = useApiQuery(
    `${search}|${status}|${reloadToken}`,
    (signal) => api.request<Page<Seal>>("/api/seals", { query: { q: search, status, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );
  const mayVoid = canVoidSeals(user);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Segel"
        figures={list.data ? <TotalFigure value={list.data.total} noun="segel" /> : null}
        description="Stok nomor segel yang diambil petugas segel saat menyegel truk."
      >
        {canAddSeals(user) ? (
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Tambah segel
          </Button>
        ) : null}
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <SearchField id={`${ids}-search`} label="Cari segel" placeholder="Nomor segel" value={searchText} onChange={setSearchText} />
        <FilterChips label="Saring menurut status" caption="Status" filters={SEAL_STATUS_FILTERS} selected={status as (typeof SEAL_STATUS_FILTERS)[number]["value"]} onSelect={setStatus} />
      </div>

      {list.hasError ? (
        <ListError title="Daftar segel belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar segel" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty title="Tidak ada segel yang cocok" hint={search || status ? "Ubah pencarian atau saringan status." : "Belum ada segel di stok."} stale={list.isStale} />
      ) : (
        <div className="flex flex-col gap-3" data-testid="seal-list">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="segel" />
          <DataList
            columns={COLUMNS}
            rows={list.data.items}
            rowKey={(seal) => seal.id}
            stale={list.isStale}
            actions={
              mayVoid
                ? (seal) =>
                    seal.status.toUpperCase() === "AVAILABLE" ? (
                      <Button variant="ghost" size="sm" className="h-10 md:h-8" onClick={() => setVoiding(seal)} aria-label={`Batalkan segel ${seal.sealNo}`}>
                        <Ban aria-hidden="true" />
                        Batalkan
                      </Button>
                    ) : null
                : undefined
            }
          />
        </div>
      )}

      {adding ? (
        <SealBatchSheet
          onClose={() => setAdding(false)}
          onSaved={(result) => {
            setAdding(false);
            setNotice(
              `${formatNumber(result.created)} segel ditambahkan (${result.first} sampai ${result.last})` +
                (result.skipped > 0 ? `, ${formatNumber(result.skipped)} dilewati karena sudah ada.` : "."),
            );
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}

      {voiding ? (
        <ActionSheet
          title={`Batalkan segel ${voiding.sealNo}?`}
          description="Segel yang dibatalkan tidak bisa dipakai lagi dan tidak bisa dikembalikan ke stok."
          submitLabel="Batalkan segel"
          onClose={() => setVoiding(null)}
          onConfirm={async () => {
            try {
              await api.request(`/api/seals/${encodeURIComponent(String(voiding.id))}`, { method: "PATCH", body: { status: "VOID" } });
              setNotice(`Segel ${voiding.sealNo} dibatalkan.`);
              setVoiding(null);
              setReloadToken((token) => token + 1);
              return null;
            } catch (error) {
              return isApiError(error) && error.code === "INVALID_STATE" ? error.message : "Segel belum bisa dibatalkan. Coba lagi.";
            }
          }}
        />
      ) : null}
    </div>
  );
}

export function SealsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canSeePlantMasters(state.user)) return <AccessDenied module="plant_masters" />;
  return <SealsPage user={state.user} />;
}
