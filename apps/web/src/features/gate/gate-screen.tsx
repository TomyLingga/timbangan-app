"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CircleCheck, CreditCard, Loader2, OctagonX, ScanLine, TriangleAlert } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { ActionSheet } from "@/components/action-sheet";
import { SelectField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { AccessDenied, Notice, PageHeader } from "@/components/page-parts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-provider";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatDateTime, formatNumber, formatQuantity } from "@/lib/format";
import { cardUidError, normalizeCardUid, normalizeSpjToken, spjTokenError } from "@/lib/gate-input";
import { gateErrorMessage } from "@/lib/messages";
import { MOTION_BASE } from "@/lib/motion";
import { canCreate, canEdit, canView, isStaff } from "@/lib/permissions";
import { api } from "@/lib/session";
import { checkSentence, isBlocking, registryStatusInfo, tripStatusInfo } from "@/lib/status";
import type { GateCheck, GateScan, Page, Trip, User } from "@/lib/types";
import { cn } from "@/lib/utils";

type Phase =
  | { kind: "idle" }
  | { kind: "scanning"; token: string }
  | { kind: "scanned"; token: string; scan: GateScan; cardError: string | null; checkingIn: boolean }
  | { kind: "refused"; message: string; scan: GateScan | null }
  | { kind: "done"; trip: Trip };

const DIRECTION = { IN: "Incoming", OUT: "Outgoing" } as const;

function plantToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function focusSoon(ref: RefObject<HTMLInputElement | null>) {
  requestAnimationFrame(() => ref.current?.focus());
}

