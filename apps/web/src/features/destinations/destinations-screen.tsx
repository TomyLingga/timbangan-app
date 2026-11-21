"use client";

import { useId, useState } from "react";
import { Pencil, Plus } from "lucide-react";

import { DataList, type Column } from "@/components/data-list";
import { CheckboxField, TextAreaField, TextField } from "@/components/form-fields";
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
import { PartnerLookup } from "@/components/partner-lookup";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { useUrlFilter } from "@/hooks/use-url-filter";
import { TotalFigure } from "@/components/total-figure";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { refusedFields, useAction, useFormValues } from "@/hooks/use-form";
import { destinationPayload, EMPTY_DESTINATION, validateDestination, type DestinationValues } from "@/lib/forms";
import { saveErrorMessage } from "@/lib/messages";
import { canAddDestination, canEditDestination, canView } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { Destination, Page, PartnerRef, User } from "@/lib/types";

const LIST_LIMIT = 50;

const COLUMNS: ReadonlyArray<Column<Destination>> = [
  {
    id: "name",
    header: "Nama tempat",
    primary: true,
    cell: (destination) => (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{destination.name}</span>
        {destination.isActive ? null : <StatusBadge info={{ label: "Nonaktif", tone: "neutral" }} />}
      </span>
    ),
  },
  { id: "customer", header: "Customer", cell: (destination) => destination.partner?.name ?? "-" },
  {
    id: "address",
    header: "Alamat",
    wide: true,
    cellClassName: "max-w-72 whitespace-normal",
    cell: (destination) => destination.address,
  },
  { id: "district", header: "Kecamatan", cell: (destination) => destination.district || "-" },
  { id: "regency", header: "Kabupaten atau kota", cell: (destination) => destination.regency || "-" },
  { id: "province", header: "Provinsi", cell: (destination) => destination.province || "-" },
];

