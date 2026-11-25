import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-client";
import type { DeliveryOrder, LookupDriver, LookupVehicle, QualityParameter, VehicleType } from "@/lib/types";
import {
  basisAfterFailure,
  basisOf,
  emergencyText,
  foundText,
  incomingStart,
  isEmergency,
  isEmergencyRefusal,
  matchStatusInfo,
  missingDone,
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
  walkInRegistration,
  walkInRequest,
  type IncomingProposal,
  type IncomingWalkIn,
  type OutgoingProposal,
  type OutgoingWalkIn,
  type ProposalContract,
} from "@/lib/walk-in";
import { emptyLetter, emptyTruck, type TruckValues } from "@/lib/workflow-forms";

const TYPES: VehicleType[] = [{ code: "TANGKI", name: "Truk tangki", isTank: true, needsContainerNo: false }];
const PARAMS: QualityParameter[] = [{ code: "FFA", name: "FFA", unit: "%", decimals: 2, minValid: 0, maxValid: 20 }];
const CONTEXT = { types: TYPES, parameters: PARAMS, currentYear: 2026 };

const CONTRACT: ProposalContract = {
  id: 11,
  contractNo: "0001/UJI/CPO/XI/2026",
  partner: { id: 3, name: "PKS Uji" },
  product: { id: 5, name: "CPO", category: "CPO" },
  qtyContract: null,
  uom: "kg",
  validUntil: null,
  supplierMatches: true,
};

const none = <T,>(read: T) => ({ status: "NONE" as const, read, value: null, candidates: [], note: null });

function incoming(overrides: Partial<IncomingProposal> = {}): IncomingProposal {
  return {
    direction: "IN",
    scan: { fileId: 41, originalName: "scan.jpg", mimeType: "image/jpeg", sizeBytes: 1200 },
    unreadable: false,
    read: { fieldsFound: 12, fieldsTotal: 12, warnings: [], fields: [], extraLines: [] },
    matches: {
      supplier: { status: "EXACT", read: "PKS UJI", value: { id: 3, name: "PKS Uji" }, candidates: [], note: null },
      transporter: none("ANGKUT UJI"),
      contracts: [{ status: "EXACT", read: CONTRACT.contractNo, value: CONTRACT, candidates: [], note: null }],
      vehicle: { ...none("ZZ 9001 UJI"), isNew: true },
      driver: { status: "CLOSE", read: { fullName: "SUPIR UJI", licenceNo: "UJI0001X" }, value: null, candidates: [], note: null, isNew: false },
    },
    letter: { spbNo: "SPB-UJI-1", spbDate: "2026-11-24", lines: [], quality: { FFA: 3.1 } },
    missing: [],
    registration: null,
    draft: {
      direction: "IN",
      submit: true,
      plannedDate: "2026-11-25",
      allocations: [{ contractId: 11 }],
      trips: [
        {
          vehicle: { plateDisplay: "ZZ 9001 UJI" },
          driver: { licenceNo: "UJI0001X", fullName: "SUPIR UJI" },
          plannedArrival: "2026-11-25",
          letters: [{ allocationSeq: 1, spbNo: "SPB-UJI-1", spbDate: "2026-11-24", originGrossKg: 30000, originTareKg: 10000, originNetKg: 20000, quality: { FFA: 3.1 } }],
        },
      ],
    },
    ...overrides,
  };
}

function order(overrides: Partial<DeliveryOrder> = {}): DeliveryOrder {
  return {
    id: 7,
    doNo: "001/DO/UJI/XI/2026",
    doDate: "2026-11-21",
    status: "ACCEPTED",
    contract: null,
    customerPoNo: null,
    partner: { id: 2, name: "Customer Uji" },
    product: { id: 6, name: "Olein", category: "OUTGOING_LIQUID" },
    qty: 40000,
    uom: "Kg",
    tolerancePct: 0.2,
    destination: { id: null, name: "Gudang Uji", address: null, district: null, regency: null, province: null },
    deliveryFrom: "2026-11-20",
    deliveryUntil: null,
    transportTerms: null,
    transporter: { id: 4, name: "Angkut Uji" },
    truckCount: null,
    truckCountBy: null,
    qtyPlanned: 0,
    qtyRemaining: 40000,
    tripCount: 0,
    remark: null,
    sentAt: null,
    acceptedAt: null,
    ...overrides,
  } as DeliveryOrder;
}

