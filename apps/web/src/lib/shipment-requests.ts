// Shipment requests (API migration 0017, owner's flow of 25 November 2026, incoming step 1): the INL team picks a
// purchase contract and the mill (PKS) to deliver it, attaches the contract PDF and sends the request to the mill's
// accounts. A mill registers incoming trucks only on a contract whose request was sent to it. A contract may be
// supplied by several mills, each with its own request and quantity (migration 0018). DRAFT -> SENT -> CLOSED;
// DRAFT or SENT -> CANCELLED. The API (apps/api src/shipment-requests/routes.ts) checks every rule again; these helpers decide what
// the pages offer and what the forms send.

import { formatDate, formatQuantity } from "@/lib/format";
import { canCreate, canTypeIncoming, isStaff } from "@/lib/permissions";
import type { StatusInfo } from "@/lib/status";
import type { ShipmentRequest, User } from "@/lib/types";
import { decimalNumber, type FormErrors } from "@/lib/workflow-forms";

type MaybeUser = User | null | undefined;

/** At most this many files per request (MAX_REQUEST_FILES in apps/api src/attachments/routes.ts). */
export const MAX_REQUEST_FILES = 5;

const STATUSES: Record<string, StatusInfo> = {
  DRAFT: { label: "Draf", tone: "neutral" },
  SENT: { label: "Terkirim", tone: "success" },
  CLOSED: { label: "Ditutup", tone: "neutral" },
  CANCELLED: { label: "Batal", tone: "destructive" },
};

export function shipmentRequestStatusInfo(status: string): StatusInfo {
  return STATUSES[status.trim().toUpperCase()] ?? { label: status || "-", tone: "neutral" };
}

/** The status filter of the list; a supplier account never sees a draft or a cancelled request. */
export function statusFilters(staff: boolean): Array<{ value: string; label: string }> {
  const all = ["DRAFT", "SENT", "CLOSED", "CANCELLED"].map((value) => ({ value, label: STATUSES[value].label }));
  return staff ? all : all.filter((option) => option.value === "SENT" || option.value === "CLOSED");
}

const is = (request: Pick<ShipmentRequest, "status">, ...statuses: string[]) => statuses.includes(request.status.toUpperCase());

/** "21 Nov 2026 sampai 30 Nov 2026", "Mulai 21 Nov 2026", "Sampai 30 Nov 2026", or "-". */
export function deliveryWindowText(request: Pick<ShipmentRequest, "deliveryFrom" | "deliveryUntil">): string {
  const { deliveryFrom: from, deliveryUntil: until } = request;
  if (from && until) return `${formatDate(from)} sampai ${formatDate(until)}`;
  if (from) return `Mulai ${formatDate(from)}`;
  if (until) return `Sampai ${formatDate(until)}`;
  return "-";
}

/** POST and DELETE /api/shipment-requests/:id/files: staff with CREATE, while the request is DRAFT or SENT. */
export function canChangeRequestFiles(user: MaybeUser, request: Pick<ShipmentRequest, "status">): boolean {
  return isStaff(user) && canCreate(user, "shipment_requests") && is(request, "DRAFT", "SENT");
}

/** A sent request keeps at least one file: its last file is not offered for removal (the API answers FILE_REQUIRED). */
export function canRemoveRequestFile(request: Pick<ShipmentRequest, "status">, fileCount: number): boolean {
  return !(is(request, "SENT") && fileCount <= 1);
}

/** Why the request cannot be sent yet, in the words the page shows; null when it can. */
export function sendBlocker(request: Pick<ShipmentRequest, "status" | "fileCount">): string | null {
  if (!is(request, "DRAFT")) return "Hanya permintaan berstatus draf yang bisa dikirim.";
  if (request.fileCount < 1) return "Lampirkan dokumen kontrak sebelum permintaan dikirim.";
  return null;
}

/** What a staff account with EDIT may do with the request now. */
export function requestActions(request: Pick<ShipmentRequest, "status">): { edit: boolean; send: boolean; close: boolean; cancel: boolean } {
  return {
    edit: is(request, "DRAFT", "SENT"),
    send: is(request, "DRAFT"),
    close: is(request, "SENT"),
    cancel: is(request, "DRAFT", "SENT"),
  };
}

