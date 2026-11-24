"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronDown, ChevronUp, CircleCheck, MapPinned, Pencil, Printer, RefreshCw, Send, TriangleAlert, X } from "lucide-react";

import { ActionSheet } from "@/components/action-sheet";
import { AttachmentList } from "@/components/attachments";
import { FindingsList } from "@/components/findings-list";
import { AccessDenied, ListError, ListSkeleton, Notice } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { DIRECTION_LABELS } from "@/features/registrations/registrations-screen";
import { TripWorkPanel } from "@/features/trips/trip-work";
import { useApiQuery } from "@/hooks/use-api-query";
import { canChangeSlips, MAX_TRIP_SLIPS } from "@/lib/attachments";
import { formatDate, formatDateTime, formatNumber, formatQuantity } from "@/lib/format";
import { gateErrorMessage, transitionErrorMessage } from "@/lib/messages";
import { positionLink } from "@/lib/gps";
import { canCancelRegistration, canEditDraft, canReissueSpj, canReviewRegistrations, canTrackVehicles, canView, isStaff } from "@/lib/permissions";
import { api } from "@/lib/session";
import { registrationStatusInfo, registryStatusInfo, tripStatusInfo } from "@/lib/status";
import type { Registration, Trip, User } from "@/lib/types";

const yesNo = (value: boolean | null) => (value === null ? "-" : value ? "Ya" : "Tidak");

const slipPath = (registration: Registration, trip: Trip) =>
  `/api/registrations/${encodeURIComponent(String(registration.id))}/trips/${encodeURIComponent(String(trip.id))}/files`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** POST /api/trips/:id/spj/reissue takes a truck that has not checked in, on an approved registration. */
const mayBeReissued = (trip: Trip, registration: Registration) =>
  registration.status.toUpperCase() === "APPROVED" && ["ISSUED", "EXPIRED"].includes(trip.status.toUpperCase());

/** Trucks that have checked in have steps and weighings to show. */
const hasWork = (trip: Trip) => ["CHECKED_IN", "IN_PROCESS", "COMPLETED", "REJECTED"].includes(trip.status.toUpperCase());

/** The steps and weighings of one truck, opened on request (staff accounts only). */
function TripWorkToggle({ trip, user }: { trip: Trip; user: User }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t pt-3">
      <Button variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen((value) => !value)} aria-label={`Langkah dan timbang truk ${trip.seq}`}>
        {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        Langkah dan timbang
      </Button>
      {open ? (
        <div className="mt-3">
          <TripWorkPanel tripId={trip.id} user={user} />
        </div>
      ) : null}
    </div>
  );
}