/** Big text box for a reader that types like a keyboard and ends with Enter. */
function ReaderInput({
  id,
  label,
  hint,
  inputRef,
  value,
  onChange,
  onEnter,
  onEscape,
  busy,
  name,
  error,
}: {
  id: string;
  label: string;
  hint: string;
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onEscape?: () => void;
  busy: boolean;
  name: string;
  error?: string | null;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
    }
  }
  return (
    <form
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!busy) onEnter();
      }}
      className="flex flex-col gap-2"
    >
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id={id}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="go"
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          aria-invalid={error ? true : undefined}
          className="h-14 font-mono text-lg tracking-wider uppercase md:text-lg"
        />
        <Button type="submit" size="lg" className="h-14 shrink-0" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Enter
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function CheckList({ checks }: { checks: readonly GateCheck[] }) {
  const blocks = checks.filter(isBlocking);
  const warnings = checks.filter((check) => !isBlocking(check));
  if (checks.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <CircleCheck className="size-4" aria-hidden="true" />
        Tidak ada yang perlu dicek.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {blocks.length > 0 ? (
        <div className="rounded-md border-2 border-destructive bg-destructive-subtle p-3" data-testid="gate-blocks">
          <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <OctagonX className="size-5" aria-hidden="true" />
            Tidak boleh check-in
          </p>
          <ul className="mt-2 flex flex-col gap-1 pl-7 text-sm text-destructive">
            {blocks.map((check) => (
              <li key={check.code} className="list-disc">
                {checkSentence(check)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning-subtle p-3" data-testid="gate-warnings">
          <p className="flex items-center gap-2 text-sm font-semibold text-warning">
            <TriangleAlert className="size-4" aria-hidden="true" />
            Perlu dilihat petugas
          </p>
          <ul className="mt-2 flex flex-col gap-1 pl-6 text-sm text-warning">
            {warnings.map((check) => (
              <li key={check.code} className="list-disc">
                {checkSentence(check)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TruckCard({ trip }: { trip: Trip }) {
  return (
    <div className="flex flex-col gap-3" data-testid="gate-truck">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-2xl font-semibold tracking-tight">{trip.vehicle?.plateDisplay ?? "-"}</p>
          <p className="text-sm text-muted-foreground">
            {[trip.spj?.spjNo, trip.direction ? DIRECTION[trip.direction] : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <StatusBadge info={tripStatusInfo(trip.status)} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Supir</dt>
          <dd>
            {trip.driver?.fullName ?? "-"}
            <span className="block text-xs text-muted-foreground">SIM {trip.driver?.licenceNo ?? "-"}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Status VCF</dt>
          <dd>
            <StatusBadge info={registryStatusInfo(trip.driver?.registryStatus)} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Partner</dt>
          <dd className="wrap-break-word">{trip.partner?.name ?? "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Transporter</dt>
          <dd className="wrap-break-word">{trip.transporter?.name ?? "-"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Rencana</dt>
          <dd>{formatQuantity(trip.qtyPlanned ?? null, "kg")}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">SPJ berlaku sampai</dt>
          <dd>{formatDateTime(trip.spj?.validUntil ?? null)}</dd>
        </div>
      </dl>
    </div>
  );
}

function TripRow({
  trip,
  actions,
}: {
  trip: Trip;
  actions?: ReactNode;
}) {
  return (
    <li className="flex items-start justify-between gap-2 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="font-medium">{trip.vehicle?.plateDisplay ?? "-"}</p>
        <p className="text-xs wrap-break-word text-muted-foreground">
          {[trip.tripNo ?? trip.spj?.spjNo, trip.driver?.fullName, trip.partner?.name].filter(Boolean).join(" · ")}
        </p>
        {trip.card ? (
          <p className="text-xs text-muted-foreground">
            Kartu {trip.card.label ?? trip.card.uid} · masuk {formatDateTime(trip.checkedInAt ?? null)}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-1">{actions}</div> : null}
    </li>
  );
}

function ReplaceCardSheet({
  trip,
  onClose,
  onDone,
  returnFocus,
}: {
  trip: Trip;
  onClose: () => void;
  onDone: (trip: Trip) => void;
  returnFocus: () => void;
}) {
  const [uid, setUid] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ uid?: string; reason?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    const cardUid = normalizeCardUid(uid);
    const found = { uid: cardUidError(cardUid) ?? undefined, reason: reason ? undefined : "Pilih alasan." };
    setErrors(found);
    setFailure(null);
    if (found.uid || found.reason) return;
    setPending(true);
    try {
      const { trip: updated } = await api.request<{ trip: Trip }>("/api/gate/replace-card", {
        method: "POST",
        body: { tripId: trip.id, cardUid, reason },
      });
      onDone(updated);
    } catch (error) {
      setFailure(gateErrorMessage(error));
      setUid("");
      setPending(false);
    }
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Ganti kartu ${trip.vehicle?.plateDisplay ?? ""}`}
      description={`Kartu sekarang: ${trip.card?.label ?? trip.card?.uid ?? "-"}. Kartu lama dilepas, kartu baru diikat ke truk ini.`}
      submitLabel="Ganti kartu"
      pending={pending}
      error={failure}
      onSubmit={handleSubmit}
      returnFocus={returnFocus}
    >
      <SelectField
        label="Alasan"
        name="replaceReason"
        value={reason}
        onChange={setReason}
        error={errors.reason}
        emptyLabel="Pilih alasan"
        options={[
          { value: "REPLACED", label: "Kartu rusak" },
          { value: "LOST", label: "Kartu hilang" },
        ]}
      />
      <TextField
        label="Kartu baru"
        name="replaceCardUid"
        value={uid}
        onChange={setUid}
        error={errors.uid}
        hint="Tempelkan kartu baru ke pembaca."
        autoFocus
        autoCapitalize="characters"
        spellCheck={false}
        className="[&_input]:font-mono [&_input]:uppercase"
      />
    </FormSheet>
  );
}

function GatePage({ user }: { user: User }) {
  const mayCheckIn = canCreate(user, "gate");
  const mayChange = canEdit(user, "gate");
  const reduceMotion = useReducedMotion();
  const scanRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLInputElement>(null);
  const [scanText, setScanText] = useState("");
  const [cardText, setCardText] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [reloadToken, setReloadToken] = useState(0);
  const [sheet, setSheet] = useState<{ kind: "replace" | "cancel" | "reissue"; trip: Trip } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const today = plantToday();
  // `date` matches the planned arrival or the day of check-in (apps/api trips/routes.ts); `status` takes several.
  const upcoming = useApiQuery(`upcoming|${today}|${reloadToken}`, (signal) =>
    api.request<Page<Trip>>("/api/trips", { query: { status: "ISSUED,EXPIRED", date: today, limit: 50 }, signal }),
  { keepPrevious: true });
  // Trucks inside the plant, whatever day they came in.
  const inside = useApiQuery(`inside|${reloadToken}`, (signal) =>
    api.request<Page<Trip>>("/api/trips", { query: { status: "CHECKED_IN,IN_PROCESS", limit: 50 }, signal }),
  { keepPrevious: true });

  const awaitingCard = mayCheckIn && phase.kind === "scanned" && !phase.scan.checks.some(isBlocking);

  // The operator works without the mouse: the box that expects the next reading has focus.
  useEffect(() => {
    if (sheet) return;
    if (awaitingCard) cardRef.current?.focus();
    else if (phase.kind !== "scanning") scanRef.current?.focus();
  }, [phase, awaitingCard, sheet]);

  async function scan(raw: string) {
    const token = normalizeSpjToken(raw);
    const problem = spjTokenError(token);
    setNotice(null);
    setCardText("");
    if (problem) {
      setScanError(problem);
      setPhase({ kind: "idle" });
      focusSoon(scanRef);
      return;
    }
    setScanError(null);
    setPhase({ kind: "scanning", token });
    try {
      const result = await api.request<GateScan>(`/api/gate/spj/${encodeURIComponent(token)}`);
      setPhase({ kind: "scanned", token, scan: result, cardError: null, checkingIn: false });
    } catch (error) {
      setPhase({ kind: "refused", message: gateErrorMessage(error), scan: null });
    }
    setScanText("");
  }

  async function checkIn() {
    if (phase.kind !== "scanned" || phase.checkingIn) return;
    const cardUid = normalizeCardUid(cardText);
    const problem = cardUidError(cardUid);
    if (problem) {
      setPhase({ ...phase, cardError: problem });
      return;
    }
    setPhase({ ...phase, cardError: null, checkingIn: true });
    try {
      const { trip } = await api.request<{ trip: Trip }>("/api/gate/check-in", {
        method: "POST",
        body: { token: phase.token, cardUid },
      });
      setPhase({ kind: "done", trip });
      setReloadToken((token) => token + 1);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code.startsWith("CARD_")) {
        // The truck is fine; only the card was refused. Another card can be tapped right away.
        setPhase({ ...phase, cardError: gateErrorMessage(error), checkingIn: false });
        focusSoon(cardRef);
      } else {
        setPhase({ kind: "refused", message: gateErrorMessage(error), scan: phase.scan });
      }
    }
    setCardText("");
  }

  function reset() {
    setPhase({ kind: "idle" });
    setCardText("");
    focusSoon(scanRef);
  }

  const shownTrip =
    phase.kind === "scanned" ? phase.scan.trip : phase.kind === "refused" ? phase.scan?.trip : phase.kind === "done" ? phase.trip : null;
  const motionProps = reduceMotion
    ? {}
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: MOTION_BASE } };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Pos registrasi" description="Scan SPJ, periksa truknya, lalu tempelkan kartu RFID. Pembaca barcode dan pembaca kartu cukup diarahkan ke kotak yang menyala." />

      <div aria-live="polite" className="empty:hidden">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-lg border bg-card p-4 sm:p-5">
            <ReaderInput
              id="gate-scan"
              name="scan"
              label="Scan SPJ"
              hint="Arahkan pembaca barcode ke QR atau barcode SPJ, atau ketik 12 huruf dan angka di bawah barcode lalu tekan Enter."
              inputRef={scanRef}
              value={scanText}
              onChange={(value) => {
                setScanText(value);
                setScanError(null);
              }}
              onEnter={() => void scan(scanText)}
              busy={phase.kind === "scanning"}
              error={scanError}
            />
          </section>

          <div aria-live="assertive" className="flex flex-col gap-4">
            {phase.kind === "scanning" ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Memeriksa SPJ
              </p>
            ) : null}

            {phase.kind === "done" ? (
              <motion.section
                key={`done-${phase.trip.id}`}
                {...motionProps}
                className="rounded-lg border-2 border-success bg-success-subtle p-4 sm:p-5"
                data-testid="gate-success"
              >
                <p className="flex items-center gap-2 text-lg font-semibold text-success">
                  <CircleCheck className="size-6" aria-hidden="true" />
                  Check-in berhasil
                </p>
                <p className="mt-1 text-sm text-success">
                  {phase.trip.vehicle?.plateDisplay ?? "-"} membawa kartu {phase.trip.card?.label ?? phase.trip.card?.uid ?? "-"}.
                  {phase.trip.tripNo ? ` Nomor trip ${phase.trip.tripNo}.` : ""} Scan SPJ berikutnya.
                </p>
              </motion.section>
            ) : null}

            {phase.kind === "refused" ? (
              <motion.section
                key="refused"
                {...motionProps}
                className="rounded-lg border-2 border-destructive bg-destructive-subtle p-4 sm:p-5"
                data-testid="gate-refused"
              >
                <p className="flex items-center gap-2 text-lg font-semibold text-destructive">
                  <OctagonX className="size-6" aria-hidden="true" />
                  Ditolak
                </p>
                <p className="mt-1 text-sm text-destructive">{phase.message}</p>
              </motion.section>
            ) : null}

            {shownTrip && phase.kind !== "done" ? (
              <motion.section
                key={`trip-${shownTrip.id}-${phase.kind}`}
                {...motionProps}
                className="flex flex-col gap-4 rounded-lg border bg-card p-4 sm:p-5"
              >
                <TruckCard trip={shownTrip} />
                {phase.kind === "scanned" ? <CheckList checks={phase.scan.checks} /> : null}
                {phase.kind === "scanned" && !mayCheckIn && !phase.scan.checks.some(isBlocking) ? (
                  <Notice tone="warning">Akun Anda hanya bisa melihat. Check-in butuh hak akses Pos registrasi tingkat buat.</Notice>
                ) : null}
                {shownTrip && mayChange && ["ISSUED", "EXPIRED"].includes(shownTrip.status.toUpperCase()) &&
                phase.kind === "scanned" && phase.scan.checks.some((check) => check.code === "SPJ_EXPIRED") ? (
                  <Button variant="outline" className="self-start" onClick={() => setSheet({ kind: "reissue", trip: shownTrip })}>
                    Terbit ulang SPJ
                  </Button>
                ) : null}
              </motion.section>
            ) : null}

            {phase.kind === "scanned" && !awaitingCard ? (
              <Button variant="outline" className="self-start" onClick={reset}>
                Scan SPJ lain
              </Button>
            ) : null}

            {awaitingCard && phase.kind === "scanned" ? (
              <section className="rounded-lg border-2 border-primary bg-card p-4 sm:p-5">
                <ReaderInput
                  id="gate-card"
                  name="cardUid"
                  label="Tempelkan kartu RFID"
                  hint="Pembaca kartu mengetik UID lalu Enter. Esc untuk batal dan kembali ke scan."
                  inputRef={cardRef}
                  value={cardText}
                  onChange={(value) => {
                    setCardText(value);
                    if (phase.cardError) setPhase({ ...phase, cardError: null });
                  }}
                  onEnter={() => void checkIn()}
                  onEscape={reset}
                  busy={phase.checkingIn}
                  error={phase.cardError}
                />
              </section>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="upcoming-heading">
            <h2 id="upcoming-heading" className="flex items-center gap-2 text-sm font-semibold">
              <ScanLine className="size-4 text-muted-foreground" aria-hidden="true" />
              Akan datang hari ini
              <span className="font-normal text-muted-foreground">{upcoming.data ? formatNumber(upcoming.data.total) : ""}</span>
            </h2>
            {upcoming.hasError ? (
              <p className="mt-2 text-sm text-destructive">{gateErrorMessage(upcoming.error)}</p>
            ) : upcoming.data && upcoming.data.items.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Tidak ada truk yang dijadwalkan datang hari ini.</p>
            ) : (
              <ul className={cn("mt-1 divide-y", upcoming.isStale && "opacity-60")} data-testid="gate-upcoming">
                {(upcoming.data?.items ?? []).map((trip) => (
                  <TripRow
                    key={trip.id}
                    trip={trip}
                    actions={
                      trip.status.toUpperCase() === "EXPIRED" ? (
                        mayChange ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-10 md:h-8"
                            onClick={() => setSheet({ kind: "reissue", trip })}
                            aria-label={`Terbit ulang SPJ ${trip.vehicle?.plateDisplay ?? "truk"}`}
                          >
                            Terbit ulang
                          </Button>
                        ) : (
                          <StatusBadge info={tripStatusInfo(trip.status)} />
                        )
                      ) : trip.spj ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-10 md:h-8"
                          onClick={() => void scan(trip.spj?.barcodeToken ?? "")}
                          aria-label={`Periksa ${trip.vehicle?.plateDisplay ?? "truk"}`}
                        >
                          Periksa
                        </Button>
                      ) : null
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="inside-heading">
            <h2 id="inside-heading" className="flex items-center gap-2 text-sm font-semibold">
              <CreditCard className="size-4 text-muted-foreground" aria-hidden="true" />
              Di dalam pabrik
              <span className="font-normal text-muted-foreground">{inside.data ? formatNumber(inside.data.total) : ""}</span>
            </h2>
            {inside.hasError ? (
              <p className="mt-2 text-sm text-destructive">{gateErrorMessage(inside.error)}</p>
            ) : inside.data && inside.data.items.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Tidak ada truk di dalam pabrik.</p>
            ) : (
              <ul className={cn("mt-1 divide-y", inside.isStale && "opacity-60")} data-testid="gate-inside">
                {(inside.data?.items ?? []).map((trip) => (
                  <TripRow
                    key={trip.id}
                    trip={trip}
                    actions={
                      mayChange ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-10 md:h-8"
                          onClick={() => setSheet({ kind: "replace", trip })}
                          aria-label={`Ganti kartu ${trip.vehicle?.plateDisplay ?? ""}`}
                        >
                          Ganti kartu
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-10 text-destructive md:h-8"
                          onClick={() => setSheet({ kind: "cancel", trip })}
                          aria-label={`Batalkan ${trip.vehicle?.plateDisplay ?? ""}`}
                        >
                          Batal
                        </Button>
                      </>
                      ) : null
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {sheet?.kind === "replace" ? (
        <ReplaceCardSheet
          trip={sheet.trip}
          onClose={() => setSheet(null)}
          returnFocus={() => focusSoon(scanRef)}
          onDone={(trip) => {
            setSheet(null);
            setNotice(`Kartu ${trip.vehicle?.plateDisplay ?? ""} diganti dengan ${trip.card?.label ?? trip.card?.uid ?? "kartu baru"}.`);
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}
      {sheet?.kind === "reissue" ? (
        <ActionSheet
          title={`Terbit ulang SPJ ${sheet.trip.vehicle?.plateDisplay ?? "truk"}`}
          description="SPJ lama dicabut dan tidak bisa dipakai lagi. Cetak SPJ yang baru untuk supir dari halaman registrasinya."
          submitLabel="Terbit ulang SPJ"
          reasonLabel="Alasan"
          reasonRequired="Isi alasan terbit ulang."
          returnFocus={() => focusSoon(scanRef)}
          onClose={() => setSheet(null)}
          onConfirm={async (reason) => {
            try {
              await api.request(`/api/trips/${encodeURIComponent(String(sheet.trip.id))}/spj/reissue`, { method: "POST", body: { reason } });
            } catch (error) {
              return gateErrorMessage(error);
            }
            setNotice(`SPJ ${sheet.trip.vehicle?.plateDisplay ?? "truk"} diterbitkan ulang. Cetak SPJ baru dari halaman registrasinya.`);
            setSheet(null);
            setPhase({ kind: "idle" });
            setReloadToken((token) => token + 1);
            return null;
          }}
        />
      ) : null}
      {sheet?.kind === "cancel" ? (
        <ActionSheet
          title={`Batalkan ${sheet.trip.vehicle?.plateDisplay ?? "truk"}`}
          description="Truk dibatalkan sebelum timbang. SPJ-nya dicabut, kartunya dilepas dan bisa dipakai truk lain."
          submitLabel="Batalkan truk"
          reasonLabel="Alasan"
          reasonRequired="Isi alasan pembatalan."
          returnFocus={() => focusSoon(scanRef)}
          onClose={() => setSheet(null)}
          onConfirm={async (reason) => {
            try {
              await api.request(`/api/trips/${encodeURIComponent(String(sheet.trip.id))}/cancel`, { method: "POST", body: { reason } });
            } catch (error) {
              return gateErrorMessage(error);
            }
            setNotice(`${sheet.trip.vehicle?.plateDisplay ?? "Truk"} dibatalkan. Kartunya kembali tersedia.`);
            setSheet(null);
            setReloadToken((token) => token + 1);
            return null;
          }}
        />
      ) : null}
    </div>
  );
}

export function GateScreen() {
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!isStaff(state.user) || !canView(state.user, "gate")) return <AccessDenied module="gate" />;
  return <GatePage user={state.user} />;
}