function DestinationFormSheet({
  destination,
  onClose,
  onSaved,
}: {
  /** The destination being edited, or null for a new one. */
  destination: Destination | null;
  onClose: () => void;
  onSaved: (destination: Destination, created: boolean) => void;
}) {
  const form = useFormValues<DestinationValues>(
    destination
      ? {
          partnerId: destination.partner ? String(destination.partner.id) : "",
          name: destination.name,
          address: destination.address,
          district: destination.district ?? "",
          regency: destination.regency ?? "",
          province: destination.province ?? "",
          isActive: destination.isActive,
        }
      : EMPTY_DESTINATION,
  );
  const [customer, setCustomer] = useState<PartnerRef | null>(destination?.partner ?? null);
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();

  async function handleSubmit() {
    const errors = validateDestination(form.values);
    form.setErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    const body = destinationPayload(form.values);
    const outcome = await save.run(() =>
      destination
        ? api.request<{ destination: Destination }>(
            `/api/destinations/${encodeURIComponent(String(destination.id))}`,
            { method: "PATCH", body },
          )
        : api.request<{ destination: Destination }>("/api/destinations", { method: "POST", body }),
    );
    if (outcome.ok) {
      onSaved(outcome.value.destination, destination === null);
    } else {
      form.setErrors(refusedFields<DestinationValues>(outcome.error));
      setFormError(saveErrorMessage(outcome.error, "Tujuan ini sudah terdaftar."));
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={destination ? `Ubah ${destination.name}` : "Tujuan baru"}
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <PartnerLookup
        role="customer"
        label="Customer"
        name="customerLookup"
        placeholder="Cari nama customer"
        optional
        value={customer}
        onChange={(partner) => {
          setCustomer(partner);
          form.set("partnerId", partner ? String(partner.id) : "");
        }}
        error={form.errors.partnerId}
      />
      <TextField
        label="Nama tempat"
        name="name"
        value={form.values.name}
        onChange={(value) => form.set("name", value)}
        error={form.errors.name}
      />
      <TextAreaField
        label="Alamat"
        name="address"
        value={form.values.address}
        onChange={(value) => form.set("address", value)}
        error={form.errors.address}
      />
      <TextField
        label="Kecamatan"
        name="district"
        optional
        value={form.values.district}
        onChange={(value) => form.set("district", value)}
        error={form.errors.district}
      />
      <TextField
        label="Kabupaten atau kota"
        name="regency"
        optional
        value={form.values.regency}
        onChange={(value) => form.set("regency", value)}
        error={form.errors.regency}
      />
      <TextField
        label="Provinsi"
        name="province"
        optional
        value={form.values.province}
        onChange={(value) => form.set("province", value)}
        error={form.errors.province}
      />
      <CheckboxField
        label="Aktif"
        description="Tujuan nonaktif tetap tersimpan."
        name="isActive"
        checked={form.values.isActive}
        onChange={(checked) => form.set("isActive", checked)}
      />
    </FormSheet>
  );
}

function DestinationsPage({ user }: { user: User }) {
  const mayAdd = canAddDestination(user);
  const mayEdit = canEditDestination(user);
  const ids = useId();
  const [searchText, setSearchText] = useUrlFilter("q");
  const [customer, setCustomer] = useState<PartnerRef | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  // undefined: sheet closed, null: new destination, otherwise the one being edited
  const [editing, setEditing] = useState<Destination | null | undefined>(undefined);

  const search = useDebouncedValue(searchText.trim(), 300);
  const partnerId = customer ? String(customer.id) : "";

  const list = useApiQuery(
    `${search}|${partnerId}|${reloadToken}`,
    (signal) =>
      api.request<Page<Destination>>("/api/destinations", {
        query: { partnerId, q: search, limit: LIST_LIMIT },
        signal,
      }),
    { keepPrevious: true },
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Tujuan" figures={list.data ? <TotalFigure value={list.data.total} noun="tujuan" /> : null} description="Alamat tujuan pengiriman untuk tiap customer.">
        {mayAdd ? (
          <Button onClick={() => setEditing(null)}>
            <Plus aria-hidden="true" />
            Tujuan baru
          </Button>
        ) : null}
      </PageHeader>

      <div aria-live="polite" className="empty:hidden">
        {saved ? <Notice tone="success">{saved}</Notice> : null}
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <SearchField
          id={`${ids}-search`}
          label="Cari tujuan"
          placeholder="Nama tempat atau alamat"
          value={searchText}
          onChange={setSearchText}
        />
        <PartnerLookup
          role="customer"
          label="Customer"
          name="customerFilter"
          placeholder="Semua customer"
          value={customer}
          onChange={setCustomer}
          className="w-full sm:max-w-xs"
        />
      </div>

      {list.hasError ? (
        <ListError title="Daftar tujuan belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <ListSkeleton label="Memuat daftar tujuan" />
      ) : list.data.items.length === 0 ? (
        <ListEmpty
          title="Tidak ada tujuan yang cocok"
          hint={
            search || customer
              ? "Periksa lagi kata yang dicari atau customer yang dipilih."
              : "Belum ada tujuan yang terdaftar."
          }
          stale={list.isStale}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ResultCount shown={list.data.items.length} total={list.data.total} noun="tujuan" />
          <DataList
            columns={COLUMNS}
            rows={list.data.items}
            rowKey={(destination) => destination.id}
            stale={list.isStale}
            actions={
              mayEdit
                ? (destination) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-10 md:h-8"
                      onClick={() => setEditing(destination)}
                      aria-label={`Ubah ${destination.name}`}
                    >
                      <Pencil aria-hidden="true" />
                      Ubah
                    </Button>
                  )
                : undefined
            }
          />
        </div>
      )}

      {editing !== undefined ? (
        <DestinationFormSheet
          destination={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(destination, created) => {
            setEditing(undefined);
            setSaved(`Tujuan ${destination.name} ${created ? "ditambahkan" : "diperbarui"}.`);
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}
    </div>
  );
}

export function DestinationsScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canView(state.user, "destinations")) return <AccessDenied module="destinations" />;
  return <DestinationsPage user={state.user} />;
}