function TripCard({
  trip,
  registration,
  user,
  onReissue,
  onSlipsChanged,
}: {
  trip: Trip;
  registration: Registration;
  user: User;
  /** Present when the account may reissue the SPJ of this truck. */
  onReissue?: () => void;
  /** Reloads the registration after a slip was added or removed. */
  onSlipsChanged: () => void;
}) {
  const incoming = registration.direction === "IN";
  const allocationName = (seq: number) => {
    const allocation = registration.allocations.find((item) => item.seq === seq);
    return allocation?.doNo ?? allocation?.contractNo ?? `Alokasi ${seq}`;
  };
  return (
    <li className="rounded-2xl border bg-card p-4 sm:p-5" data-trip-seq={trip.seq}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            Truk {trip.seq} · <span className="whitespace-nowrap">{trip.vehicle?.plateDisplay ?? "-"}</span>
          </h3>
          {trip.tripNo ? <p className="text-xs text-muted-foreground">Nomor trip {trip.tripNo}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {canTrackVehicles(user) && positionLink(trip) ? (
            <Link
              href={positionLink(trip) ?? "/lacak"}
              className="inline-flex min-h-8 items-center gap-1 text-sm text-link underline-offset-4 hover:underline"
              aria-label={`Lihat posisi truk ${trip.seq}`}
            >
              <MapPinned className="size-3.5" aria-hidden="true" />
              Lihat posisi
            </Link>
          ) : null}
          <StatusBadge info={tripStatusInfo(trip.status)} />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label="Supir">
          {trip.driver?.fullName ?? "-"}
          <span className="block text-xs text-muted-foreground">SIM {trip.driver?.licenceNo ?? "-"}</span>
        </Fact>
        <Fact label="Status VCF">
          <StatusBadge info={registryStatusInfo(trip.driver?.registryStatus)} />
        </Fact>
        <Fact label="Rencana quantity">{formatQuantity(trip.qtyPlanned, registration.uom ?? "Kg")}</Fact>
        {trip.containerNo ? <Fact label="Nomor kontainer">{trip.containerNo}</Fact> : null}
        {incoming ? (
          <Fact label="Angka surat (bruto / tarra / netto)">
            <span className="tabular-nums">
              {formatNumber(trip.docGrossKg)} / {formatNumber(trip.docTareKg)} / {formatNumber(trip.docNetKg)} kg
            </span>
          </Fact>
        ) : null}
        {trip.card ? (
          <Fact label="Kartu">
            <span className="font-mono">{trip.card.uid}</span>
            {trip.card.label ? <span className="block text-xs text-muted-foreground">{trip.card.label}</span> : null}
          </Fact>
        ) : null}
        {trip.checkedInAt ? <Fact label="Check-in">{formatDateTime(trip.checkedInAt)}</Fact> : null}
      </dl>

      {trip.allocations.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2 border-t pt-3 text-sm">
          {trip.allocations.map((line) => {
            const quality = Object.entries(line.quality ?? {});
            return (
              <li key={line.seq} className="flex flex-col gap-0.5">
                <span className="font-medium">{allocationName(line.seq)}</span>
                <span className="text-muted-foreground">
                  {incoming
                    ? [
                        line.spbNo ? `SPB ${line.spbNo}${line.spbDate ? ` (${formatDate(line.spbDate)})` : ""}` : null,
                        line.originTicketNo ? `Tiket ${line.originTicketNo}` : null,
                        line.originNetKg !== null ? `Netto asal ${formatQuantity(line.originNetKg, "kg")}` : null,
                        quality.length > 0 ? quality.map(([code, value]) => `${code} ${formatNumber(value)}`).join(", ") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Data surat belum diisi"
                    : `Rencana ${formatQuantity(line.qtyPlanned, "kg")}`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {incoming ? (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <h4 className="text-sm font-medium">Slip timbang</h4>
          <AttachmentList
            title={`Slip timbang truk ${trip.seq}`}
            files={trip.slips ?? []}
            max={MAX_TRIP_SLIPS}
            canChange={canChangeSlips(user, registration)}
            onAdd={async (file) => {
              await api.request(slipPath(registration, trip), { method: "POST", body: { fileId: file.id } });
              onSlipsChanged();
            }}
            onRemove={async (file) => {
              await api.request(`${slipPath(registration, trip)}/${encodeURIComponent(String(file.id))}`, { method: "DELETE" });
              onSlipsChanged();
            }}
            emptyText="Belum ada slip timbang dari PKS."
            hint="Slip timbangan PKS: PDF sampai 10 MB atau foto sampai 5 MB."
            testId={`trip-slips-${trip.seq}`}
          />
        </div>
      ) : null}

      {trip.cancelReason ? (
        <p className="mt-3 border-t pt-3 text-sm">
          <span className="font-medium">Alasan batal: </span>
          {trip.cancelReason}
        </p>
      ) : null}

      {trip.spj ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-sm">
            <span className="font-medium">{trip.spj.spjNo}</span>
            <span className="block text-xs text-muted-foreground">
              Berlaku sampai {formatDateTime(trip.spj.validUntil)}
              {trip.spj.printCount ? ` · dicetak ${formatNumber(trip.spj.printCount)} kali` : ""}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {onReissue ? (
              <Button variant="outline" onClick={onReissue} aria-label={`Terbit ulang SPJ truk ${trip.seq}`}>
                <RefreshCw aria-hidden="true" />
                Terbit ulang SPJ
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <Link href={`/spj/${encodeURIComponent(String(trip.id))}/cetak`} target="_blank" rel="noopener" aria-label={`Cetak SPJ truk ${trip.seq}`}>
                <Printer aria-hidden="true" />
                Cetak SPJ
              </Link>
            </Button>
          </div>
        </div>
      ) : null}

      {isStaff(user) && hasWork(trip) ? <TripWorkToggle trip={trip} user={user} /> : null}
    </li>
  );
}

type PendingAction = "approve" | "reject" | "cancel" | "submit" | null;

const CREATED_NOTICES: Record<string, string> = {
  draf: "Registrasi disimpan sebagai draf. Kirim registrasi ini bila datanya sudah lengkap.",
  kirim: "Registrasi dikirim.",
  slip: "Registrasi disimpan sebagai draf, tetapi slip timbang belum terlampir. Tambahkan slip di truknya, lalu kirim registrasi.",
};

function RegistrationView({ user, id }: { user: User; id: string }) {
  const searchParams = useSearchParams();
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState<PendingAction>(null);
  const [reissuing, setReissuing] = useState<Trip | null>(null);
  const [notice, setNotice] = useState<string | null>(CREATED_NOTICES[searchParams.get("baru") ?? ""] ?? null);

  const query = useApiQuery(`${id}|${reloadToken}`, (signal) =>
    api.request<{ registration: Registration }>(`/api/registrations/${encodeURIComponent(id)}`, { signal }),
  { keepPrevious: true });

  if (query.hasError) return <ListError title="Registrasi belum bisa dimuat" error={query.error} onRetry={query.reload} />;
  if (!query.data) return <ListSkeleton label="Memuat registrasi" />;
  const registration = query.data.registration;
  const status = registration.status.toUpperCase();
  const reviewer = canReviewRegistrations(user);
  const anyCheckedIn = registration.trips.some((trip) => trip.checkedInAt || trip.status.toUpperCase() === "CHECKED_IN");
  const mayChangeDraft = canEditDraft(user, registration);
  const mayCancel = canCancelRegistration(user, registration) && ["DRAFT", "SUBMITTED", "APPROVED"].includes(status) && !anyCheckedIn;

  async function act(action: string, body: unknown, message: string): Promise<string | null> {
    try {
      await api.request(`/api/registrations/${encodeURIComponent(id)}/${action}`, { method: "POST", body });
    } catch (error) {
      return transitionErrorMessage(error);
    }
    setPending(null);
    setNotice(message);
    setReloadToken((token) => token + 1);
    return null;
  }

  const findingsIntro =
    registration.findings.length === 0
      ? null
      : status === "SUBMITTED"
        ? "Registrasi ini menunggu tinjauan admin logistik karena:"
        : "Temuan saat registrasi dikirim:";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/registrasi" className="inline-flex min-h-10 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Daftar registrasi
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{registration.regNo}</h1>
          <StatusBadge info={registrationStatusInfo(registration.status)} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {DIRECTION_LABELS[registration.direction] ?? registration.direction} · {registration.partner?.name ?? "-"}
        </p>
      </div>

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      {status === "SUBMITTED" && reviewer ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPending("approve")}>
            <CircleCheck aria-hidden="true" />
            Setujui
          </Button>
          <Button variant="destructive" onClick={() => setPending("reject")}>
            <X aria-hidden="true" />
            Tolak
          </Button>
        </div>
      ) : null}

      {findingsIntro ? (
        <section
          className={
            status === "SUBMITTED"
              ? "rounded-lg border border-warning/40 bg-warning-subtle p-4 sm:p-5"
              : "rounded-2xl border bg-card p-4 sm:p-5"
          }
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
            {findingsIntro}
          </h2>
          <div className="mt-3">
            <FindingsList findings={registration.findings} />
          </div>
        </section>
      ) : null}

      {registration.reviewNote ? (
        <p className="rounded-md border bg-card px-3 py-2.5 text-sm">
          <span className="font-medium">Catatan peninjau: </span>
          {registration.reviewNote}
        </p>
      ) : null}

      <Panel title="Data registrasi">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Arah">{DIRECTION_LABELS[registration.direction] ?? registration.direction}</Fact>
          <Fact label="Partner">{registration.partner?.name ?? "-"}</Fact>
          <Fact label="Transporter">{registration.transporter?.name ?? "-"}</Fact>
          <Fact label="Tanggal datang">{formatDate(registration.plannedDate)}</Fact>
          <Fact label="Jumlah truk">{formatNumber(registration.truckCount ?? registration.trips.length)}</Fact>
          <Fact label="Quantity">{formatQuantity(registration.qtyTotal, registration.uom ?? "Kg")}</Fact>
          {registration.direction === "OUT" ? (
            <>
              <Fact label="Close cargo">{yesNo(registration.closeCargo)}</Fact>
              <Fact label="Flexi bag">{yesNo(registration.flexiBag)}</Fact>
            </>
          ) : null}
          <Fact label="Dibuat oleh">
            {registration.createdBy?.fullName ?? "-"}
            {registration.createdVia === "OPERATOR" ? <span className="block text-xs text-muted-foreground">lewat petugas</span> : null}
          </Fact>
          <Fact label="Dikirim">{formatDateTime(registration.submittedAt)}</Fact>
          {registration.reviewedAt ? <Fact label="Ditinjau">{formatDateTime(registration.reviewedAt)}</Fact> : null}
          {registration.remark ? <Fact label="Catatan">{registration.remark}</Fact> : null}
        </dl>
      </Panel>

      <Panel title={registration.direction === "IN" ? "Kontrak" : "Delivery order"}>
        <ul className="flex flex-col gap-2 text-sm">
          {registration.allocations.map((allocation) => (
            <li key={allocation.seq} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
              <span>
                <span className="font-medium">{allocation.doNo ?? allocation.contractNo ?? "-"}</span>
                <span className="block text-xs text-muted-foreground">
                  {[allocation.doNo ? allocation.contractNo : null, allocation.product?.name, allocation.partner?.name].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="tabular-nums">{formatQuantity(allocation.qtyPlanned, registration.uom ?? "Kg")}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <section aria-labelledby="trucks-heading" className="flex flex-col gap-3">
        <h2 id="trucks-heading" className="text-sm font-semibold">
          Truk
        </h2>
        <ul className="flex flex-col gap-3">
          {registration.trips.map((trip) => (
            <TripCard
              key={trip.id}
              trip={trip}
              registration={registration}
              user={user}
              onReissue={canReissueSpj(user) && mayBeReissued(trip, registration) ? () => setReissuing(trip) : undefined}
              onSlipsChanged={() => setReloadToken((token) => token + 1)}
            />
          ))}
        </ul>
      </section>

      {status === "DRAFT" || mayCancel ? (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {mayChangeDraft ? (
            <>
              <Button onClick={() => setPending("submit")}>
                <Send aria-hidden="true" />
                Kirim registrasi
              </Button>
              <Button asChild variant="outline">
                <Link href={`/registrasi/${encodeURIComponent(id)}/ubah`}>
                  <Pencil aria-hidden="true" />
                  Ubah draf
                </Link>
              </Button>
            </>
          ) : null}
          {mayCancel ? (
            <Button variant="outline" onClick={() => setPending("cancel")}>
              Batalkan registrasi
            </Button>
          ) : null}
        </div>
      ) : null}

      {pending === "approve" ? (
        <ActionSheet
          title={`Setujui ${registration.regNo}`}
          description="SPJ terbit untuk setiap truk setelah disetujui."
          submitLabel="Setujui"
          onClose={() => setPending(null)}
          onConfirm={() => act("approve", {}, "Registrasi disetujui. SPJ sudah terbit.")}
        >
          <FindingsList findings={registration.findings} />
        </ActionSheet>
      ) : null}
      {pending === "reject" ? (
        <ActionSheet
          title={`Tolak ${registration.regNo}`}
          description="Pembuat registrasi melihat catatan ini."
          submitLabel="Tolak registrasi"
          reasonLabel="Catatan untuk pembuat"
          reasonRequired="Isi alasan penolakan."
          onClose={() => setPending(null)}
          onConfirm={(note) => act("reject", { note }, "Registrasi ditolak.")}
        />
      ) : null}
      {pending === "cancel" ? (
        <ActionSheet
          title={`Batalkan ${registration.regNo}`}
          description="Semua truk di registrasi ini ikut batal, dan SPJ-nya tidak bisa dipakai lagi."
          submitLabel="Batalkan registrasi"
          reasonLabel="Alasan"
          reasonRequired="Isi alasan pembatalan."
          onClose={() => setPending(null)}
          onConfirm={(reason) => act("cancel", { reason }, "Registrasi dibatalkan.")}
        />
      ) : null}
      {reissuing ? (
        <ActionSheet
          title={`Terbit ulang SPJ truk ${reissuing.seq}`}
          description="SPJ lama dicabut dan tidak bisa dipakai lagi. SPJ baru berlaku penuh sejak sekarang; cetak lagi untuk supir."
          submitLabel="Terbit ulang SPJ"
          reasonLabel="Alasan"
          reasonRequired="Isi alasan terbit ulang."
          onClose={() => setReissuing(null)}
          onConfirm={async (reason) => {
            try {
              await api.request(`/api/trips/${encodeURIComponent(String(reissuing.id))}/spj/reissue`, { method: "POST", body: { reason } });
            } catch (error) {
              return gateErrorMessage(error);
            }
            setReissuing(null);
            setNotice(`SPJ truk ${reissuing.seq} diterbitkan ulang. Cetak SPJ yang baru untuk supir.`);
            setReloadToken((token) => token + 1);
            return null;
          }}
        />
      ) : null}
      {pending === "submit" ? (
        <ActionSheet
          title={`Kirim ${registration.regNo}`}
          description="Registrasi tanpa temuan langsung mendapat SPJ. Yang punya temuan menunggu tinjauan admin logistik."
          submitLabel="Kirim registrasi"
          onClose={() => setPending(null)}
          onConfirm={() => act("submit", {}, "Registrasi dikirim.")}
        />
      ) : null}
    </div>
  );
}

export function RegistrationDetailScreen() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canView(state.user, "registrations")) return <AccessDenied module="registrations" />;
  // A new notice (?baru=) on the same registration, after a draft was changed, starts the view afresh.
  return <RegistrationView key={`${params.id}|${searchParams.get("baru") ?? ""}`} user={state.user} id={params.id} />;
}