function outgoing(overrides: Partial<OutgoingProposal> = {}): OutgoingProposal {
  return {
    direction: "OUT",
    scan: { fileId: 42, originalName: "do.jpg", mimeType: "image/jpeg", sizeBytes: 900 },
    unreadable: false,
    read: { fieldsFound: 9, fieldsTotal: 9, warnings: [], fields: [], extraLines: [] },
    matches: { deliveryOrder: { status: "EXACT", read: "001/DO/UJI/XI/2026", value: order(), candidates: [], note: null } },
    missing: [
      { field: "allocations.0.qtyPlanned", message: "Isi quantity yang dimuat truk ini." },
      { field: "trips.0.vehicle", message: "Pilih kendaraan." },
      { field: "trips.0.driver", message: "Pilih supir." },
      { field: "closeCargo", message: "Jawab close cargo." },
      { field: "flexiBag", message: "Jawab flexi bag." },
    ],
    registration: null,
    draft: { direction: "OUT", submit: true, plannedDate: "2026-11-25", allocations: [{ deliveryOrderId: 7 }], trips: [{ vehicle: {}, driver: {}, plannedArrival: "2026-11-25" }] },
    ...overrides,
  };
}

const foundVehicle: LookupVehicle = {
  id: 21, plateNo: "ZZ9002UJI", plateDisplay: "ZZ 9002 UJI", vehicleTypeCode: "TANGKI", needsContainerNo: false,
  capacityKg: null, tareKg: null, expired: [], verified: true, owner: null, isActive: true,
} as LookupVehicle;
const foundDriver: LookupDriver = {
  id: 31, fullName: "Supir Uji Dua", licenceNo: "UJI0002", licenceClass: "B2 UMUM", licenceValidUntil: "2028-01-31",
  licenceExpired: false, registryStatus: "NORMAL", blocked: false, isActive: true,
} as LookupDriver;

function knownTruck(): TruckValues {
  return {
    ...emptyTruck("truck"),
    plate: "ZZ 9002 UJI",
    vehicle: { state: "found", key: "ZZ9002UJI", item: foundVehicle },
    licenceNo: "UJI0002",
    driver: { state: "found", key: "UJI0002", item: foundDriver },
  };
}

function filledOutgoing(overrides: Partial<OutgoingWalkIn> = {}): OutgoingWalkIn {
  return { ...outgoingStart(outgoing()), qty: "12000", truck: knownTruck(), marks: { closeCargo: "yes", flexiBag: "no" }, ...overrides };
}

describe("the basis of a walk-in", () => {
  it("is the ordinary path only for a scan the service read", () => {
    expect(basisOf(incoming())).toEqual({ kind: "READ", scanFileId: 41 });
    expect(basisOf(incoming({ unreadable: true }))).toEqual({ kind: "UNREADABLE", scanFileId: 41 });
    expect(isEmergency({ kind: "READ", scanFileId: 1 })).toBe(false);
    for (const kind of ["UNREADABLE", "NOT_READ"] as const) expect(isEmergency({ kind, scanFileId: 1 })).toBe(true);
    expect(isEmergency({ kind: "NO_SCAN" })).toBe(true);
  });

  it("keeps the stored scan after a failed reading, and has none when nothing was stored", () => {
    expect(basisAfterFailure({ kind: "NOT_READ", scanFileId: 41, message: "x" })).toEqual({ kind: "NOT_READ", scanFileId: 41 });
    expect(basisAfterFailure({ kind: "NOT_READ", scanFileId: null, message: "x" })).toEqual({ kind: "NO_SCAN" });
    expect(basisAfterFailure({ kind: "NOT_CONFIGURED", message: "x" })).toEqual({ kind: "NO_SCAN" });
  });

  it("tells the operator what to do, with or without emergency access", () => {
    expect(emergencyText({ kind: "READ", scanFileId: 1 }, false)).toBe("");
    expect(emergencyText({ kind: "NOT_READ", scanFileId: 1 }, false)).toBe(
      "Dokumen ini belum terbaca oleh layanan baca dokumen. Scannya sudah disimpan. Pindai lagi, atau panggil petugas dengan akses registrasi darurat.",
    );
    expect(emergencyText({ kind: "UNREADABLE", scanFileId: 1 }, true)).toBe(
      "Dokumen ini tidak terbaca dengan baik. Isi datanya dengan tangan dan tulis alasannya; registrasi ini dicatat sebagai registrasi darurat.",
    );
    expect(emergencyText({ kind: "NO_SCAN" }, false)).toBe("Registrasi ini tanpa scan dokumen. Registrasi tanpa scan hanya untuk petugas dengan akses registrasi darurat.");
  });

  it("checks the reason as the API does: 3 to 300 characters", () => {
    expect(reasonError("  ")).toBe("Tulis alasan registrasi darurat.");
    expect(reasonError("ab")).toBe("Alasan terlalu pendek, paling sedikit 3 huruf.");
    expect(reasonError("x".repeat(301))).toBe("Alasan terlalu panjang, paling banyak 300 huruf.");
    expect(reasonError(" Scanner rusak ")).toBeNull();
  });
});

