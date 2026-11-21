"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { ContractLookup } from "@/components/contract-lookup";
import { TextAreaField, TextField } from "@/components/form-fields";
import { ListError, ListSkeleton, PageHeader } from "@/components/page-parts";
import { TransporterLookup } from "@/components/partner-lookup";
import { Button } from "@/components/ui/button";
import { dropErrors, FormSection, SubmitBar, focusFirstInvalid } from "@/features/registrations/form-parts";
import { lookUpDriver, lookUpVehicle, TruckFields } from "@/features/registrations/truck-fields";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatNumber, formatQuantity } from "@/lib/format";
import { isApiError } from "@/lib/api-client";
import { registrationErrorMessage } from "@/lib/messages";
import { documentTotals, wholeKg } from "@/lib/quantity";
import { api } from "@/lib/session";
import type { Contract, PartnerRef, QualityParameter, Registration, VehicleType } from "@/lib/types";
import {
  emptyLetter,
  emptyTruck,
  incomingFromDraft,
  incomingPayload,
  registrationFieldErrors,
  validateIncoming,
  type FormErrors,
  type LetterValues,
  type TruckValues,
} from "@/lib/workflow-forms";

export function plantToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function LetterFields({
  index,
  contract,
  letter,
  parameters,
  errors,
  onChange,
}: {
  index: number;
  contract: Contract;
  letter: LetterValues;
  parameters: readonly QualityParameter[];
  errors: FormErrors;
  onChange: (letter: LetterValues) => void;
}) {
  const prefix = `letters.${index}`;
  const field = (name: Exclude<keyof LetterValues, "quality">, label: string, extra: Record<string, unknown> = {}) => (
    <TextField
      label={label}
      name={`${prefix}.${name}`}
      optional
      value={letter[name]}
      onChange={(value) => onChange({ ...letter, [name]: value })}
      error={errors[`${prefix}.${name}`]}
      {...extra}
    />
  );
  return (
    <fieldset className="flex flex-col gap-4 border-t pt-4 first:border-t-0 first:pt-0">
      <legend className="text-sm font-semibold">
        Surat untuk kontrak {contract.contractNo}
      </legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("spbNo", "Nomor SPB")}
        {field("spbDate", "Tanggal SPB", { type: "date" })}
        {field("handoverNo", "Nomor penyerahan")}
        {field("originTicketNo", "Nomor tiket timbang asal")}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {field("originGrossKg", "Bruto asal (kg)", { inputMode: "numeric" })}
        {field("originTareKg", "Tarra asal (kg)", { inputMode: "numeric" })}
        {field("originNetKg", "Netto asal (kg)", { inputMode: "numeric" })}
      </div>
      {parameters.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {parameters.map((parameter) => (
            <TextField
              key={parameter.code}
              label={`${parameter.name}${parameter.unit ? ` (${parameter.unit})` : ""}`}
              name={`${prefix}.quality.${parameter.code}`}
              inputMode="decimal"
              optional
              value={letter.quality[parameter.code] ?? ""}
              onChange={(value) => onChange({ ...letter, quality: { ...letter.quality, [parameter.code]: value } })}
              error={errors[`${prefix}.quality.${parameter.code}`]}
            />
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

function IncomingFormBody({
  types,
  parameters,
  draft,
}: {
  types: VehicleType[];
  parameters: QualityParameter[];
  /** A draft to change with PUT; without it the form creates a registration. */
  draft: Registration | null;
}) {
  const router = useRouter();
  const [initial] = useState(() => (draft ? incomingFromDraft(draft, parameters) : null));
  const [contracts, setContracts] = useState<Contract[]>(initial?.contracts ?? []);
  const [letters, setLetters] = useState<LetterValues[]>(initial?.letters ?? []);
  const [transporter, setTransporter] = useState<PartnerRef | null>(initial?.transporter ?? null);
  const [plannedDate, setPlannedDate] = useState(initial?.plannedDate || plantToday());
  const [truck, setTruck] = useState<TruckValues>(() => initial?.truck ?? emptyTruck("truck"));
  const [remark, setRemark] = useState(initial?.remark ?? "");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<"draft" | "submit" | null>(null);

  // A draft comes back with its plate and licence; both are looked up again once.
  const lookedUp = useRef(false);
  useEffect(() => {
    if (!initial || lookedUp.current) return;
    lookedUp.current = true;
    void lookUpVehicle(initial.truck, setTruck);
    void lookUpDriver(initial.truck, setTruck);
  }, [initial]);

  const totals = documentTotals(
    letters.map((letter) => ({
      originGrossKg: wholeKg(letter.originGrossKg),
      originTareKg: wholeKg(letter.originTareKg),
      originNetKg: wholeKg(letter.originNetKg),
    })),
  );

  async function save(submit: boolean) {
    const values = { contracts, transporter, plannedDate, truck, letters, remark };
    const found = validateIncoming(values, { types, parameters, currentYear: new Date().getFullYear() });
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      setFormError("Periksa kolom yang ditandai.");
      focusFirstInvalid();
      return;
    }
    setPending(submit ? "submit" : "draft");
    try {
      const { registration } = await api.request<{ registration: Registration }>(
        draft ? `/api/registrations/${encodeURIComponent(String(draft.id))}` : "/api/registrations",
        { method: draft ? "PUT" : "POST", body: incomingPayload(values, submit) },
      );
      router.push(`/registrasi/${encodeURIComponent(String(registration.id))}?baru=${submit ? "kirim" : "draf"}`);
    } catch (error) {
      const placed = isApiError(error) ? registrationFieldErrors("IN", error.fieldMessages) : { errors: {}, unplaced: [] };
      setErrors(placed.errors);
      setFormError(registrationErrorMessage(error, placed.unplaced));
      setPending(null);
      if (Object.keys(placed.errors).length > 0) focusFirstInvalid();
    }
  }

  return (
    <form noValidate onSubmit={(event) => event.preventDefault()} className="flex flex-col gap-5">
      <PageHeader
        title={draft ? `Ubah draf ${draft.regNo}` : "Registrasi incoming"}
        description="Satu registrasi untuk satu truk. Truk boleh membawa beberapa kontrak dari partner yang sama."
      />

      <FormSection title="1. Kontrak" description="Kontrak beli yang masih terbuka.">
        <ContractLookup
          direction="IN"
          label="Tambah kontrak"
          name="contractLookup"
          placeholder="Cari nomor kontrak"
          value={null}
          exclude={contracts.map((contract) => contract.id)}
          error={errors.contracts}
          onSelect={(contract) => {
            setContracts((current) => [...current, contract]);
            setLetters((current) => [...current, emptyLetter(parameters)]);
            setErrors((current) => dropErrors(current, "contracts"));
          }}
        />
        {contracts.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Kontrak terpilih">
            {contracts.map((contract, index) => (
              <li key={contract.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{contract.contractNo}</span>
                  <span className="block text-xs wrap-break-word text-muted-foreground">
                    {contract.partner.name} · {contract.product.name} · {formatQuantity(contract.qtyContract, contract.uom)}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Hapus kontrak ${contract.contractNo}`}
                  onClick={() => {
                    setContracts((current) => current.filter((_, at) => at !== index));
                    setLetters((current) => current.filter((_, at) => at !== index));
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </FormSection>

      <FormSection title="2. Pengiriman">
        <div className="grid gap-4 sm:grid-cols-2">
          <TransporterLookup
            label="Transporter"
            name="transporterLookup"
            placeholder="Ketik paling sedikit dua huruf nama"
            optional
            value={transporter}
            onChange={(partner) => {
              setTransporter(partner);
              setErrors((current) => dropErrors(current, "transporter"));
            }}
            error={errors.transporter}
          />
          <TextField
            label="Tanggal datang"
            name="plannedDate"
            type="date"
            value={plannedDate}
            onChange={setPlannedDate}
            error={errors.plannedDate}
          />
        </div>
      </FormSection>

      <FormSection title="3. Truk dan supir">
        <TruckFields
          truck={truck}
          update={(change) => {
            setTruck(change);
            setErrors((current) => dropErrors(current, "truck."));
          }}
          errors={errors}
          prefix="truck"
          types={types}
        />
      </FormSection>

      <FormSection
        title="4. Data surat dan spek"
        description="Isi sesuai surat dari PKS. Bila bruto, tarra, dan netto diisi semua, netto harus sama dengan bruto dikurangi tarra."
      >
        {contracts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Pilih kontrak dulu; isian surat muncul untuk tiap kontrak.</p>
        ) : (
          contracts.map((contract, index) => (
            <LetterFields
              key={contract.id}
              index={index}
              contract={contract}
              letter={letters[index]}
              parameters={parameters}
              errors={errors}
              onChange={(letter) => {
                setLetters((current) => current.map((item, at) => (at === index ? letter : item)));
                setErrors((current) => dropErrors(current, `letters.${index}.`));
              }}
            />
          ))
        )}
        {totals.netKg !== null ? (
          <p className="rounded-md bg-muted px-3 py-2.5 text-sm" data-testid="document-totals">
            Angka truk dari surat: bruto {formatNumber(totals.grossKg)} kg, tarra {formatNumber(totals.tareKg)} kg, netto{" "}
            {formatNumber(totals.netKg)} kg.
          </p>
        ) : null}
      </FormSection>

      <FormSection title="5. Catatan">
        <TextAreaField label="Catatan" name="remark" optional rows={2} value={remark} onChange={setRemark} />
      </FormSection>

      <SubmitBar pending={pending} error={formError} onDraft={() => void save(false)} onSubmit={() => void save(true)} />
    </form>
  );
}

/** Loads the vehicle types and quality parameters the form depends on. */
export function IncomingForm({ draft = null }: { draft?: Registration | null }) {
  const types = useApiQuery("vehicle-types", (signal) => api.request<{ items: VehicleType[] }>("/api/vehicle-types", { signal }));
  const parameters = useApiQuery("quality-parameters", (signal) =>
    api.request<{ items: QualityParameter[] }>("/api/quality-parameters", { signal }),
  );
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
  return <IncomingFormBody types={types.data.items} parameters={parameters.data.items} draft={draft} />;
}
