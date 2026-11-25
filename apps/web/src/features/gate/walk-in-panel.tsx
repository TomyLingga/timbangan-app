"use client";

// The registration post for a truck that came without an SPJ barcode: the operator scans its paper (the letter of
// the mill, or the delivery order), checks what the reading service read against the master data, completes what
// is open, and taps the card. Only an account with emergency access may go on when the paper was not read.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { CircleCheck, Clock, CreditCard, FileUp, Loader2, OctagonX, Printer, RefreshCw, ScanLine, Siren, X } from "lucide-react";

import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/form-fields";
import { ContractLookup } from "@/components/contract-lookup";
import { ListError, ListSkeleton, Notice } from "@/components/page-parts";
import { TransporterLookup } from "@/components/partner-lookup";
import { Segmented } from "@/components/segmented";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { YesNoField } from "@/components/yes-no-field";
import { ReaderInput } from "@/features/gate/reader-input";
import { dropErrors, FormSection, focusFirstInvalid } from "@/features/registrations/form-parts";
import { LetterFields } from "@/features/registrations/incoming-form";
import { lookUpDriver, lookUpVehicle, TruckFields } from "@/features/registrations/truck-fields";
import { useApiQuery } from "@/hooks/use-api-query";
import { isApiError } from "@/lib/api-client";
import { cargoMarkText } from "@/lib/cargo-marks";
import { formatQuantity } from "@/lib/format";
import { cardUidError, normalizeCardUid } from "@/lib/gate-input";
import { gateErrorMessage } from "@/lib/messages";
import { canWalkInEmergency } from "@/lib/permissions";
import { rememberedDevice, scannerMessage, ScannerError, scannerStatus, scanPage, type ScannerStatus } from "@/lib/scanner";
import { api } from "@/lib/session";
import type { DeliveryOrder, Direction, Page, PartnerRef, QualityParameter, User, VehicleType } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  basisAfterFailure,
  basisOf,
  contractOf,
  emergencyText,
  foundText,
  incomingStart,
  isEmergency,
  isEmergencyRefusal,
  matchStatusInfo,
  outgoingStart,
  plateIsRead,
  readValueText,
  reasonError,
  scanFailureOf,
  scanFileError,
  todoList,
  validateWalkIn,
  walkInErrorMessage,
  walkInFieldErrors,
  walkInRequest,
  type IncomingProposal,
  type IncomingWalkIn,
  type Match,
  type OutgoingProposal,
  type OutgoingWalkIn,
  type ScanFailure,
  type ScanProposal,
  type WalkInBasis,
  type WalkInForm,
  type WalkInResult,
} from "@/lib/walk-in";
import { emptyLetter, type FormErrors, type TruckValues } from "@/lib/workflow-forms";

const DIRECTION_LABEL: Record<Direction, string> = { IN: "Masuk (surat pengantar PKS)", OUT: "Keluar (delivery order)" };
const SCANNER_KEY = "pos.scanner";

function readRemembered(): string | null {
  try {
    return window.localStorage.getItem(SCANNER_KEY);
  } catch {
    return null;
  }
}

function remember(device: string) {
  try {
    window.localStorage.setItem(SCANNER_KEY, device);
  } catch {
    // a browser without storage asks again next time
  }
}

type Stage =
  | { kind: "start"; error: string | null }
  | { kind: "reading"; what: "scanner" | "service" }
  | { kind: "failed"; failure: ScanFailure; file: File | null }
  | { kind: "form"; basis: WalkInBasis; proposal: ScanProposal | null; file: File | null }
  | { kind: "done"; result: WalkInResult };