describe("a failed reading", () => {
  it("keeps the id of the stored scan for every refusal of the reading service", () => {
    for (const [status, code] of [[502, "OCR_UNAVAILABLE"], [502, "OCR_FAILED"], [504, "OCR_TIMEOUT"]] as const) {
      const failure = scanFailureOf(new ApiError(status, code, "API text", [], {}, { scanFileId: 41 }));
      expect(failure, code).toMatchObject({ kind: "NOT_READ", scanFileId: 41 });
    }
    expect(scanFailureOf(new ApiError(502, "OCR_UNAVAILABLE", "x"))).toMatchObject({ kind: "NOT_READ", scanFileId: null });
  });

  it("tells a server without a reading service, a refused file and other errors apart", () => {
    expect(scanFailureOf(new ApiError(503, "NOT_CONFIGURED", "x")).kind).toBe("NOT_CONFIGURED");
    expect(scanFailureOf(new ApiError(413, "FILE_TOO_LARGE", "x"))).toEqual({ kind: "BAD_FILE", message: "Scan paling besar 15 MB. Pindai lagi dengan resolusi lebih rendah." });
    expect(scanFailureOf(new ApiError(400, "VALIDATION", "x", ["file"], { file: "Scan harus gambar JPG atau PNG." }))).toEqual({ kind: "BAD_FILE", message: "Scan harus gambar JPG atau PNG." });
    expect(scanFailureOf(new ApiError(403, "FORBIDDEN", "x"))).toEqual({ kind: "OTHER", message: "Akun ini tidak punya izin memindai dokumen di pos." });
  });

  it("refuses a file the route would refuse before sending it", () => {
    expect(scanFileError({ type: "application/pdf", size: 10 })).toBe("Pilih gambar JPG atau PNG.");
    expect(scanFileError({ type: "image/png", size: 15 * 1024 * 1024 + 1 })).toBe("Scan paling besar 15 MB.");
    expect(scanFileError({ type: "image/jpeg", size: 0 })).toBe("Berkas ini kosong.");
    expect(scanFileError({ type: "image/jpeg", size: 2048 })).toBeNull();
  });
});

describe("the form a proposal starts", () => {
  it("fills the contract, the letter, the plate and the driver as read", () => {
    const form = incomingStart(incoming(), PARAMS);
    expect(form.rows).toHaveLength(1);
    expect(form.rows[0]).toMatchObject({ source: 0, contract: { id: 11, contractNo: CONTRACT.contractNo, state: "OPEN" } });
    expect(form.rows[0]?.letter).toMatchObject({ spbNo: "SPB-UJI-1", spbDate: "2026-11-24", originGrossKg: "30000", originTareKg: "10000", originNetKg: "20000", quality: { FFA: "3.1" } });
    // the driver was not found: the licence and the name as read, for a new driver
    expect([form.truck.plate, form.truck.licenceNo, form.truck.fullName]).toEqual(["ZZ 9001 UJI", "UJI0001X", "SUPIR UJI"]);
    expect(form.transporter).toBeNull();
  });

  it("leaves a contract the operator must choose open, and starts empty without a proposal", () => {
    const close = incoming({ matches: { ...incoming().matches, contracts: [{ status: "CLOSE", read: "0001/UJI/CPO/IX/2026", value: null, candidates: [], note: null }] } });
    expect(incomingStart(close, PARAMS).rows[0]?.contract).toBeNull();
    expect(incomingStart(null, PARAMS)).toMatchObject({ rows: [], transporter: null, truck: { plate: "", licenceNo: "" } });
    expect(outgoingStart(outgoing()).order).toMatchObject({ id: 7 });
    expect(outgoingStart(null)).toMatchObject({ order: null, qty: "", marks: { closeCargo: "", flexiBag: "" } });
  });
});

