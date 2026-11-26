"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { AttachmentList, type ListedFile } from "@/components/attachments";
import { ContractLookup } from "@/components/contract-lookup";
import { TextAreaField, TextField } from "@/components/form-fields";
import { ListError, ListSkeleton, Notice, PageHeader } from "@/components/page-parts";
import { PartnerLookup, TransporterLookup } from "@/components/partner-lookup";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { dropErrors, FormSection, SubmitBar, focusFirstInvalid } from "@/features/registrations/form-parts";
import { lookUpDriver, lookUpVehicle, TruckFields } from "@/features/registrations/truck-fields";
import { useApiQuery } from "@/hooks/use-api-query";
import { MAX_TRIP_SLIPS } from "@/lib/attachments";
import { formatNumber, formatQuantity } from "@/lib/format";
import { isApiError } from "@/lib/api-client";
import { registrationErrorMessage } from "@/lib/messages";
import { changeQuery } from "@/lib/registration-changes";
import { isStaff } from "@/lib/permissions";
import { documentTotals, wholeKg } from "@/lib/quantity";
import { api } from "@/lib/session";
import type { Contract, ContractList, PartnerRef, QualityParameter, Registration, SpjChange, UploadedFile, VehicleType } from "@/lib/types";
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

/** The letter of the mill for one contract of an incoming truck; also filled from a scanned letter at the post. */
export function LetterFields({
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
  supplier,
  ownCompany,
  chosenContract,
  contractMissing,
}: {
  types: VehicleType[];
  parameters: QualityParameter[];
  /** A draft to change with PUT; without it the form creates a registration. */
  draft: Registration | null;
  /** A supplier account: only contracts with a shipment request sent to it are offered. */
  supplier: boolean;
  /** The company of a supplier account, shown as the asal PKS. */
  ownCompany?: string | null;
  /** The contract of the shipment request the form was opened from (`?kontrak=`). */
  chosenContract: Contract | null;
  /** The address named a contract that is not offered any more. */
  contractMissing: boolean;
}) {
  const router = useRouter();
  // a registration already sent is changed in place: no draft, no slips (they are added on its page)
  const sent = draft !== null && draft.status.toUpperCase() !== "DRAFT";
  const [initial] = useState(() => (draft ? incomingFromDraft(draft, parameters) : null));
  const [contracts, setContracts] = useState<Contract[]>(initial?.contracts ?? (chosenContract ? [chosenContract] : []));
  const [letters, setLetters] = useState<LetterValues[]>(initial?.letters ?? (chosenContract ? [emptyLetter(parameters)] : []));
  const [transporter, setTransporter] = useState<PartnerRef | null>(initial?.transporter ?? null);
  // asal PKS: staff name it; a mill's account sends nothing and the API takes its own company
  const [origin, setOrigin] = useState<PartnerRef | null>(initial?.origin ?? null);
  const [plannedDate, setPlannedDate] = useState(initial?.plannedDate || plantToday());
  const [truck, setTruck] = useState<TruckValues>(() => initial?.truck ?? emptyTruck("truck"));
  const [remark, setRemark] = useState(initial?.remark ?? "");
  // slips already linked to the draft's truck, and slips uploaded here that are linked once the registration is saved
  const [linkedSlips, setLinkedSlips] = useState<ListedFile[]>(() => draft?.trips[0]?.slips ?? []);
  const [pendingSlips, setPendingSlips] = useState<UploadedFile[]>([]);
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
    const values = { contracts, transporter, ...(supplier ? {} : { origin }), plannedDate, truck, letters, remark };
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
      // New slips can only be linked to a saved truck: the registration is saved as a draft first, the slips are
      // linked, and only then is it sent.
      const linkFirst = !sent && pendingSlips.length > 0;
      const { registration, spjChanges } = await api.request<{ registration: Registration; spjChanges?: SpjChange[] }>(
        draft ? `/api/registrations/${encodeURIComponent(String(draft.id))}` : "/api/registrations",
        { method: draft ? "PUT" : "POST", body: incomingPayload(values, submit && !linkFirst) },
      );
      const id = encodeURIComponent(String(registration.id));
      if (sent) {
        router.push(`/registrasi/${id}?${changeQuery(spjChanges ?? [])}`);
        return;
      }
      if (linkFirst) {
        const tripId = registration.trips[0]?.id;
        try {
          for (const slip of pendingSlips) {
            await api.request(`/api/registrations/${id}/trips/${encodeURIComponent(String(tripId))}/files`, { method: "POST", body: { fileId: slip.id } });
          }
        } catch {
          // the draft is kept; the slips can be added again from its page
          router.push(`/registrasi/${id}?baru=slip`);
          return;
        }
        if (submit) await api.request(`/api/registrations/${id}/submit`, { method: "POST" });
      }
      router.push(`/registrasi/${id}?baru=${submit ? "kirim" : "draf"}`);
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
        title={draft ? (sent ? `Ubah ${draft.regNo}` : `Ubah draf ${draft.regNo}`) : "Registrasi incoming"}
        description="Satu registrasi untuk satu truk. Truk boleh membawa beberapa kontrak dari partner yang sama."
      />

      <FormSection
        title="1. Kontrak"
        description={
          supplier ? "Kontrak beli yang permintaan pengirimannya sudah dikirim INL ke perusahaan Anda." : "Kontrak beli yang masih terbuka."
        }
      >
        {contractMissing ? (
          <Notice tone="warning">Kontrak dari permintaan pengiriman ini tidak bisa dipakai lagi, mungkin permintaannya sudah ditutup. Pilih kontrak dari daftar.</Notice>
        ) : null}
        <ContractLookup
          direction="IN"
          label="Tambah kontrak"
          name="contractLookup"
          placeholder="Cari nomor kontrak"
          value={null}
          requestSent={supplier}
          hint={supplier ? "Kontrak yang belum dikirim INL tidak muncul di sini." : undefined}
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
          {supplier ? (
            <div className="min-w-0" data-testid="origin-own">
              <p className="text-sm font-medium">Asal PKS</p>
              <p className="mt-1 text-sm text-muted-foreground">{ownCompany ?? "Perusahaan Anda"} (dari akun yang masuk)</p>
            </div>
          ) : (
            <PartnerLookup
              role="supplier"
              label="Asal PKS"
              name="originLookup"
              placeholder="Cari nama PKS"
              optional
              value={origin}
              onChange={(partner) => {
                setOrigin(partner);
                setErrors((current) => dropErrors(current, "origin"));
              }}
              error={errors.origin}
            />
          )}
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

      {sent ? (
        <Notice tone="warning">
          Registrasi ini sudah dikirim. Bila plat, kendaraan, atau supir diganti, SPJ lama dicabut dan SPJ baru harus dicetak. Slip timbang ditambah dari halaman registrasi.
        </Notice>
      ) : null}
      {sent ? null : (
      <FormSection
        title="5. Slip timbang"
        description="Slip dari timbangan PKS untuk truk ini, paling banyak tiga berkas. Slip ikut terkirim saat registrasi disimpan."
      >
        <AttachmentList
          title="Slip timbang truk 1"
          files={[...linkedSlips, ...pendingSlips]}
          max={MAX_TRIP_SLIPS}
          canChange
          onAdd={async (file) => {
            setPendingSlips((current) => [...current, file]);
          }}
          onRemove={async (file) => {
            if (pendingSlips.some((slip) => slip.id === file.id)) {
              setPendingSlips((current) => current.filter((slip) => slip.id !== file.id));
              return;
            }
            const tripId = draft?.trips[0]?.id;
            if (!draft || tripId === undefined) return;
            await api.request(
              `/api/registrations/${encodeURIComponent(String(draft.id))}/trips/${encodeURIComponent(String(tripId))}/files/${encodeURIComponent(String(file.id))}`,
              { method: "DELETE" },
            );
            setLinkedSlips((current) => current.filter((slip) => slip.id !== file.id));
          }}
          emptyText="Belum ada slip timbang."
          hint="PDF sampai 10 MB atau foto slip sampai 5 MB."
          testId="form-slips"
        />
      </FormSection>
      )}

      <FormSection title="6. Catatan">
        <TextAreaField label="Catatan" name="remark" optional rows={2} value={remark} onChange={setRemark} />
      </FormSection>

      <SubmitBar pending={pending} error={formError} onDraft={() => void save(false)} onSubmit={() => void save(true)} sent={sent} />
    </form>
  );
}

