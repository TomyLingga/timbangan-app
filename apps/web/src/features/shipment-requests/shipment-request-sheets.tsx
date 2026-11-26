"use client";

import { useState } from "react";

import { ActionSheet } from "@/components/action-sheet";
import { ContractLookup } from "@/components/contract-lookup";
import { TextAreaField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { PartnerLookup } from "@/components/partner-lookup";
import { useAction } from "@/hooks/use-form";
import { isApiError } from "@/lib/api-client";
import { formatQuantity } from "@/lib/format";
import { shipmentRequestErrorMessage } from "@/lib/messages";
import { api } from "@/lib/session";
import {
  contractRequestText,
  EMPTY_SHIPMENT_REQUEST,
  sendBlocker,
  shipmentRequestPayload,
  shipmentRequestValues,
  validateShipmentRequest,
  type ShipmentRequestValues,
} from "@/lib/shipment-requests";
import type { Contract, PartnerRef, ShipmentRequest } from "@/lib/types";
import type { FormErrors } from "@/lib/workflow-forms";

const requestPath = (request: Pick<ShipmentRequest, "id">) => `/api/shipment-requests/${encodeURIComponent(String(request.id))}`;

/** The contract as the form shows it: who it is with, its goods, and how much of it the requests already plan. */
interface ChosenContract {
  contractNo: string;
  detail: string;
  qtyContract: number | null;
  qtyRequested: number | null;
  uom: string | null;
}

/**
 * A new request (`request` null) or a change of one: a draft fully, a sent one only quantity, end date and remark.
 * The request goes to one mill (PKS); a contract may be supplied by several mills, each with its own request.
 */
export function ShipmentRequestFormSheet({
  request,
  onClose,
  onSaved,
}: {
  request: ShipmentRequest | null;
  onClose: () => void;
  onSaved: (request: ShipmentRequest, created: boolean) => void;
}) {
  const mode = request === null ? "create" : request.status.toUpperCase() === "DRAFT" ? "draft" : "sent";
  const [values, setValues] = useState<ShipmentRequestValues>(request ? shipmentRequestValues(request) : EMPTY_SHIPMENT_REQUEST);
  const [errors, setErrors] = useState<FormErrors>({});
  const [contract, setContract] = useState<ChosenContract | null>(
    request
      ? {
          contractNo: request.contract.contractNo,
          detail: `${request.partner.name} · ${request.product.name}`,
          qtyContract: request.contract.qtyContract,
          qtyRequested: request.contract.qtyRequested ?? null,
          uom: request.contract.uom,
        }
      : null,
  );
  const [supplier, setSupplier] = useState<PartnerRef | null>(request ? request.supplier : null);
  // the request being changed is already in the sum of the contract
  const own = request && request.status.toUpperCase() !== "CANCELLED" ? (request.qtyPlanned ?? 0) : 0;
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();

  const set = (name: keyof ShipmentRequestValues, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: "" } : current));
  };

  async function handleSubmit() {
    const found = validateShipmentRequest(values, mode);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    const body = shipmentRequestPayload(values, mode);
    const outcome = await save.run(() =>
      request
        ? api.request<{ shipmentRequest: ShipmentRequest }>(requestPath(request), { method: "PATCH", body })
        : api.request<{ shipmentRequest: ShipmentRequest }>("/api/shipment-requests", { method: "POST", body }),
    );
    if (outcome.ok) {
      onSaved(outcome.value.shipmentRequest, request === null);
      return;
    }
    if (isApiError(outcome.error)) setErrors(outcome.error.fieldMessages);
    setFormError(shipmentRequestErrorMessage(outcome.error));
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={request ? `Ubah permintaan ${request.contract.contractNo}` : "Permintaan pengiriman baru"}
      description={
        mode === "sent"
          ? "Permintaan sudah dikirim, jadi yang bisa diubah hanya quantity, tanggal akhir kirim, dan keterangan."
          : "Satu permintaan untuk satu kontrak dan satu PKS. Kontrak yang dipasok beberapa PKS diberi satu permintaan per PKS. Setelah disimpan, lampirkan PDF kontrak lalu kirim."
      }
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      {mode === "sent" ? null : (
        <>
          <ContractLookup
            direction="IN"
            label="Kontrak beli"
            name="contractLookup"
            placeholder="Cari nomor kontrak atau supplier"
            value={contract}
            hint="Partner kontrak dan barang terisi dari kontrak."
            onSelect={(chosen: Contract) => {
              setContract({
                contractNo: chosen.contractNo,
                detail: `${chosen.partner.name} · ${chosen.product.name} · ${formatQuantity(chosen.qtyContract, chosen.uom)}`,
                qtyContract: chosen.qtyContract === null ? null : Number(chosen.qtyContract),
                qtyRequested: chosen.requests?.qtyRequested ?? null,
                uom: chosen.uom,
              });
              set("contractId", String(chosen.id));
            }}
            onClear={() => {
              setContract(null);
              set("contractId", "");
            }}
            error={errors.contractId}
          />
          {contract ? <p className="rounded-md bg-muted px-3 py-2 text-sm">{contract.detail}</p> : null}
          <PartnerLookup
            role="supplier"
            label="PKS pengirim"
            name="supplierLookup"
            placeholder="Cari nama PKS"
            value={supplier}
            onChange={(chosen) => {
              setSupplier(chosen);
              set("supplierId", chosen ? String(chosen.id) : "");
            }}
            error={errors.supplierId}
          />
        </>
      )}
      {contract ? (
        <p className="text-sm text-muted-foreground" data-testid="contract-requested">
          {contractRequestText(contract.qtyContract, contract.qtyRequested, contract.uom, own)}
        </p>
      ) : null}
      <TextField
        label="Quantity rencana (kg)"
        name="qtyPlanned"
        inputMode="decimal"
        optional
        value={values.qtyPlanned}
        onChange={(value) => set("qtyPlanned", value)}
        error={errors.qtyPlanned}
        hint="Boleh dikosongkan bila mengikuti sisa kontrak."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {mode === "sent" ? null : (
          <TextField
            label="Mulai kirim"
            name="deliveryFrom"
            type="date"
            optional
            value={values.deliveryFrom}
            onChange={(value) => set("deliveryFrom", value)}
            error={errors.deliveryFrom}
          />
        )}
        <TextField
          label="Akhir kirim"
          name="deliveryUntil"
          type="date"
          optional
          value={values.deliveryUntil}
          onChange={(value) => set("deliveryUntil", value)}
          error={errors.deliveryUntil}
        />
      </div>
      <TextAreaField
        label="Keterangan"
        name="remark"
        optional
        rows={3}
        value={values.remark}
        onChange={(value) => set("remark", value)}
        error={errors.remark}
      />
    </FormSheet>
  );
}

