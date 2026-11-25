import { describe, expect, it } from "vitest";

import {
  canChangeRequestFiles,
  canRemoveRequestFile,
  deliveryWindowText,
  registerHref,
  requestActions,
  sendBlocker,
  shipmentRequestPayload,
  shipmentRequestStatusInfo,
  shipmentRequestValues,
  statusFilters,
  validateShipmentRequest,
} from "@/lib/shipment-requests";
import type { Permissions, ShipmentRequest, User } from "@/lib/types";

const staff = (permissions: Permissions): User => ({ id: "u-1", kind: "INTERNAL", username: "staf", fullName: "Staf Contoh", permissions, partner: null });
const partner = (permissions: Permissions, kinds: { isSupplier?: boolean } = {}): User => ({
  id: "u-2",
  kind: "PARTNER",
  username: "pks",
  fullName: "PKS Contoh",
  permissions,
  partner: { id: "p-1", name: "PKS Contoh", isSupplier: kinds.isSupplier ?? true, isTransporter: false, isCustomer: false },
});

function request(extra: Partial<ShipmentRequest> = {}): ShipmentRequest {
  return {
    id: 7,
    status: "DRAFT",
    contract: { id: 31, contractNo: "PC-CONTOH-01", state: "OPEN", qtyContract: 300000, uom: "kg", tolerancePct: 0.3, validFrom: "2026-11-01", validUntil: null },
    product: { id: 1, name: "CPO", category: "CPO" },
    partner: { id: "p-1", name: "PKS Contoh" },
    qtyPlanned: 120000,
    uom: "kg",
    deliveryFrom: "2026-11-21",
    deliveryUntil: "2026-11-30",
    remark: "Kirim bertahap",
    fileCount: 0,
    createdBy: { id: 1, fullName: "Staf Contoh" },
    createdAt: "2026-11-20T02:00:00.000Z",
    sentBy: null,
    sentAt: null,
    closedBy: null,
    closedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    updatedAt: "2026-11-20T02:00:00.000Z",
    ...extra,
  };
}

describe("shipment request labels", () => {
  it("names every status and shows an unknown one as received", () => {
    expect(["DRAFT", "SENT", "CLOSED", "CANCELLED"].map((status) => shipmentRequestStatusInfo(status).label)).toEqual(["Draf", "Terkirim", "Ditutup", "Batal"]);
    expect(shipmentRequestStatusInfo("ARCHIVED")).toEqual({ label: "ARCHIVED", tone: "neutral" });
  });

  it("offers a supplier only the statuses it can see", () => {
    expect(statusFilters(true).map((option) => option.value)).toEqual(["DRAFT", "SENT", "CLOSED", "CANCELLED"]);
    expect(statusFilters(false).map((option) => option.value)).toEqual(["SENT", "CLOSED"]);
  });

  it("writes the delivery window with what is known", () => {
    expect(deliveryWindowText(request())).toBe("21 Nov 2026 sampai 30 Nov 2026");
    expect(deliveryWindowText(request({ deliveryUntil: null }))).toBe("Mulai 21 Nov 2026");
    expect(deliveryWindowText(request({ deliveryFrom: null }))).toBe("Sampai 30 Nov 2026");
    expect(deliveryWindowText(request({ deliveryFrom: null, deliveryUntil: null }))).toBe("-");
  });
});