export function WalkInPanel({ user, onChanged }: { user: User; onChanged: () => void }) {
  const mayEmergency = canWalkInEmergency(user);
  const [direction, setDirection] = useState<Direction>("IN");
  const [stage, setStage] = useState<Stage>({ kind: "start", error: null });

  async function read(file: File) {
    const problem = scanFileError(file);
    if (problem) {
      setStage({ kind: "start", error: problem });
      return;
    }
    setStage({ kind: "reading", what: "service" });
    try {
      const proposal = await api.upload<ScanProposal>("/api/gate/scan-document", file, file.name, { fields: { direction } });
      setStage({ kind: "form", basis: basisOf(proposal), proposal, file });
    } catch (error) {
      setStage({ kind: "failed", failure: scanFailureOf(error), file });
    }
  }

  const restart = () => setStage({ kind: "start", error: null });

  return (
    <section className="flex flex-col gap-4" aria-label="Registrasi truk tanpa barcode" data-testid="walk-in">
      {stage.kind === "start" || stage.kind === "reading" ? (
        <div className="site-grid flex flex-col gap-5 rounded-2xl border bg-card p-4 shadow-panel sm:p-6">
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">Arah truk</h2>
            <Segmented<Direction>
              label="Arah truk"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "IN", label: "Masuk" },
                { value: "OUT", label: "Keluar" },
              ]}
            />
            <p className="text-sm text-muted-foreground">
              {direction === "IN" ? "Pindai surat pengantar dari PKS." : "Pindai delivery order yang dibawa supir."}
            </p>
          </div>
          <ScanSource busy={stage.kind === "reading"} onFile={(file) => void read(file)} onBusy={() => setStage({ kind: "reading", what: "scanner" })} onFailed={(message) => setStage({ kind: "start", error: message })} />
          {stage.kind === "reading" ? (
            <p role="status" className="flex items-center gap-2.5 rounded-xl border border-dashed px-4 py-3 text-base text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              {stage.what === "scanner" ? "Memindai dokumen. Tunggu sampai kertas keluar dari scanner." : "Dokumen sedang dibaca."}
            </p>
          ) : null}
          {stage.kind === "start" && stage.error ? <Notice tone="error">{stage.error}</Notice> : null}
          <EmergencyStart mayEmergency={mayEmergency} onStart={() => setStage({ kind: "form", basis: { kind: "NO_SCAN" }, proposal: null, file: null })} />
        </div>
      ) : null}

      {stage.kind === "failed" ? (
        <ReadFailure
          failure={stage.failure}
          mayEmergency={mayEmergency}
          onRestart={restart}
          onEmergency={() => setStage({ kind: "form", basis: basisAfterFailure(stage.failure), proposal: null, file: stage.file })}
        />
      ) : null}

      {stage.kind === "form" ? (
        <WalkInFormLoader
          key={`${direction}-${stage.basis.kind}-${"scanFileId" in stage.basis ? stage.basis.scanFileId : "none"}`}
          direction={direction}
          basis={stage.basis}
          proposal={stage.proposal}
          file={stage.file}
          mayEmergency={mayEmergency}
          onRestart={restart}
          onDone={(result) => {
            setStage({ kind: "done", result });
            onChanged();
          }}
        />
      ) : null}

      {stage.kind === "done" ? <WalkInOutcome result={stage.result} onNext={restart} /> : null}
    </section>
  );
}

// --- where the image comes from: the scanner helper of this PC, or a file ---------------------------------------

