"use client";

import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { CircleAlert, X } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/hooks/use-api-query";
import { isApiError } from "@/lib/api-client";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import {
  exceptionOriginal,
  exceptionStatusLabel,
  exceptionTypeLabel,
  groupShares,
  historyStateInfo,
  legacyFields,
  LOADING_LABELS,
  MATERIAL_LABELS,
  QC_LABELS,
  SEAL_COLUMNS,
  sealFacts,
  tripValue,
  UNLOADING_LABELS,
  type LegacyException,
  type LegacyField,
  type LegacyTripDetail,
  type LegacyTripDetails,
  type ParsedTripField,
} from "@/lib/legacy-history";
import { errorMessage } from "@/lib/messages";
import { api } from "@/lib/session";
import { cn } from "@/lib/utils";

// One truck of the old application in a centred window, opened from a row of "Riwayat lama". Grouped the way an
// operator reads a truck: who and what, the papers, the figures, QC, the unloading or loading sheet, the seals,
// the decisions asked, and the other rows of a multi-contract truck. Nothing here can be changed.

const DIRECTION_WORDS: Record<string, string> = { IN: "Incoming", OUT: "Outgoing", UNKNOWN: "Arah tidak tercatat" };
const kg = (value: number | null) => (value === null ? null : `${formatNumber(value)} kg`);
const yes = (value: boolean | null) => (value === true ? "ya" : value === false ? "tidak" : null);

/** The original text of a value the import could not read, with a quiet mark. */
function Original({ text }: { text: string }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5" data-testid="history-original">
      <span className="font-mono">{text}</span>
      <span className="text-[0.6875rem] text-faint" title="Nilai ini tidak terbaca saat data lama dipindahkan. Yang tampil adalah teks aslinya.">
        teks asli
      </span>
    </span>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0", className)}>
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 wrap-break-word", mono && "font-mono")}>{children}</dd>
    </div>
  );
}

type Fact = readonly [string, ReactNode];

/** The rows that have a value; a section whose rows are all empty is left out. */
function filled(rows: readonly Fact[]): Fact[] {
  return rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
}

