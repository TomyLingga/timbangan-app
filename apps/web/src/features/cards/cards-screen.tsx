"use client";

import { useId, useState } from "react";
import { Pencil, Plus } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { SelectField, TextAreaField, TextField } from "@/components/form-fields";
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
import { cardSaveErrorMessage } from "@/lib/messages";
import { canManageCards } from "@/lib/roles";
import { api } from "@/lib/session";
import { cardStatusInfo } from "@/lib/status";
import type { Page, RfidCard } from "@/lib/types";
import { cardPayload, validateCard, type CardValues } from "@/lib/workflow-forms";

const LIST_LIMIT = 50;

const STATUS_FILTERS = [
  { value: "AVAILABLE", label: "Tersedia" },
  { value: "IN_USE", label: "Dipakai truk" },
  { value: "LOST", label: "Hilang" },
  { value: "RETIRED", label: "Tidak dipakai lagi" },
];

/** Statuses an admin may set by hand. IN_USE comes only from a check-in. */
const SETTABLE = STATUS_FILTERS.filter((option) => option.value !== "IN_USE");

const COLUMNS: ReadonlyArray<Column<RfidCard>> = [
  {
    id: "uid",
    header: "UID",
    primary: true,
    cell: (card) => (
      <>
        <span className="font-mono font-medium">{card.uid}</span>
        {card.label ? <span className="block text-xs text-muted-foreground">{card.label}</span> : null}
      </>
    ),
  },
  { id: "status", header: "Status", cell: (card) => <StatusBadge info={cardStatusInfo(card.status)} /> },
  {
    id: "trip",
    header: "Dipakai truk",
    cell: (card) =>
      card.trip ? (
        <>
          <span className="font-medium whitespace-nowrap">{card.trip.plateNo ?? "-"}</span>
          {card.trip.tripNo ? <span className="block text-xs text-muted-foreground">{card.trip.tripNo}</span> : null}
        </>
      ) : (
        "-"
      ),
  },
  { id: "note", header: "Catatan", wide: true, cellClassName: "max-w-64 whitespace-normal", cell: (card) => card.note || "-" },
];

function CardFormSheet({
  card,
  onClose,
  onSaved,
}: {
  /** The card being edited, or null for a new one. */
  card: RfidCard | null;
  onClose: () => void;
  onSaved: (card: RfidCard, created: boolean) => void;
}) {
  const creating = card === null;
  const form = useFormValues<CardValues>({
    uid: card?.uid ?? "",
    label: card?.label ?? "",
    note: card?.note ?? "",
    status: card?.status ?? "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();
  const bound = card?.status.toUpperCase() === "IN_USE";

  async function handleSubmit() {
    const errors = validateCard(form.values, creating);
    form.setErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;
    const body = cardPayload(bound ? { ...form.values, status: "" } : form.values, creating);
    const outcome = await save.run(() =>
      card
        ? api.request<{ card: RfidCard }>(`/api/rfid-cards/${encodeURIComponent(String(card.id))}`, { method: "PATCH", body })
        : api.request<{ card: RfidCard }>("/api/rfid-cards", { method: "POST", body }),
    );
    if (outcome.ok) {
      onSaved(outcome.value.card, creating);
    } else {
      form.setErrors(refusedFields<CardValues>(outcome.error));
      setFormError(cardSaveErrorMessage(outcome.error));
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={card ? `Ubah kartu ${card.uid}` : "Kartu baru"}
      description={creating ? "Tempelkan kartu ke pembaca: UID terisi sendiri." : undefined}
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      {creating ? (
        <TextField
          label="UID kartu"
          name="uid"
          value={form.values.uid}
          onChange={(value) => form.set("uid", value)}
          error={form.errors.uid}
          hint="Angka dan huruf A sampai F. Titik dua dan spasi dibuang."
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          className="[&_input]:font-mono [&_input]:uppercase"
        />
      ) : null}
      <TextField
        label="Label"
        name="label"
        optional
        value={form.values.label}
        onChange={(value) => form.set("label", value)}
        error={form.errors.label}
        hint="Nomor yang tertulis di kartu, misalnya Kartu 12."
      />
      {creating ? null : (
        <SelectField
          label="Status"
          name="status"
          value={form.values.status}
          onChange={(value) => form.set("status", value)}
          error={form.errors.status}
          emptyLabel="Pilih status"
          disabled={bound}
          hint={bound ? "Kartu sedang dipakai truk. Statusnya berubah lagi saat kartu dilepas." : undefined}
          options={bound ? STATUS_FILTERS : SETTABLE}
        />
      )}
      <TextAreaField
        label="Catatan"
        name="note"
        optional
        rows={2}
        value={form.values.note}
        onChange={(value) => form.set("note", value)}
        error={form.errors.note}
      />
    </FormSheet>
  );
}

function CardsPage() {
  const ids = useId();
  const [searchText, setSearchText] = useState("");
  const [status, setStatus] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  // undefined: sheet closed, null: new card, otherwise the card being edited
  const [editing, setEditing] = useState<RfidCard | null | undefined>(undefined);

  const search = useDebouncedValue(searchText.trim(), 300);
  const list = useApiQuery(
    `${search}|${status}|${reloadToken}`,
    (signal) => api.request<Page<RfidCard>>("/api/rfid-cards", { query: { q: search, status, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Kartu RFID" description="Kartu yang dibawa truk selama di dalam pabrik. Kartu terikat ke truk saat check-in di pos.">
        <Button onClick={() => setEditing(null)}>
          <Plus aria-hidden="true" />
          Kartu baru
        </Button>
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {saved ? <Notice tone="success">{saved}</Notice> : null}
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <SearchField id={`${ids}-search`} label="Cari kartu" placeholder="UID atau label" value={searchText} onChange={setSearchText} />
        <SelectField
          label="Status"
          name="statusFilter"
          value={status}
          onChange={setStatus}
          emptyLabel="Semua status"
          options={STATUS_FILTERS}
          className="w-full sm:max-w-56"
        />
      </div>

      {list.hasError ? (
        <ListError title="Daftar kartu belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar kartu" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada kartu yang cocok"
          hint={search || status ? "Ubah pencarian atau saringan status." : "Belum ada kartu yang terdaftar."}
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="kartu" />
          <DataList
            columns={COLUMNS}
            rows={list.data.items}
            rowKey={(card) => card.id}
            stale={list.isStale}
            actions={(card) => (
              <Button
                variant="ghost"
                size="sm"
                className="h-10 md:h-8"
                onClick={() => setEditing(card)}
                aria-label={`Ubah kartu ${card.uid}`}
              >
                <Pencil aria-hidden="true" />
                Ubah
              </Button>
            )}
          />
        </div>
      )}

      {editing !== undefined ? (
        <CardFormSheet
          card={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(card, created) => {
            setEditing(undefined);
            setSaved(`Kartu ${card.uid} ${created ? "ditambahkan" : "diperbarui"}.`);
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}
    </div>
  );
}

export function CardsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canManageCards(state.user)) return <AccessDenied reason="Kartu RFID hanya diatur admin logistik." />;
  return <CardsPage />;
}