function ScanSource({ busy, onFile, onBusy, onFailed }: { busy: boolean; onFile: (file: File) => void; onBusy: () => void; onFailed: (message: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    const found = await scannerStatus(readRemembered());
    setStatus(found);
    if (found.state === "ready") setDevice(rememberedDevice(found.devices, readRemembered()) ?? found.device.id);
    setChecking(false);
  }

  useEffect(() => {
    // the helper on this PC is asked once when the panel opens; "Periksa scanner" asks again
    let live = true;
    void scannerStatus(readRemembered()).then((found) => {
      if (!live) return;
      setStatus(found);
      if (found.state === "ready") setDevice(rememberedDevice(found.devices, readRemembered()) ?? found.device.id);
    });
    return () => {
      live = false;
    };
  }, []);

  async function scan() {
    onBusy();
    try {
      onFile(await scanPage(device));
    } catch (error) {
      onFailed(error instanceof ScannerError ? scannerMessage(error.kind) : scannerMessage("FAILED"));
    }
  }

  const ready = status?.state === "ready";
  return (
    <div className="flex flex-col gap-3" data-testid="scan-source">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="lg" className="h-14 rounded-xl px-6 text-base" disabled={!ready || busy} onClick={() => void scan()}>
          <Printer aria-hidden="true" />
          Pindai dengan scanner
        </Button>
        <Button type="button" size="lg" variant="outline" className="h-14 rounded-xl px-6 text-base" disabled={busy} onClick={() => fileRef.current?.click()}>
          <FileUp aria-hidden="true" />
          Pilih berkas scan
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png"
          className="sr-only"
          tabIndex={-1}
          aria-label="Berkas scan"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onFile(file);
          }}
        />
      </div>
      <div aria-live="polite" className="text-sm" data-testid="scanner-status">
        {status === null ? (
          <p className="text-muted-foreground">Mencari scanner di PC ini.</p>
        ) : status.state === "ready" ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground">
              Scanner siap: <span className="font-medium text-foreground">{status.devices.find((item) => item.id === device)?.name ?? status.device.name}</span>.
              {status.feederReady === false ? " Kertas belum ada di scanner." : ""}
            </p>
            {status.devices.length > 1 ? (
              <SelectField
                label="Scanner"
                name="scannerDevice"
                value={device ?? ""}
                onChange={(value) => {
                  setDevice(value);
                  remember(value);
                }}
                emptyLabel="Pilih scanner"
                options={status.devices.map((item) => ({ value: item.id, label: item.name }))}
                className="max-w-sm"
              />
            ) : null}
          </div>
        ) : (
          <p className="text-warning">{scannerMessage(status.state === "offline" ? "OFFLINE" : "NO_SCANNER")}</p>
        )}
        {status !== null && !ready ? (
          <Button type="button" variant="ghost" size="sm" className="mt-1 h-10 md:h-8" disabled={checking} onClick={() => void check()}>
            <RefreshCw className={cn(checking && "animate-spin")} aria-hidden="true" />
            Periksa scanner
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function EmergencyStart({ mayEmergency, onStart }: { mayEmergency: boolean; onStart: () => void }) {
  if (!mayEmergency) {
    return <p className="text-sm text-muted-foreground">Scanner rusak? {emergencyText({ kind: "NO_SCAN" }, false)}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4 text-sm">
      <span className="text-muted-foreground">Scanner rusak dan dokumen tidak bisa dipindai?</span>
      <Button type="button" variant="outline" onClick={onStart}>
        <Siren aria-hidden="true" />
        Registrasi darurat tanpa scan
      </Button>
    </div>
  );
}

function ReadFailure({ failure, mayEmergency, onRestart, onEmergency }: { failure: ScanFailure; mayEmergency: boolean; onRestart: () => void; onEmergency: () => void }) {
  // a scan the service did not read, or a server without the service: the emergency path; a refused file: pick another
  const emergencyCase = failure.kind === "NOT_READ" || failure.kind === "NOT_CONFIGURED";
  const basis = basisAfterFailure(failure);
  return (
    <div className="rounded-2xl border-2 border-destructive bg-destructive-subtle p-5 sm:p-6" data-testid="walk-in-failed">
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-destructive text-background">
          <OctagonX className="size-7" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xl font-semibold text-destructive">Dokumen belum terbaca</p>
          <p className="text-base text-destructive">{failure.message}</p>
          {emergencyCase ? <p className="text-base text-foreground">{emergencyText(basis, mayEmergency)}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="lg" variant={emergencyCase && mayEmergency ? "outline" : "default"} onClick={onRestart}>
              <ScanLine aria-hidden="true" />
              Pindai lagi
            </Button>
            {emergencyCase && mayEmergency ? (
              <Button type="button" size="lg" onClick={onEmergency}>
                <Siren aria-hidden="true" />
                Registrasi darurat
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- the form: what was read, the matches, what is still open ----------------------------------------------------

function WalkInFormLoader(props: {
  direction: Direction;
  basis: WalkInBasis;
  proposal: ScanProposal | null;
  file: File | null;
  mayEmergency: boolean;
  onRestart: () => void;
  onDone: (result: WalkInResult) => void;
}) {
  const types = useApiQuery("vehicle-types", (signal) => api.request<{ items: VehicleType[] }>("/api/vehicle-types", { signal }));
  const parameters = useApiQuery("quality-parameters", (signal) => api.request<{ items: QualityParameter[] }>("/api/quality-parameters", { signal }));
  if (isEmergency(props.basis) && !props.mayEmergency) {
    // an unreadable scan: the post may not type it; the reading is still worth a look before scanning again
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="error">{emergencyText(props.basis, false)}</Notice>
        <div>
          <Button type="button" size="lg" onClick={props.onRestart}>
            <ScanLine aria-hidden="true" />
            Pindai lagi
          </Button>
        </div>
        {props.proposal ? <ReadSummary proposal={props.proposal} file={props.file} /> : null}
      </div>
    );
  }
  if (types.hasError || parameters.hasError) {
    return (
      <ListError
        title="Form registrasi belum bisa dibuka"
        error={types.error ?? parameters.error}
        onRetry={() => {
          types.reload();
          parameters.reload();
        }}
      />
    );
  }
  if (!types.data || !parameters.data) return <ListSkeleton label="Menyiapkan form registrasi" />;
  return <WalkInFormBody {...props} types={types.data.items} parameters={parameters.data.items} />;
}

function WalkInFormBody({
  direction,
  basis,
  proposal,
  file,
  onRestart,
  onDone,
  types,
  parameters,
}: {
  direction: Direction;
  basis: WalkInBasis;
  proposal: ScanProposal | null;
  file: File | null;
  onRestart: () => void;
  onDone: (result: WalkInResult) => void;
  types: VehicleType[];
  parameters: QualityParameter[];
}) {
  const emergency = isEmergency(basis);
  const [form, setForm] = useState<WalkInForm>(() =>
    direction === "IN" ? incomingStart(proposal?.direction === "IN" ? proposal : null, parameters) : outgoingStart(proposal?.direction === "OUT" ? proposal : null),
  );
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<"edit" | "card">("edit");
  const [cardText, setCardText] = useState("");
  const [cardError, setCardError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const cardRef = useRef<HTMLInputElement>(null);

  const updateTruck = (change: (truck: TruckValues) => TruckValues) => {
    setForm((current) => ({ ...current, truck: change(current.truck) }));
    setErrors((current) => dropErrors(current, "truck."));
  };

  // The plate and the licence number the letter gave are looked up once, as a typed plate is.
  const lookedUp = useRef(false);
  useEffect(() => {
    if (lookedUp.current) return;
    lookedUp.current = true;
    if (form.truck.plate) void lookUpVehicle(form.truck, updateTruck);
    if (form.truck.licenceNo) void lookUpDriver(form.truck, updateTruck);
    // runs once with the form the proposal filled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step === "card") requestAnimationFrame(() => cardRef.current?.focus());
  }, [step]);

  function check(): boolean {
    const found = validateWalkIn(form, { types, parameters, currentYear: new Date().getFullYear() });
    const reasonProblem = emergency ? reasonError(reason) : null;
    if (reasonProblem) found.reason = reasonProblem;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError("Periksa kolom yang ditandai.");
      setStep("edit");
      focusFirstInvalid();
      return false;
    }
    setFormError(null);
    return true;
  }

  async function send() {
    if (sending) return;
    const cardUid = normalizeCardUid(cardText);
    const problem = cardUidError(cardUid);
    if (problem) {
      setCardError(problem);
      return;
    }
    if (!check()) return;
    setSending(true);
    setCardError(null);
    try {
      const result = await api.request<WalkInResult>("/api/gate/walk-in", { method: "POST", body: walkInRequest(basis, form, cardUid, reason) });
      onDone(result);
      return;
    } catch (error) {
      const code = isApiError(error) ? error.code : "";
      if (code.startsWith("CARD_")) {
        // the truck is fine; only the card was refused: another card can be tapped right away
        setCardError(gateErrorMessage(error));
      } else if (isApiError(error) && error.code === "VALIDATION") {
        const placed = walkInFieldErrors(direction, error.fieldMessages);
        setErrors(placed.errors);
        if (placed.card) setCardError(placed.card);
        setFormError(walkInErrorMessage(error, placed.unplaced));
        if (Object.keys(placed.errors).length > 0) {
          setStep("edit");
          focusFirstInvalid();
        }
      } else {
        setFormError(walkInErrorMessage(error));
        if (isEmergencyRefusal(error)) setStep("edit");
      }
    }
    setCardText("");
    setSending(false);
  }

  const todo = proposal ? todoList(proposal.missing, form) : [];
  const unreadable = proposal?.missing.some((item) => item.field === "document") ?? false;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex flex-col gap-4 lg:sticky lg:top-4">
        {proposal ? (
          <ReadSummary proposal={proposal} file={file} />
        ) : file ? (
          <ScanImage file={file} />
        ) : (
          <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Tanpa scan dokumen. Isi semua data dari dokumen yang dibawa supir.</p>
        )}
      </div>

      {/* not a <form>: the card box below is one, and a form inside a form submits as a page load */}
      <div className="flex flex-col gap-4" data-testid="walk-in-form">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Arah: <span className="font-medium text-foreground">{DIRECTION_LABEL[direction]}</span>
          </p>
          <Button type="button" variant="ghost" onClick={onRestart}>
            <ScanLine aria-hidden="true" />
            Pindai ulang
          </Button>
        </div>

        {emergency ? (
          <section className="flex flex-col gap-3 rounded-2xl border-2 border-warning bg-warning-subtle p-4 sm:p-5" data-testid="walk-in-emergency">
            <h2 className="flex items-center gap-2 text-base font-semibold text-warning">
              <Siren className="size-5" aria-hidden="true" />
              Registrasi darurat
            </h2>
            <p className="text-sm text-foreground">{emergencyText(basis, true)}</p>
            <TextAreaField
              label="Alasan registrasi darurat"
              name="reason"
              rows={2}
              value={reason}
              onChange={(value) => {
                setReason(value);
                setErrors((current) => dropErrors(current, "reason"));
              }}
              error={errors.reason}
              hint="Contoh: layanan baca dokumen mati, scanner rusak. Alasan ini dicatat."
            />
          </section>
        ) : null}

        {todo.length > 0 || unreadable ? (
          <section className="rounded-2xl border bg-card p-4 sm:p-5" data-testid="walk-in-todo">
            <h2 className="text-base font-semibold">Yang masih harus dilengkapi</h2>
            {unreadable ? <p className="mt-1 text-sm text-warning">Dokumen tidak terbaca dengan baik. Periksa semua isian.</p> : null}
            <ul className="mt-3 flex flex-col gap-1.5 text-sm">
              {todo.map((item) => (
                <li key={item.field} data-done={item.done ? "1" : "0"} className={cn("flex items-start gap-2", item.done && "text-muted-foreground line-through")}>
                  {item.done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> : <Clock className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />}
                  <span>
                    {item.message}
                    <span className="sr-only">{item.done ? " Sudah." : " Belum."}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {form.direction === "IN" ? (
          <IncomingFields
            form={form}
            proposal={proposal?.direction === "IN" ? proposal : null}
            parameters={parameters}
            errors={errors}
            setErrors={setErrors}
            change={(update) => setForm((current) => (current.direction === "IN" ? update(current) : current))}
          />
        ) : (
          <OutgoingFields
            form={form}
            proposal={proposal?.direction === "OUT" ? proposal : null}
            errors={errors}
            setErrors={setErrors}
            change={(update) => setForm((current) => (current.direction === "OUT" ? update(current) : current))}
          />
        )}

        <FormSection title={form.direction === "IN" ? "Truk dan supir" : "Truk dan supir yang memuat"}>
          <TruckMatches form={form} proposal={proposal} updateTruck={updateTruck} />
          <TruckFields truck={form.truck} update={updateTruck} errors={errors} prefix="truck" types={types} />
        </FormSection>

        {form.direction === "OUT" ? (
          <FormSection title="Tandai muatan" description="Petugas pos yang menjawab. Jawaban ini menentukan cek netto di timbang 2.">
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["closeCargo", "Close cargo"],
                  ["flexiBag", "Flexi bag"],
                ] as const
              ).map(([name, legend]) => (
                <YesNoField
                  key={name}
                  legend={legend}
                  name={`walkIn.${name}`}
                  size="lg"
                  value={form.marks[name]}
                  onChange={(value) => {
                    setForm((current) => (current.direction === "OUT" ? { ...current, marks: { ...current.marks, [name]: value } } : current));
                    setErrors((current) => dropErrors(current, name));
                  }}
                  error={errors[name]}
                />
              ))}
            </div>
          </FormSection>
        ) : null}

        <FormSection title="Catatan">
          <TextAreaField
            label="Catatan"
            name="remark"
            optional
            rows={2}
            value={form.remark}
            onChange={(value) => setForm((current) => ({ ...current, remark: value }))}
          />
        </FormSection>

        <div aria-live="polite" className="empty:hidden">
          {formError ? <Notice tone="error">{formError}</Notice> : null}
        </div>

        {step === "edit" ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="lg"
              onClick={() => {
                if (check()) setStep("card");
              }}
            >
              <CreditCard aria-hidden="true" />
              Lanjut: tempel kartu
            </Button>
          </div>
        ) : (
          <section className="rounded-2xl border-2 border-signal bg-card p-4 shadow-raised sm:p-6" data-testid="walk-in-card">
            <ReaderInput
              id="walk-in-card"
              name="walkInCardUid"
              label="Tempelkan kartu RFID"
              icon={CreditCard}
              hint="Pembaca kartu mengetik UID lalu Enter. Esc untuk kembali ke isian."
              inputRef={cardRef}
              value={cardText}
              onChange={(value) => {
                setCardText(value);
                setCardError(null);
              }}
              onEnter={() => void send()}
              onEscape={() => setStep("edit")}
              busy={sending}
              error={cardError}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function ScanImage({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // an object URL lives as long as this view of the file; a new one is made after Strict Mode remounts
    const made = URL.createObjectURL(file);
    let live = true;
    void Promise.resolve().then(() => {
      if (live) setUrl(made);
    });
    return () => {
      live = false;
      URL.revokeObjectURL(made);
    };
  }, [file]);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border bg-muted" title="Buka scan dalam ukuran penuh">
      {/* a local object URL of the scan: next/image cannot optimise it */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Scan dokumen" className="max-h-[40vh] w-full object-contain lg:max-h-[70vh]" data-testid="walk-in-scan" />
    </a>
  );
}

/** The scan beside what the service read; a value it was unsure of is marked. */
function ReadSummary({ proposal, file }: { proposal: ScanProposal; file: File | null }) {
  const found = foundText(proposal.read);
  const flagged = proposal.read.fields.filter((field) => field.needsCheck).length;
  return (
    <div className="flex flex-col gap-3">
      {file ? <ScanImage file={file} /> : null}
      <section className="rounded-2xl border bg-card p-4 sm:p-5" data-testid="walk-in-read">
        <h2 className="text-base font-semibold">Hasil baca</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {[found, flagged > 0 ? `${flagged} perlu dicek` : "tidak ada yang ditandai"].filter(Boolean).join(", ")}.
        </p>
        {proposal.read.warnings.length > 0 ? (
          <ul className="mt-2 text-sm text-warning">
            {proposal.read.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <dl className="mt-3 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5 text-sm">
          {proposal.read.fields.map((field) => (
            <ReadRow key={field.key} label={field.label} flagged={field.needsCheck} reason={field.reason}>
              {readValueText(field)}
            </ReadRow>
          ))}
        </dl>
      </section>
    </div>
  );
}

function ReadRow({ label, flagged, reason, children }: { label: string; flagged: boolean; reason: string | null; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 wrap-break-word", flagged && "rounded-sm bg-warning-subtle px-1.5 text-warning")} data-flagged={flagged ? "1" : undefined}>
        <span className="font-mono">{children}</span>
        {flagged ? <span className="block text-xs">Periksa{reason ? `: ${reason}` : ""}</span> : null}
      </dd>
    </>
  );
}

/** One match of the proposal: what the document says, the status, a note, and the rows to choose from. */
function MatchLine<T, C>({
  title,
  match,
  readText,
  valueText,
  candidates,
  testId,
}: {
  title: string;
  match: Match<T, C, unknown>;
  readText: string | null;
  valueText: string | null;
  candidates?: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5 text-sm" data-testid={testId} data-status={match.status}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        <StatusBadge info={matchStatusInfo(match.status)} />
      </p>
      <p className="text-muted-foreground">
        Di dokumen: <span className="font-mono text-foreground">{readText ?? "tidak terbaca"}</span>
        {valueText ? (
          <>
            {" "}
            · di data induk: <span className="font-medium text-foreground">{valueText}</span>
          </>
        ) : null}
      </p>
      {match.note ? <p className="text-warning">{match.note}</p> : null}
      {candidates}
    </div>
  );
}

function CandidateList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="flex flex-col gap-1.5" aria-label={label}>
      {children}
    </ul>
  );
}

function Candidate({ text, detail, chosen, onChoose, label }: { text: string; detail?: string | null; chosen: boolean; onChoose: () => void; label: string }) {
  return (
    <li className={cn("flex items-center justify-between gap-2 rounded-md border px-2.5 py-2", chosen && "border-success bg-success-subtle")}>
      <span className="min-w-0">
        <span className="font-medium">{text}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      {chosen ? (
        <span className="shrink-0 text-xs font-medium text-success">Dipilih</span>
      ) : (
        <Button type="button" variant="outline" size="sm" className="h-10 shrink-0 md:h-8" onClick={onChoose} aria-label={label}>
          Pilih
        </Button>
      )}
    </li>
  );
}

// --- incoming: the contracts of the letter, its figures, the transporter ------------------------------------------------

function IncomingFields({
  form,
  proposal,
  parameters,
  errors,
  setErrors,
  change,
}: {
  form: IncomingWalkIn;
  proposal: IncomingProposal | null;
  parameters: readonly QualityParameter[];
  errors: FormErrors;
  setErrors: (update: (current: FormErrors) => FormErrors) => void;
  change: (update: (current: IncomingWalkIn) => IncomingWalkIn) => void;
}) {
  const supplier = proposal?.matches.supplier;
  const transporterMatch = proposal?.matches.transporter;
  const setRow = (key: string, update: (row: IncomingWalkIn["rows"][number]) => IncomingWalkIn["rows"][number]) =>
    change((current) => ({ ...current, rows: current.rows.map((row) => (row.key === key ? update(row) : row)) }));

  return (
    <>
      <FormSection title="Kontrak dan surat" description="Satu baris untuk tiap kontrak di surat. Pilih kontrak yang benar bila nomornya tidak persis sama.">
        {supplier ? (
          <MatchLine title="Pemasok (PKS)" match={supplier} readText={supplier.read} valueText={supplier.value?.name ?? null} testId="match-supplier" />
        ) : null}
        {form.rows.map((row, index) => {
          const match = row.source !== null ? proposal?.matches.contracts[row.source] : undefined;
          const line = row.source !== null ? proposal?.letter.lines[row.source] : undefined;
          return (
            <div key={row.key} className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0" data-row={index + 1}>
              {match ? (
                <MatchLine
                  title={`Kontrak ${index + 1}`}
                  match={match}
                  readText={match.read}
                  valueText={match.value ? `${match.value.contractNo} · ${match.value.partner.name}` : null}
                  testId={`match-contract-${index + 1}`}
                  candidates={
                    match.candidates.length > 0 ? (
                      <CandidateList label={`Kontrak yang mirip, baris ${index + 1}`}>
                        {match.candidates.map((candidate) => (
                          <Candidate
                            key={candidate.id}
                            text={candidate.contractNo}
                            detail={[candidate.partner.name, candidate.product.name, candidate.supplierMatches === false ? "pemasok lain" : null].filter(Boolean).join(" · ")}
                            chosen={String(row.contract?.id) === String(candidate.id)}
                            label={`Pilih kontrak ${candidate.contractNo}`}
                            onChoose={() => {
                              setRow(row.key, (current) => ({ ...current, contract: contractOf(candidate) }));
                              setErrors((current) => dropErrors(dropErrors(current, `rows.${index}.`), "contracts"));
                            }}
                          />
                        ))}
                      </CandidateList>
                    ) : null
                  }
                />
              ) : null}
              <div className="flex items-end gap-2">
                <ContractLookup
                  direction="IN"
                  label={row.contract ? "Kontrak" : "Cari kontrak lain"}
                  name={`rows.${index}.contract`}
                  placeholder="Cari nomor kontrak"
                  value={row.contract}
                  exclude={form.rows.filter((other) => other.key !== row.key && other.contract).map((other) => other.contract?.id ?? "")}
                  error={errors[`rows.${index}.contract`]}
                  onSelect={(contract) => {
                    setRow(row.key, (current) => ({ ...current, contract }));
                    setErrors((current) => dropErrors(dropErrors(current, `rows.${index}.`), "contracts"));
                  }}
                  onClear={() => setRow(row.key, (current) => ({ ...current, contract: null }))}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Hapus baris kontrak ${index + 1}`}
                  onClick={() => change((current) => ({ ...current, rows: current.rows.filter((item) => item.key !== row.key) }))}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              {line?.netNote ? <p className={cn("text-sm", line.netConsistent === false ? "text-destructive" : "text-warning")}>{line.netNote}</p> : null}
              {row.contract ? (
                <LetterFields
                  index={index}
                  contract={row.contract}
                  letter={row.letter}
                  parameters={parameters}
                  errors={errors}
                  onChange={(letter) => {
                    setRow(row.key, (current) => ({ ...current, letter }));
                    setErrors((current) => dropErrors(current, `letters.${index}.`));
                  }}
                />
              ) : null}
            </div>
          );
        })}
        <ContractLookup
          direction="IN"
          label={form.rows.length === 0 ? "Kontrak" : "Tambah kontrak"}
          name="walkInContractLookup"
          placeholder="Cari nomor kontrak"
          value={null}
          exclude={form.rows.flatMap((row) => (row.contract ? [row.contract.id] : []))}
          error={errors.contracts}
          onSelect={(contract) => {
            change((current) => ({
              ...current,
              rows: [...current.rows, { key: `added-${Date.now()}`, source: null, contract, letter: emptyLetter(parameters) }],
            }));
            setErrors((current) => dropErrors(current, "contracts"));
          }}
        />
      </FormSection>

      <FormSection title="Transporter">
        {transporterMatch && transporterMatch.read !== null ? (
          <MatchLine
            title="Transporter"
            match={transporterMatch}
            readText={transporterMatch.read}
            valueText={transporterMatch.value?.name ?? null}
            testId="match-transporter"
            candidates={
              transporterMatch.candidates.length > 0 ? (
                <CandidateList label="Transporter yang mirip">
                  {transporterMatch.candidates.map((candidate) => (
                    <Candidate
                      key={candidate.id}
                      text={candidate.name}
                      chosen={String(form.transporter?.id) === String(candidate.id)}
                      label={`Pilih transporter ${candidate.name}`}
                      onChoose={() => change((current) => ({ ...current, transporter: { id: candidate.id, name: candidate.name }, transporterSkipped: false }))}
                    />
                  ))}
                </CandidateList>
              ) : null
            }
          />
        ) : null}
        <TransporterLookup
          label="Transporter"
          name="transporterLookup"
          placeholder="Ketik paling sedikit dua huruf nama"
          optional
          value={form.transporter}
          onChange={(partner: PartnerRef | null) => {
            change((current) => ({ ...current, transporter: partner, transporterSkipped: partner ? false : current.transporterSkipped }));
            setErrors((current) => dropErrors(current, "transporter"));
          }}
          error={errors.transporter}
        />
        {transporterMatch && transporterMatch.read !== null && transporterMatch.status !== "EXACT" && !form.transporter ? (
          <CheckboxField
            label="Daftarkan tanpa transporter"
            name="transporterSkipped"
            checked={form.transporterSkipped}
            onChange={(checked) => change((current) => ({ ...current, transporterSkipped: checked }))}
          />
        ) : null}
      </FormSection>
    </>
  );
}

// --- outgoing: the delivery order and what this truck loads ------------------------------------------------------------

function OutgoingFields({
  form,
  proposal,
  errors,
  setErrors,
  change,
}: {
  form: OutgoingWalkIn;
  proposal: OutgoingProposal | null;
  errors: FormErrors;
  setErrors: (update: (current: FormErrors) => FormErrors) => void;
  change: (update: (current: OutgoingWalkIn) => OutgoingWalkIn) => void;
}) {
  const accepted = useApiQuery("walk-in-accepted-orders", (signal) =>
    api.request<Page<DeliveryOrder>>("/api/delivery-orders", { query: { status: "ACCEPTED", limit: 50 }, signal }),
  );
  const match = proposal?.matches.deliveryOrder;
  const choose = (order: DeliveryOrder) => {
    change((current) => ({ ...current, order }));
    setErrors((current) => dropErrors(current, "order"));
  };
  const order = form.order;

  return (
    <FormSection title="Delivery order">
      {match ? (
        <MatchLine
          title="Nomor DO"
          match={match}
          readText={match.read}
          valueText={match.value ? `${match.value.doNo} · ${match.value.partner?.name ?? "-"}` : null}
          testId="match-order"
          candidates={
            match.candidates.length > 0 ? (
              <CandidateList label="DO yang mirip">
                {match.candidates.map((candidate) => (
                  <Candidate
                    key={candidate.id}
                    text={candidate.doNo}
                    detail={[candidate.partner?.name, candidate.product?.name, `sisa ${formatQuantity(candidate.qtyRemaining, candidate.uom)}`].filter(Boolean).join(" · ")}
                    chosen={String(order?.id) === String(candidate.id)}
                    label={`Pilih DO ${candidate.doNo}`}
                    onChoose={() => choose(candidate)}
                  />
                ))}
              </CandidateList>
            ) : null
          }
        />
      ) : null}
      <SelectField
        label={order ? "DO" : "Pilih DO"}
        name="order"
        value={order ? String(order.id) : ""}
        onChange={(value) => {
          const found = (accepted.data?.items ?? []).find((item) => String(item.id) === value);
          if (found) choose(found);
        }}
        error={errors.order}
        emptyLabel="Pilih DO yang sudah diterima transporter"
        options={[
          ...(order && !(accepted.data?.items ?? []).some((item) => String(item.id) === String(order.id)) ? [order] : []),
          ...(accepted.data?.items ?? []),
        ].map((item) => ({ value: String(item.id), label: `${item.doNo} · ${item.partner?.name ?? "-"} · sisa ${formatQuantity(item.qtyRemaining, item.uom)}` }))}
      />
      {accepted.hasError ? <p className="text-sm text-destructive">Daftar DO yang sudah diterima belum bisa dimuat.</p> : null}
      {order ? (
        <p className="text-sm text-muted-foreground" data-testid="walk-in-order">
          {[order.partner?.name, order.product?.name, order.transporter?.name, `sisa ${formatQuantity(order.qtyRemaining, order.uom)}`].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      <TextField
        label="Quantity yang dimuat truk ini (kg)"
        name="qty"
        inputMode="numeric"
        value={form.qty}
        onChange={(value) => {
          change((current) => ({ ...current, qty: value }));
          setErrors((current) => dropErrors(current, "qty"));
        }}
        error={errors.qty}
        className="sm:max-w-xs"
      />
    </FormSection>
  );
}

// --- the truck of the letter: the plate and the driver as read, and drivers to choose from ----------------------------

function TruckMatches({ form, proposal, updateTruck }: { form: WalkInForm; proposal: ScanProposal | null; updateTruck: (change: (truck: TruckValues) => TruckValues) => void }) {
  if (proposal?.direction !== "IN") {
    return proposal ? <p className="text-sm text-muted-foreground">Surat DO tidak memuat nomor polisi dan supir. Isi plat dan nomor SIM truk yang memuat.</p> : null;
  }
  const { vehicle, driver } = proposal.matches;
  const readDriver = [driver.read.fullName, driver.read.licenceNo ? `SIM ${driver.read.licenceNo}` : null].filter(Boolean).join(", ") || null;
  return (
    <div className="flex flex-col gap-2">
      <MatchLine title="Kendaraan" match={vehicle} readText={vehicle.read} valueText={vehicle.value?.plateDisplay ?? null} testId="match-vehicle" />
      {vehicle.read !== null && form.truck.plate && !plateIsRead(form, vehicle.read) ? (
        <p className="text-sm text-warning">Plat di isian berbeda dari yang terbaca di surat ({vehicle.read}).</p>
      ) : null}
      <MatchLine
        title="Supir"
        match={driver}
        readText={readDriver}
        valueText={driver.value ? `${driver.value.fullName}, SIM ${driver.value.licenceNo}` : null}
        testId="match-driver"
        candidates={
          driver.candidates.length > 0 ? (
            <CandidateList label="Supir yang mirip">
              {driver.candidates.map((candidate) => (
                <Candidate
                  key={candidate.id}
                  text={candidate.fullName}
                  detail={`SIM ${candidate.licenceNo}${candidate.licenceClass ? `, ${candidate.licenceClass}` : ""}`}
                  chosen={form.truck.licenceNo.replace(/\s+/g, "").toUpperCase() === candidate.licenceNo}
                  label={`Pilih supir ${candidate.fullName}`}
                  onChoose={() => {
                    const next = { ...form.truck, licenceNo: candidate.licenceNo, fullName: "" };
                    updateTruck(() => next);
                    void lookUpDriver(next, updateTruck);
                  }}
                />
              ))}
            </CandidateList>
          ) : null
        }
      />
    </div>
  );
}

// --- the two outcomes -----------------------------------------------------------------------------------------------------

function WalkInOutcome({ result, onNext }: { result: WalkInResult; onNext: () => void }) {
  const { registration, trip } = result;
  const href = `/registrasi/${encodeURIComponent(String(registration.id))}`;
  if (result.state === "CHECKED_IN" && trip) {
    return (
      <section className="rounded-2xl border-2 border-success bg-success-subtle p-5 sm:p-6" data-testid="walk-in-done">
        <div className="flex items-start gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-success text-background">
            <CircleCheck className="size-8" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="display text-[clamp(1.5rem,1.1rem+1.6vw,2.25rem)] leading-tight font-semibold text-success">Check-in berhasil</p>
            <p className="text-base text-success">
              <span className="plate mr-1 text-foreground">{trip.vehicle?.plateDisplay ?? "-"}</span> membawa kartu{" "}
              <span className="font-mono font-semibold">{trip.card?.label ?? trip.card?.uid ?? "-"}</span>.
              {trip.tripNo ? ` Nomor trip ${trip.tripNo}.` : ""}
              {trip.direction === "OUT"
                ? ` Close cargo: ${cargoMarkText(trip.closeCargo).toLowerCase()}. Flexi bag: ${cargoMarkText(trip.flexiBag).toLowerCase()}.`
                : ""}
            </p>
            <p className="text-sm text-foreground">
              Registrasi <Link href={href} className="font-medium underline underline-offset-2">{registration.regNo}</Link>
              {result.emergency ? " dicatat sebagai registrasi darurat." : " dibuat dari scan dokumen."}
            </p>
            <div className="mt-1">
              <Button type="button" size="lg" onClick={onNext}>
                <ScanLine aria-hidden="true" />
                Truk berikutnya
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="rounded-2xl border-2 border-warning bg-warning-subtle p-5 sm:p-6" data-testid="walk-in-review">
      <div className="flex items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-warning text-background">
          <Clock className="size-8" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-2">
          <p className="display text-[clamp(1.5rem,1.1rem+1.6vw,2.25rem)] leading-tight font-semibold text-warning">Menunggu tinjauan logistik</p>
          <p className="text-base text-foreground">{result.message ?? "Registrasi menunggu tinjauan logistik. Truk belum check-in dan kartu belum dipakai."}</p>
          {registration.findings.length > 0 ? (
            <ul className="flex flex-col gap-1 pl-5 text-sm text-foreground">
              {registration.findings.map((finding, index) => (
                <li key={`${finding.code}-${index}`} className="list-disc">
                  {finding.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-sm text-foreground">
            Setelah disetujui, SPJ terbit dan truk check-in lewat scan SPJ seperti biasa. Registrasi{" "}
            <Link href={href} className="font-medium underline underline-offset-2">{registration.regNo}</Link>
            {result.emergency ? " dicatat sebagai registrasi darurat." : "."}
          </p>
          <div className="mt-1">
            <Button type="button" size="lg" onClick={onNext}>
              <ScanLine aria-hidden="true" />
              Truk berikutnya
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