/** The query parameter of /registrasi/baru?arah=in that picks the contract of a request. */
export const CONTRACT_PARAM = "kontrak";

/** The incoming registration form with the request's contract chosen, for a supplier account; null otherwise. */
export function registerHref(user: MaybeUser, request: Pick<ShipmentRequest, "status" | "contract">): string | null {
  if (!canTypeIncoming(user) || !is(request, "SENT")) return null;
  return `/registrasi/baru?${new URLSearchParams({ arah: "in", [CONTRACT_PARAM]: String(request.contract.id) })}`;
}

/**
 * The quantity of a contract and what its requests already plan, for the request form: "Kontrak 10.000.000 kg ·
 * sudah diminta 3.000.000 kg · sisa 7.000.000 kg". `except` is the quantity of the request being changed, which the
 * sum already holds. Without a contract quantity only the requested part is told.
 */
export function contractRequestText(qtyContract: number | null, qtyRequested: number | null | undefined, uom: string | null, except = 0): string {
  const asked = Math.max((qtyRequested ?? 0) - except, 0);
  const parts = [`sudah diminta ${formatQuantity(asked, uom)}`];
  if (qtyContract !== null) {
    parts.unshift(`Kontrak ${formatQuantity(qtyContract, uom)}`);
    parts.push(`sisa ${formatQuantity(Math.max(Math.round((qtyContract - asked) * 1000) / 1000, 0), uom)}`);
  }
  return parts.join(" · ");
}

// --- the form ------------------------------------------------------------------------------------------------------

export interface ShipmentRequestValues {
  contractId: string;
  /** The mill (PKS) the request goes to. */
  supplierId: string;
  qtyPlanned: string;
  deliveryFrom: string;
  deliveryUntil: string;
  remark: string;
}

export const EMPTY_SHIPMENT_REQUEST: ShipmentRequestValues = { contractId: "", supplierId: "", qtyPlanned: "", deliveryFrom: "", deliveryUntil: "", remark: "" };

/** "create": a new draft. "draft": a draft changed, every field. "sent": a sent request, only what may still change. */
export type ShipmentRequestMode = "create" | "draft" | "sent";

export function shipmentRequestValues(request: ShipmentRequest): ShipmentRequestValues {
  return {
    contractId: String(request.contract.id),
    supplierId: String(request.supplier.id),
    qtyPlanned: request.qtyPlanned === null ? "" : String(request.qtyPlanned),
    deliveryFrom: request.deliveryFrom ?? "",
    deliveryUntil: request.deliveryUntil ?? "",
    remark: request.remark ?? "",
  };
}

export function validateShipmentRequest(values: ShipmentRequestValues, mode: ShipmentRequestMode): FormErrors {
  const errors: FormErrors = {};
  if (mode !== "sent" && !values.contractId) errors.contractId = "Pilih kontrak beli.";
  if (mode !== "sent" && !values.supplierId) errors.supplierId = "Pilih PKS yang mengirim.";
  if (values.qtyPlanned.trim()) {
    const qty = decimalNumber(values.qtyPlanned);
    if (qty === null || qty <= 0) errors.qtyPlanned = "Isi quantity lebih dari nol, tanpa titik ribuan.";
  }
  if (values.deliveryFrom && values.deliveryUntil && values.deliveryUntil < values.deliveryFrom) {
    errors.deliveryUntil = "Tanggal akhir kirim tidak boleh sebelum tanggal mulai.";
  }
  if (values.remark.trim().length > 1000) errors.remark = "Keterangan paling banyak 1000 huruf.";
  return errors;
}

/** The body of POST /api/shipment-requests or PATCH /api/shipment-requests/:id. */
export function shipmentRequestPayload(values: ShipmentRequestValues, mode: ShipmentRequestMode): Record<string, unknown> {
  const qtyPlanned = values.qtyPlanned.trim() ? decimalNumber(values.qtyPlanned) : null;
  const remark = values.remark.trim() || null;
  const deliveryUntil = values.deliveryUntil || null;
  if (mode === "sent") return { qtyPlanned, deliveryUntil, remark };
  const all: Record<string, unknown> = {
    contractId: values.contractId,
    supplierId: values.supplierId,
    qtyPlanned,
    deliveryFrom: values.deliveryFrom || null,
    deliveryUntil,
    remark,
  };
  if (mode === "draft") return all;
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== null));
}