describe("what a request offers", () => {
  it("follows the status for edit, send, close and cancel", () => {
    expect(requestActions(request())).toEqual({ edit: true, send: true, close: false, cancel: true });
    expect(requestActions(request({ status: "SENT" }))).toEqual({ edit: true, send: false, close: true, cancel: true });
    expect(requestActions(request({ status: "CLOSED" }))).toEqual({ edit: false, send: false, close: false, cancel: false });
    expect(requestActions(request({ status: "CANCELLED" }))).toEqual({ edit: false, send: false, close: false, cancel: false });
  });

  it("asks for the contract PDF before sending", () => {
    expect(sendBlocker(request())).toBe("Lampirkan dokumen kontrak sebelum permintaan dikirim.");
    expect(sendBlocker(request({ fileCount: 1 }))).toBeNull();
    expect(sendBlocker(request({ status: "SENT", fileCount: 1 }))).toBe("Hanya permintaan berstatus draf yang bisa dikirim.");
  });

  it("lets staff with CREATE change the files of a draft or sent request, and keeps the last file of a sent one", () => {
    expect(canChangeRequestFiles(staff({ shipment_requests: "CREATE" }), request())).toBe(true);
    expect(canChangeRequestFiles(staff({ shipment_requests: "VIEW" }), request())).toBe(false);
    expect(canChangeRequestFiles(partner({ shipment_requests: "EDIT" }), request({ status: "SENT" }))).toBe(false);
    expect(canChangeRequestFiles(staff({ shipment_requests: "EDIT" }), request({ status: "CLOSED" }))).toBe(false);
    expect(canRemoveRequestFile(request({ status: "SENT" }), 1)).toBe(false);
    expect(canRemoveRequestFile(request({ status: "SENT" }), 2)).toBe(true);
    expect(canRemoveRequestFile(request(), 1)).toBe(true);
  });

  it("leads a supplier from a sent request into the incoming form with the contract chosen", () => {
    const supplier = partner({ registrations: "CREATE", shipment_requests: "VIEW" });
    expect(registerHref(supplier, request({ status: "SENT" }))).toBe("/registrasi/baru?arah=in&kontrak=31");
    expect(registerHref(supplier, request({ status: "CLOSED" }))).toBeNull();
    expect(registerHref(partner({ shipment_requests: "VIEW" }), request({ status: "SENT" }))).toBeNull();
    // staff register at the post, not through this form
    expect(registerHref(staff({ registrations: "EDIT" }), request({ status: "SENT" }))).toBeNull();
  });
});

describe("the request form", () => {
  it("needs a contract, a positive quantity, and an end date not before the start", () => {
    const empty = { contractId: "", qtyPlanned: "", deliveryFrom: "", deliveryUntil: "", remark: "" };
    expect(validateShipmentRequest(empty, "create")).toEqual({ contractId: "Pilih kontrak beli." });
    expect(validateShipmentRequest({ ...empty, contractId: "31", qtyPlanned: "0" }, "create").qtyPlanned).toBe("Isi quantity lebih dari nol, tanpa titik ribuan.");
    expect(validateShipmentRequest({ ...empty, contractId: "31", qtyPlanned: "120000" }, "create")).toEqual({});
    expect(validateShipmentRequest({ ...empty, contractId: "31", deliveryFrom: "2026-11-30", deliveryUntil: "2026-11-21" }, "draft").deliveryUntil).toBe(
      "Tanggal akhir kirim tidak boleh sebelum tanggal mulai.",
    );
    // a sent request keeps its contract
    expect(validateShipmentRequest(empty, "sent")).toEqual({});
  });

  it("sends only filled fields on create, every field of a draft, and the three late fields of a sent request", () => {
    const values = shipmentRequestValues(request());
    expect(values).toEqual({ contractId: "31", qtyPlanned: "120000", deliveryFrom: "2026-11-21", deliveryUntil: "2026-11-30", remark: "Kirim bertahap" });
    expect(shipmentRequestPayload({ ...values, qtyPlanned: "", remark: " " }, "create")).toEqual({ contractId: "31", deliveryFrom: "2026-11-21", deliveryUntil: "2026-11-30" });
    expect(shipmentRequestPayload({ ...values, qtyPlanned: "1500,5", remark: "" }, "draft")).toEqual({
      contractId: "31",
      qtyPlanned: 1500.5,
      deliveryFrom: "2026-11-21",
      deliveryUntil: "2026-11-30",
      remark: null,
    });
    expect(shipmentRequestPayload({ ...values, deliveryUntil: "" }, "sent")).toEqual({ qtyPlanned: 120000, deliveryUntil: null, remark: "Kirim bertahap" });
  });
});