/** Contracts with a shipment request sent to the supplier read at once to find the one named in the address. */
const SENT_CONTRACT_LIMIT = 50;

/**
 * Loads the vehicle types and quality parameters the form depends on, and the contract named by `contractId`
 * (a supplier opening the form from a shipment request).
 */
export function IncomingForm({ draft = null, contractId = null }: { draft?: Registration | null; contractId?: string | null }) {
  const { state } = useAuth();
  const supplier = state.status === "authenticated" && !isStaff(state.user);
  const types = useApiQuery("vehicle-types", (signal) => api.request<{ items: VehicleType[] }>("/api/vehicle-types", { signal }));
  const parameters = useApiQuery("quality-parameters", (signal) =>
    api.request<{ items: QualityParameter[] }>("/api/quality-parameters", { signal }),
  );
  const named = contractId && !draft ? contractId : null;
  const sent = useApiQuery(named ? `sent-contracts|${supplier}` : null, (signal) =>
    api.request<ContractList>("/api/contracts", {
      query: { direction: "IN", limit: SENT_CONTRACT_LIMIT, ...(supplier ? { requestSent: "true" } : {}) },
      signal,
    }),
  );
  const failure = types.hasError ? types.error : parameters.hasError ? parameters.error : sent.hasError ? sent.error : null;
  if (failure) {
    return (
      <ListError
        title="Form registrasi belum bisa dibuka"
        error={failure}
        onRetry={() => {
          types.reload();
          parameters.reload();
          sent.reload();
        }}
      />
    );
  }
  if (!types.data || !parameters.data || (named && !sent.data)) return <ListSkeleton label="Menyiapkan form registrasi" />;
  const chosen = named ? (sent.data?.items.find((contract) => String(contract.id) === named) ?? null) : null;
  return (
    <IncomingFormBody
      types={types.data.items}
      parameters={parameters.data.items}
      draft={draft}
      supplier={supplier}
      ownCompany={state.status === "authenticated" ? (state.user.partner?.name ?? null) : null}
      chosenContract={chosen}
      contractMissing={Boolean(named) && chosen === null}
    />
  );
}