function Facts({ rows }: { rows: readonly Fact[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="divide-y">
      {rows.map(([label, value]) => (
        <Field key={label} label={label}>
          {value}
        </Field>
      ))}
    </dl>
  );
}

/** The columns of an old sheet; a column without a label of ours keeps its old name, in a quieter type. */
function OldFields({ fields }: { fields: readonly LegacyField[] }) {
  return (
    <dl className="divide-y">
      {fields.map((field) => (
        <div key={field.key} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 py-1 text-sm">
          <dt className={cn("wrap-break-word text-muted-foreground", !field.known && "font-mono text-xs leading-5")}>{field.label}</dt>
          <dd className="min-w-0 wrap-break-word">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HistoryDialog({ id, onClose, returnFocus }: { id: number | null; onClose: () => void; returnFocus: () => HTMLElement | null }) {
  const query = useApiQuery<LegacyTripDetail>(id === null ? null : `history-trip-${id}`, (signal) =>
    api.request<LegacyTripDetail>(`/api/history/trips/${id}`, { signal }),
  );
  const detail = query.data && query.data.trip.id === id ? query.data : null;
  const notFound = query.hasError && isApiError(query.error) && query.error.status === 404;
  const trip = detail?.trip ?? null;

  return (
    <DialogPrimitive.Root open={id !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-70 bg-[oklch(0.15_0.015_255/0.4)] backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 dark:bg-[oklch(0.05_0.01_255/0.65)]" />
        <DialogPrimitive.Content
          data-testid="history-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus()?.focus({ preventScroll: true });
          }}
          className="fixed top-1/2 left-1/2 z-70 flex max-h-[min(92dvh,60rem)] w-[min(56rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-overlay data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97]"
        >
          <header className="flex items-start justify-between gap-4 border-b px-5 pt-4 pb-4 sm:px-6">
            <div className="min-w-0">
              <DialogPrimitive.Title className="kicker text-muted-foreground">Riwayat lama</DialogPrimitive.Title>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="plate text-2xl sm:text-[1.75rem]" data-testid="history-dialog-plate">
                  {trip ? (trip.plateText ?? "Tanpa plat") : "Memuat"}
                </span>
                {trip ? <StatusBadge info={historyStateInfo(trip.state)} /> : null}
              </div>
              {trip ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {[
                    trip.ticketNo ? `Tiket ${trip.ticketNo}` : `Id lama ${trip.legacyId}`,
                    DIRECTION_WORDS[trip.direction] ?? trip.direction,
                    trip.entryDate ? formatDate(trip.entryDate) : null,
                    trip.site === "UNKNOWN" ? "tanpa cabang" : `cabang ${trip.site}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-faint">Data aplikasi lama, hanya bisa dibaca.</p>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="-mr-2 shrink-0">
                <X aria-hidden="true" />
                <span className="sr-only">Tutup</span>
              </Button>
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
            {notFound ? (
              <p role="alert" className="rounded-xl border bg-surface p-4 text-sm">
                Data ini tidak ditemukan di arsip.
              </p>
            ) : query.hasError && !detail ? (
              <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive-subtle p-4 text-sm text-destructive">
                <p className="flex items-center gap-2">
                  <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                  {errorMessage(query.error)}
                </p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={query.reload}>
                  Coba lagi
                </Button>
              </div>
            ) : !detail ? (
              <div className="grid gap-6 md:grid-cols-2" aria-label="Memuat rincian" data-testid="history-dialog-loading">
                {Array.from({ length: 2 }, (_, column) => (
                  <div key={column} className="space-y-3">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-5 w-full" />
                    <Skeleton className="h-5 w-4/5" />
                    <Skeleton className="h-5 w-3/5" />
                  </div>
                ))}
              </div>
            ) : (
              <HistoryDetail detail={detail} />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function HistoryDetail({ detail }: { detail: LegacyTripDetail }) {
  const { trip, group, exceptions } = detail;
  const details = trip.details ?? {};
  const original = details.original;
  /** A typed value, or its original text when the import could not read it. */
  const shown = (field: ParsedTripField, format: (value: string | number) => string | null): ReactNode => {
    const { value, original: text } = tripValue(trip, field, original);
    if (value !== null) return format(value);
    return text ? <Original text={text} /> : null;
  };
  const time = (value: string | number) => formatDateTime(String(value));
  const weight = (value: string | number) => kg(Number(value));

  const qc = legacyFields(details.qc, QC_LABELS);
  const unloading = legacyFields(details.unloading, UNLOADING_LABELS, SEAL_COLUMNS);
  const loading = legacyFields(details.loading, LOADING_LABELS, SEAL_COLUMNS);
  const seals = sealFacts(details);
  const shares = groupShares(trip, group);
  const ident = (text: string | null) => (text ? <span className="ident">{text}</span> : null);

  const people = filled([
    ["Plat", trip.plateText],
    ["Supir", trip.driverName],
    ["SIM", trip.licenceNo],
    ["Transporter", trip.transporter],
    ["Partner", trip.partnerName],
    ["Asal PKS", trip.mill],
    ["Barang", [...new Set([trip.productName, trip.material ? (MATERIAL_LABELS[trip.material] ?? trip.material) : null].filter(Boolean))].join(", ") || null],
    ["Tanggal entry", shown("entryDate", (value) => formatDate(String(value)))],
    ["Masuk", shown("arrivedAt", time)],
    ["Keluar", shown("leftAt", time)],
    ["Close cargo", yes(trip.closeCargo)],
    ["Flexi bag", yes(trip.flexiBag)],
  ]);
  const papers = filled([
    [trip.direction === "OUT" ? "DO" : "Kontrak", ident(trip.reference)],
    // the old "-" placeholder and a copy of the reference say nothing more
    ["Nomor DO", trip.doNo && trip.doNo !== "-" && trip.doNo !== trip.reference ? ident(trip.doNo) : null],
    ["PO", ident(trip.poNo)],
    ["SPB", ident(trip.spbNo)],
    ["Nomor penyerahan", ident(trip.handoverNo)],
    ["Satuan", trip.uom],
  ]);
  const weighings = filled([
    ["Timbang 1", joinParts(shown("weigh1At", time), trip.weigh1By)],
    ["Timbang 2", joinParts(shown("weigh2At", time), trip.weigh2By)],
  ]);
  const figureRows: [string, ParsedTripField, ParsedTripField][] = [
    ["Bruto", "docGrossKg", "grossKg"],
    ["Tarra", "docTareKg", "tareKg"],
    ["Netto", "docNetKg", "netKg"],
  ];

  return (
    <div className="grid gap-x-8 gap-y-6 md:grid-cols-2" data-testid="history-detail">
      {people.length > 0 ? (
        <Section title="Truk dan orang">
          <Facts rows={people} />
        </Section>
      ) : null}

      <div className="flex min-w-0 flex-col gap-6">
        {papers.length > 0 ? (
          <Section title="Dokumen">
            <Facts rows={papers} />
          </Section>
        ) : null}
        <Section title="Angka surat dan hasil timbang">
          <table className="w-full text-sm" data-testid="history-figures">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pb-1 text-left font-medium" scope="col">
                  <span className="sr-only">Angka</span>
                </th>
                <th className="pb-1 text-right font-medium" scope="col">
                  Surat
                </th>
                <th className="pb-1 text-right font-medium" scope="col">
                  Timbang
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {figureRows.map(([label, letter, weighed]) => (
                <tr key={label}>
                  <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                    {label}
                  </th>
                  <td className="py-1.5 text-right font-mono tabular-nums">{shown(letter, weight) ?? "-"}</td>
                  <td className="py-1.5 text-right font-mono font-semibold tabular-nums">{shown(weighed, weight) ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trip.groupId !== null ? (
            <p className="mt-2 text-xs text-muted-foreground">Bruto dan tarra untuk seluruh truk; netto untuk kontrak di baris ini.</p>
          ) : null}
          {weighings.length > 0 ? (
            <div className="mt-2">
              <Facts rows={weighings} />
            </div>
          ) : null}
        </Section>
      </div>

      {qc.length > 0 ? (
        <Section title="QC">
          <OldFields fields={qc} />
        </Section>
      ) : null}
      {unloading.length > 0 ? (
        <Section title="Bongkar">
          <OldFields fields={unloading} />
        </Section>
      ) : null}
      {loading.length > 0 ? (
        <Section title="Muat">
          <OldFields fields={loading} />
        </Section>
      ) : null}
      {seals.numbers.length > 0 || seals.fields.length > 0 ? (
        <Section title="Segel">
          {seals.numbers.length > 0 ? (
            <ul className="mb-1 flex flex-wrap gap-1.5" aria-label="Nomor segel">
              {seals.numbers.map((seal) => (
                <li key={seal} className="ident rounded-sm border bg-surface px-1.5 py-0.5 text-xs">
                  {seal}
                </li>
              ))}
            </ul>
          ) : null}
          <OldFields fields={seals.fields} />
        </Section>
      ) : null}

      {exceptions.length > 0 ? (
        <Section title="Permintaan keputusan" className="md:col-span-2">
          <ul className="grid gap-3 md:grid-cols-2" data-testid="history-exceptions">
            {exceptions.map((exception) => (
              <ExceptionCard key={exception.id} exception={exception} />
            ))}
          </ul>
        </Section>
      ) : null}

      {shares ? (
        <Section title="Satu truk, beberapa kontrak" className="md:col-span-2">
          <table className="w-full text-sm" data-testid="history-group">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pb-1 text-left font-medium" scope="col">
                  Kontrak atau DO
                </th>
                <th className="pb-1 text-left font-medium" scope="col">
                  Tiket
                </th>
                <th className="pb-1 text-right font-medium" scope="col">
                  Netto
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shares.rows.map(({ trip: member, current }) => (
                <tr key={member.id} className={cn(current && "font-medium")}>
                  <td className="py-1.5 pr-3">
                    <span className="ident break-all">{member.reference ?? "-"}</span>
                    {current ? <span className="ml-2 text-xs font-normal text-muted-foreground">baris ini</span> : null}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{member.ticketNo ?? "-"}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{kg(member.netKg) ?? "-"}</td>
                </tr>
              ))}
              <tr>
                <th scope="row" colSpan={2} className="py-1.5 text-left font-normal text-muted-foreground">
                  Jumlah
                </th>
                <td className="py-1.5 text-right font-mono font-semibold tabular-nums">{kg(shares.totalNetKg)}</td>
              </tr>
            </tbody>
          </table>
        </Section>
      ) : null}

      <OtherColumns details={details} />
    </div>
  );
}

function joinParts(when: ReactNode, who: string | null): ReactNode {
  if (when === null && !who) return null;
  return (
    <span>
      {when ?? "-"}
      {who ? <span className="text-muted-foreground">, {who}</span> : null}
    </span>
  );
}

function ExceptionCard({ exception }: { exception: LegacyException }) {
  const figure = (value: number | null, column: string, unit: "kg" | "%") => {
    if (value !== null) return unit === "kg" ? kg(value) : `${formatNumber(value)}%`;
    const text = exceptionOriginal(exception, column);
    return text ? <Original text={text} /> : null;
  };
  const status = exceptionStatusLabel(exception.status);
  return (
    <li className="rounded-xl border bg-surface px-4 py-3">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{exceptionTypeLabel(exception.type)}</span>
        {status ? <span className="text-muted-foreground">{status}</span> : null}
      </p>
      <Facts
        rows={filled([
          ["Keputusan", exception.decision],
          ["Bruto surat", figure(exception.docGrossKg, "bruto_from", "kg")],
          ["Bruto timbang", figure(exception.weighedGrossKg, "bruto_wb", "kg")],
          ["Tarra timbang", figure(exception.weighedTareKg, "tarra_wb", "kg")],
          ["Netto timbang", figure(exception.weighedNetKg, "netto_wb", "kg")],
          ["Selisih", joinFigures(figure(exception.diffKg, "selisih", "kg"), figure(exception.diffPct, "selisih_persen", "%"))],
          ["Toleransi", figure(exception.tolerancePct, "toleransi_persen", "%")],
          ["Diminta", exception.requestedAt ? formatDateTime(exception.requestedAt) : null],
          ["Dijawab", joinParts(exception.respondedAt ? formatDateTime(exception.respondedAt) : null, exception.respondedBy)],
          ["Nomor BA", exception.reportNo ? <span className="ident">{exception.reportNo}</span> : null],
          ["BA dibuat", joinParts(exception.reportAt ? formatDateTime(exception.reportAt) : null, exception.reportBy)],
        ])}
      />
    </li>
  );
}

function joinFigures(first: ReactNode, second: ReactNode): ReactNode {
  if (first === null) return second;
  if (second === null) return first;
  return (
    <span>
      {first} ({second})
    </span>
  );
}

/** Whatever else the import kept of the old registration and weighing, under the old column names. */
function OtherColumns({ details }: { details: LegacyTripDetails }) {
  const registration = legacyFields(details.registration, {});
  const weighing = legacyFields(details.weighing, {});
  const splits = details.splits ?? [];
  const older = (details.otherWeighings?.length ?? 0) + (details.older?.qc?.length ?? 0) + (details.older?.unloading?.length ?? 0) + (details.older?.loading?.length ?? 0);
  if (registration.length === 0 && weighing.length === 0 && splits.length === 0 && older === 0) return null;
  return (
    <details className="group rounded-xl border bg-surface px-4 py-3 md:col-span-2">
      <summary className="cursor-pointer rounded-sm text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">Kolom lain dari aplikasi lama</summary>
      <div className="mt-3 grid gap-x-8 gap-y-4 md:grid-cols-2">
        {registration.length > 0 ? (
          <Section title="Registrasi">
            <OldFields fields={registration} />
          </Section>
        ) : null}
        {weighing.length > 0 ? (
          <Section title="Timbangan">
            <OldFields fields={weighing} />
          </Section>
        ) : null}
        {splits.length > 0 ? (
          <Section title="Pembagian netto">
            {splits.map((split, index) => (
              <OldFields key={index} fields={legacyFields(split, {})} />
            ))}
          </Section>
        ) : null}
        {older > 0 ? (
          <p className="text-sm text-muted-foreground md:col-span-2">
            Ada {formatNumber(older)} isian lama yang sudah diganti isian lebih baru; yang tampil di atas adalah isian terakhir.
          </p>
        ) : null}
      </div>
    </details>
  );
}