describe("the list of what is still open", () => {
  it("ticks off each item once the form settles it", () => {
    const open = outgoingStart(outgoing());
    expect(todoList(outgoing().missing, open).map((item) => item.done)).toEqual([false, false, false, false, false]);
    expect(todoList(outgoing().missing, filledOutgoing()).map((item) => item.done)).toEqual([true, true, true, true, true]);
  });

  it("leaves out the note on the whole document, and keeps unknown paths open", () => {
    const missing = [{ field: "document", message: "Dokumen tidak terbaca." }, { field: "something.else", message: "?" }];
    expect(todoList(missing, filledOutgoing())).toEqual([{ field: "something.else", message: "?", done: false }]);
  });

  it("settles a contract row by its place in the letter, and a new driver only with class and validity", () => {
    const form: IncomingWalkIn = { ...incomingStart(incoming(), PARAMS), rows: [{ key: "a", source: 0, contract: null, letter: emptyLetter(PARAMS) }] };
    expect(missingDone(form, "allocations.0.contractId")).toBe(false);
    // a row the operator removed has nothing left to choose
    expect(missingDone({ ...form, rows: [] }, "allocations.0.contractId")).toBe(true);
    const newDriver = { ...form.truck, driver: { state: "missing" as const, key: "UJI0001X" }, fullName: "Supir Uji", licenceClass: "", licenceValidUntil: "2028-01-31" };
    expect(missingDone({ ...form, truck: newDriver }, "trips.0.driver.licenceClass")).toBe(false);
    expect(missingDone({ ...form, truck: { ...newDriver, licenceClass: "B2 UMUM" } }, "trips.0.driver.licenceClass")).toBe(true);
    expect(missingDone(form, "transporterId")).toBe(false);
    expect(missingDone({ ...form, transporterSkipped: true }, "transporterId")).toBe(true);
  });
});

describe("validateWalkIn", () => {
  it("asks an outgoing truck for its order, quantity and both marks", () => {
    expect(validateWalkIn(filledOutgoing(), CONTEXT)).toEqual({});
    const errors = validateWalkIn(filledOutgoing({ order: null, qty: "", marks: { closeCargo: "", flexiBag: "yes" } }), CONTEXT);
    expect(errors).toEqual({ order: "Pilih DO.", qty: "Isi quantity yang dimuat truk ini, dalam kg.", closeCargo: "Pilih ya atau tidak." });
  });

  it("names the truck fields under truck.", () => {
    const errors = validateWalkIn(filledOutgoing({ truck: emptyTruck("truck") }), CONTEXT);
    expect(Object.keys(errors).filter((key) => key.startsWith("truck."))).toEqual(expect.arrayContaining(["truck.plate", "truck.licenceNo"]));
  });

  it("asks every row of an incoming letter for its contract", () => {
    const form: IncomingWalkIn = { ...incomingStart(incoming(), PARAMS), truck: knownTruck() };
    expect(validateWalkIn(form, CONTEXT)).toEqual({});
    const open: IncomingWalkIn = { ...form, rows: [...form.rows, { key: "b", source: 1, contract: null, letter: emptyLetter(PARAMS) }] };
    expect(validateWalkIn(open, CONTEXT)["rows.1.contract"]).toBe("Pilih kontraknya.");
    expect(validateWalkIn({ ...form, rows: [] }, CONTEXT).contracts).toBe("Pilih paling sedikit satu kontrak.");
  });
});

describe("the request of a walk-in", () => {
  it("sends one outgoing truck with its quantity and the marks of the post", () => {
    expect(walkInRegistration(filledOutgoing())).toEqual({
      direction: "OUT",
      transporterId: 4,
      submit: true,
      allocations: [{ deliveryOrderId: 7, qtyPlanned: 12000 }],
      trips: [{ vehicle: { id: 21 }, driver: { id: 31 } }],
      closeCargo: true,
      flexiBag: false,
    });
  });

  it("sends an incoming truck with the letter of each chosen contract", () => {
    const body = walkInRegistration({ ...incomingStart(incoming(), PARAMS), truck: knownTruck() });
    expect(body).toMatchObject({ direction: "IN", submit: true, allocations: [{ contractId: 11 }] });
    expect((body.trips as Array<{ letters: unknown[] }>)[0]?.letters).toEqual([
      expect.objectContaining({ allocationSeq: 1, spbNo: "SPB-UJI-1", originNetKg: 20000, quality: { FFA: 3.1 } }),
    ]);
  });

  it("carries the scan whenever one was kept, and the reason only on the emergency path", () => {
    const form = filledOutgoing();
    expect(walkInRequest({ kind: "READ", scanFileId: 42 }, form, "AB000001", "ignored")).toMatchObject({ scanFileId: 42, cardUid: "AB000001" });
    expect("emergencyReason" in walkInRequest({ kind: "READ", scanFileId: 42 }, form, "AB000001", "ignored")).toBe(false);
    expect(walkInRequest({ kind: "NOT_READ", scanFileId: 43 }, form, "AB000001", " Layanan mati ")).toMatchObject({ scanFileId: 43, emergencyReason: "Layanan mati" });
    const typed = walkInRequest({ kind: "NO_SCAN" }, form, "AB000001", "Scanner rusak");
    expect("scanFileId" in typed).toBe(false);
    expect(typed.emergencyReason).toBe("Scanner rusak");
  });
});