export type RequestAction = "send" | "close" | "cancel";

async function transition(request: ShipmentRequest, action: RequestAction, body: unknown = {}): Promise<string | null> {
  try {
    await api.request(`${requestPath(request)}/${action}`, { method: "POST", body });
    return null;
  } catch (error) {
    return shipmentRequestErrorMessage(error);
  }
}

/** Send to the supplier, close, or cancel with a reason. `onDone` gets the sentence for the page. */
export function RequestActionSheet({
  request,
  action,
  onClose,
  onDone,
}: {
  request: ShipmentRequest;
  action: RequestAction;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const no = request.contract.contractNo;
  if (action === "send") {
    const blocker = sendBlocker(request);
    return (
      <ActionSheet
        title={`Kirim permintaan ${no}`}
        description={
          blocker ??
          `Permintaan dan PDF kontrak dikirim ke akun ${request.supplier.name}. Setelah itu PKS ini bisa mendaftarkan truk untuk kontrak ini. Yang masih bisa diubah hanya quantity, tanggal akhir kirim, dan keterangan.`
        }
        submitLabel="Kirim ke supplier"
        onClose={onClose}
        onConfirm={async () => {
          if (blocker) return blocker;
          const failure = await transition(request, "send");
          if (!failure) onDone(`Permintaan ${no} dikirim ke ${request.supplier.name}.`);
          return failure;
        }}
      />
    );
  }
  if (action === "close") {
    return (
      <ActionSheet
        title={`Tutup permintaan ${no}`}
        description={`Setelah ditutup, ${request.supplier.name} tidak bisa mendaftarkan truk baru untuk kontrak ini. Kontrak boleh diberi permintaan baru.`}
        submitLabel="Tutup permintaan"
        onClose={onClose}
        onConfirm={async () => {
          const failure = await transition(request, "close");
          if (!failure) onDone(`Permintaan ${no} ditutup.`);
          return failure;
        }}
      />
    );
  }
  return (
    <ActionSheet
      title={`Batalkan permintaan ${no}`}
      description={`Permintaan yang dibatalkan tidak bisa dipakai lagi. ${request.supplier.name} tidak bisa mendaftarkan truk baru untuk kontrak ini.`}
      submitLabel="Batalkan permintaan"
      reasonLabel="Alasan"
      reasonRequired="Isi alasan pembatalan."
      onClose={onClose}
      onConfirm={async (reason) => {
        const failure = await transition(request, "cancel", { reason });
        if (!failure) onDone(`Permintaan ${no} dibatalkan.`);
        return failure;
      }}
    />
  );
}