describe("refusals of the walk-in route", () => {
  it("puts the field messages on the form, the card and the reason", () => {
    const placed = walkInFieldErrors("OUT", {
      cardUid: "UID kartu harus 8 sampai 20 digit heksadesimal.",
      emergencyReason: "Alasan registrasi darurat wajib diisi, 3 sampai 300 huruf.",
      "registration.closeCargo": "Tandai close cargo: ya atau tidak.",
      "registration.allocations.0.qtyPlanned": "Isi quantity yang dimuat truk ini.",
      "registration.trips.0.driver.id": "Supir tidak ditemukan.",
      "registration.trips": "Registrasi di pos berisi tepat satu truk.",
      scanFileId: "Scan ini dipindai untuk arah yang lain.",
    });
    expect(placed.card).toBe("UID kartu harus 8 sampai 20 digit heksadesimal.");
    expect(placed.errors).toEqual({
      reason: "Alasan registrasi darurat wajib diisi, 3 sampai 300 huruf.",
      closeCargo: "Tandai close cargo: ya atau tidak.",
      qty: "Isi quantity yang dimuat truk ini.",
      "truck.licenceNo": "Supir tidak ditemukan.",
    });
    expect(placed.unplaced).toEqual(["Scan ini dipindai untuk arah yang lain.", "Registrasi di pos berisi tepat satu truk."]);
    expect(walkInFieldErrors("IN", { "registration.trips.0.letters.0.originNetKg": "Netto asal harus sama." }).errors).toEqual({ "letters.0.originNetKg": "Netto asal harus sama." });
  });

  it("uses the API's own sentence when emergency access is missing", () => {
    const refusal = new ApiError(403, "EMERGENCY_ACCESS_REQUIRED", "Dokumen ini tidak terbaca. Pindai lagi, atau minta petugas dengan akses registrasi darurat.");
    expect(walkInErrorMessage(refusal)).toBe("Dokumen ini tidak terbaca. Pindai lagi, atau minta petugas dengan akses registrasi darurat.");
    expect(isEmergencyRefusal(refusal)).toBe(true);
    expect(isEmergencyRefusal(new ApiError(403, "FORBIDDEN", "x"))).toBe(false);
    expect(walkInErrorMessage(new ApiError(409, "SCAN_ALREADY_USED", "x"))).toBe("Scan ini sudah dipakai untuk registrasi lain. Pindai dokumennya lagi.");
    expect(walkInErrorMessage(new ApiError(400, "VALIDATION", "x"), ["Registrasi di pos berisi tepat satu truk."])).toBe("Server menolak isian ini: Registrasi di pos berisi tepat satu truk.");
  });
});

describe("helpers of the screen", () => {
  it("labels a match, counts what was found, and says when a value was not read", () => {
    expect([matchStatusInfo("EXACT").label, matchStatusInfo("CLOSE").tone, matchStatusInfo("NONE").tone]).toEqual(["Cocok", "warning", "destructive"]);
    expect(foundText({ fieldsFound: 11, fieldsTotal: 12 })).toBe("11 dari 12 isian ditemukan");
    expect(foundText({ fieldsFound: null, fieldsTotal: 12 })).toBeNull();
    expect(readValueText({ key: "ullage", label: "Ullage", value: null, needsCheck: true, reason: null })).toBe("tidak terbaca");
    expect(readValueText({ key: "brutto_kg", label: "Bruto", value: 30000, needsCheck: false, reason: null })).toBe("30000");
  });

  it("notices a plate that differs from the one read", () => {
    const form = filledOutgoing();
    expect(plateIsRead(form, "zz 9002 uji")).toBe(true);
    expect(plateIsRead(form, "ZZ 9003 UJI")).toBe(false);
    expect(plateIsRead(form, null)).toBe(false);
  });
});
