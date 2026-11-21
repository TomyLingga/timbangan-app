import { describe, expect, it } from "vitest";

import type { Contract, DeliveryOrder, LookupDriver, LookupVehicle, QualityParameter, Registration, Trip, VehicleType } from "@/lib/types";
import {
  cardPayload,
  decimalNumber,
  deliveryOrderPayload,
  destinationGaps,
  destinationLine,
  EMPTY_DELIVERY_ORDER,
  emptyLetter,
  emptyTruck,
  incomingFromDraft,
  incomingPayload,
  letterPayload,
  outgoingFromDraft,
  outgoingPayload,
  registrationFieldErrors,
  validateCard,
  validateDeliveryOrder,
  validateIncoming,
  validateLetter,
  validateOutgoing,
  validateTruck,
  type IncomingValues,
  type OutgoingValues,
  type TruckValues,
} from "@/lib/workflow-forms";

const TYPES: VehicleType[] = [
  { code: "TANGKI", name: "Truk tangki", isTank: true, needsContainerNo: false },
  { code: "KONTAINER", name: "Truk kontainer", isTank: false, needsContainerNo: true },
];

const PARAMS: QualityParameter[] = [
  { code: "FFA", name: "FFA", unit: "%", decimals: 2, minValid: 0, maxValid: 20 },
  { code: "MOISTURE", name: "Moisture", unit: "%", decimals: 3, minValid: 0, maxValid: 5 },
];

const CONTEXT = { types: TYPES, parameters: PARAMS, currentYear: 2026 };

function vehicle(overrides: Partial<LookupVehicle> = {}): LookupVehicle {
  return {
    id: "v-1",
    plateNo: "ZZ0001CTH",
    plateDisplay: "ZZ 0001 CTH",
    vehicleTypeCode: "TANGKI",
    needsContainerNo: false,
    capacityKg: 10000,
    tareKg: 5000,
    expired: [],
    verified: true,
    owner: null,
    isActive: true,
    ...overrides,
  };
}

function driver(overrides: Partial<LookupDriver> = {}): LookupDriver {
  return {
    id: "d-1",
    fullName: "Supir Contoh",
    licenceNo: "CONTOH0001",
    licenceClass: "B2 UMUM",
    licenceValidUntil: "2027-06-30",
    licenceExpired: false,
    registryStatus: "NORMAL",
    blocked: false,
    isActive: true,
    ...overrides,
  };
}

/** A truck whose plate and licence were both found in the master data. */
function knownTruck(overrides: Partial<TruckValues> = {}): TruckValues {
  return {
    ...emptyTruck("t1"),
    plate: "zz 0001 cth",
    vehicle: { state: "found", key: "ZZ0001CTH", item: vehicle() },
    licenceNo: "contoh0001",
    driver: { state: "found", key: "CONTOH0001", item: driver() },
    ...overrides,
  };
}

function contract(id: string, partnerId = "p-1"): Contract {
  return {
    id,
    contractNo: `K-${id}`,
    direction: "IN",
    partner: { id: partnerId, name: `Partner ${partnerId}` },
    product: { id: "g-1", name: "CPO", category: "CPO" },
    qtyContract: 1000000,
    uom: "Kg",
    tolerancePct: 0.25,
    certificate: null,
    validFrom: null,
    validUntil: null,
    customerPoNo: null,
    state: "OPEN",
    syncedAt: null,
  };
}

function order(id: string, overrides: Partial<DeliveryOrder> = {}): DeliveryOrder {
  return {
    id,
    doNo: `DO-${id}`,
    doDate: "2026-11-21",
    status: "ACCEPTED",
    contract: null,
    customerPoNo: null,
    partner: { id: "p-2", name: "Customer" },
    product: { id: "g-3", name: "Olein", category: "OUTGOING_LIQUID" },
    qty: 40000,
    uom: "Kg",
    tolerancePct: 0.2,
    destination: { id: "t-1", name: "Gudang", address: null, district: null, regency: null, province: null },
    deliveryFrom: "2026-11-20",
    deliveryUntil: null,
    transportTerms: null,
    transporter: { id: "p-3", name: "Transporter" },
    truckCount: 4,
    truckCountBy: null,
    qtyPlanned: 0,
    qtyRemaining: 40000,
    tripCount: 0,
    remark: null,
    sentAt: null,
    acceptedAt: null,
    ...overrides,
  };
}

describe("decimalNumber", () => {
  it("reads a dot or a comma as the decimal sign", () => {
    expect(decimalNumber("3,25")).toBe(3.25);
    expect(decimalNumber("3.25")).toBe(3.25);
    expect(decimalNumber("12")).toBe(12);
  });

  it("refuses grouping, signs and text", () => {
    expect(decimalNumber("1.000,5")).toBeNull();
    expect(decimalNumber("-1")).toBeNull();
    expect(decimalNumber("")).toBeNull();
  });
});

describe("validateTruck", () => {
  it("accepts a vehicle and a driver found in the master data", () => {
    expect(validateTruck(knownTruck(), CONTEXT)).toEqual({});
  });

  it("asks to look the plate and the licence up first", () => {
    const errors = validateTruck({ ...emptyTruck("t1"), plate: "ZZ 1 A", licenceNo: "X1" }, CONTEXT);
    expect(errors.plate).toBe("Tekan Periksa untuk mencari plat ini.");
    expect(errors.licenceNo).toBe("Tekan Periksa untuk mencari nomor SIM ini.");
  });

  it("treats a lookup of an older plate as not done", () => {
    const errors = validateTruck(knownTruck({ plate: "ZZ 0002 CTH" }), CONTEXT);
    expect(errors.plate).toBe("Tekan Periksa untuk mencari plat ini.");
  });

  it("asks for the empty plate and licence", () => {
    const errors = validateTruck(emptyTruck("t1"), CONTEXT);
    expect(errors.plate).toBe("Isi nomor plat.");
    expect(errors.licenceNo).toBe("Isi nomor SIM.");
  });

  it("needs the type of a new vehicle and the data of a new driver", () => {
    const errors = validateTruck(
      knownTruck({
        plate: "ZZ 9 UJI",
        vehicle: { state: "missing", key: "ZZ9UJI" },
        licenceNo: "UJI1",
        driver: { state: "missing", key: "UJI1" },
        capacityKg: "12.000",
      }),
      CONTEXT,
    );
    expect(errors.vehicleTypeCode).toBe("Pilih jenis kendaraan.");
    expect(errors.capacityKg).toBe("Isi angka bulat lebih dari nol, tanpa titik atau koma.");
    expect(errors.fullName).toBe("Isi nama supir.");
    expect(errors.licenceClass).toBe("Pilih jenis SIM.");
    expect(errors.licenceValidUntil).toBe("Isi tanggal berlaku SIM.");
  });

  it("refuses a blacklisted driver", () => {
    const errors = validateTruck(
      knownTruck({ driver: { state: "found", key: "CONTOH0001", item: driver({ registryStatus: "BLACKLIST" }) } }),
      CONTEXT,
    );
    expect(errors.licenceNo).toBe("Supir ini masuk daftar hitam VCF dan tidak bisa didaftarkan.");
  });

  it("refuses a driver blocked at the plant and an inactive driver or vehicle", () => {
    const blocked = knownTruck({ driver: { state: "found", key: "CONTOH0001", item: driver({ blocked: true }) } });
    expect(validateTruck(blocked, CONTEXT).licenceNo).toBe("Supir ini sedang diblokir di pabrik dan tidak bisa didaftarkan.");
    const inactiveDriver = knownTruck({ driver: { state: "found", key: "CONTOH0001", item: driver({ isActive: false }) } });
    expect(validateTruck(inactiveDriver, CONTEXT).licenceNo).toBe("Supir ini tidak aktif. Hubungi admin logistik.");
    const inactiveVehicle = knownTruck({ vehicle: { state: "found", key: "ZZ0001CTH", item: vehicle({ isActive: false }) } });
    expect(validateTruck(inactiveVehicle, CONTEXT).plate).toBe("Kendaraan ini tidak aktif. Hubungi admin logistik.");
  });

  it("lets a driver with a warning through", () => {
    const errors = validateTruck(
      knownTruck({ driver: { state: "found", key: "CONTOH0001", item: driver({ registryStatus: "WARNING" }) } }),
      CONTEXT,
    );
    expect(errors).toEqual({});
  });

  it("needs a container number when the vehicle type asks for one", () => {
    const found = knownTruck({
      vehicle: { state: "found", key: "ZZ0001CTH", item: vehicle({ vehicleTypeCode: "KONTAINER", needsContainerNo: true }) },
    });
    expect(validateTruck(found, CONTEXT).containerNo).toBe("Isi nomor kontainer.");
    expect(validateTruck({ ...found, containerNo: "ABCU1234567" }, CONTEXT)).toEqual({});
    const created = knownTruck({
      plate: "ZZ 9 UJI",
      vehicle: { state: "missing", key: "ZZ9UJI" },
      vehicleTypeCode: "KONTAINER",
    });
    expect(validateTruck(created, CONTEXT).containerNo).toBe("Isi nomor kontainer.");
  });
});

describe("validateLetter", () => {
  it("accepts an empty letter", () => {
    expect(validateLetter(emptyLetter(PARAMS), PARAMS)).toEqual({});
  });

  it("needs the net to equal gross minus tare when all three are filled", () => {
    const letter = { ...emptyLetter(PARAMS), originGrossKg: "30000", originTareKg: "10000", originNetKg: "19000" };
    expect(validateLetter(letter, PARAMS).originNetKg).toBe("Netto harus sama dengan bruto dikurangi tarra: 20.000 kg.");
    expect(validateLetter({ ...letter, originNetKg: "20000" }, PARAMS)).toEqual({});
  });

  it("takes whole kilograms only", () => {
    const letter = { ...emptyLetter(PARAMS), originGrossKg: "30.000" };
    expect(validateLetter(letter, PARAMS).originGrossKg).toBe("Isi angka bulat dalam kg, tanpa titik atau koma.");
  });

  it("keeps declared quality inside the plausible range of the parameter", () => {
    const letter = { ...emptyLetter(PARAMS), quality: { FFA: "3,5", MOISTURE: "7" } };
    const errors = validateLetter(letter, PARAMS);
    expect(errors["quality.FFA"]).toBeUndefined();
    expect(errors["quality.MOISTURE"]).toBe("Isi angka 0 sampai 5.");
    expect(validateLetter({ ...letter, quality: { FFA: "abc", MOISTURE: "" } }, PARAMS)["quality.FFA"]).toBe(
      "Isi angka 0 sampai 20.",
    );
  });
});

describe("letterPayload", () => {
  it("sends only what was filled, with numbers as numbers", () => {
    expect(
      letterPayload(
        {
          ...emptyLetter(PARAMS),
          spbNo: " SPB-1 ",
          spbDate: "2026-11-20",
          originNetKg: "20000",
          quality: { FFA: "3,5", MOISTURE: "" },
        },
        1,
      ),
    ).toEqual({ allocationSeq: 1, spbNo: "SPB-1", spbDate: "2026-11-20", originNetKg: 20000, quality: { FFA: 3.5 } });
  });
});

describe("validateIncoming and incomingPayload", () => {
  function values(overrides: Partial<IncomingValues> = {}): IncomingValues {
    return {
      contracts: [contract("c-1"), contract("c-2")],
      transporter: { id: "p-3", name: "Transporter" },
      plannedDate: "2026-11-21",
      truck: knownTruck(),
      letters: [emptyLetter(PARAMS), emptyLetter(PARAMS)],
      remark: "",
      ...overrides,
    };
  }

  it("needs at least one contract", () => {
    expect(validateIncoming(values({ contracts: [], letters: [] }), CONTEXT).contracts).toBe("Pilih paling sedikit satu kontrak.");
  });

  it("needs every contract to belong to the same partner", () => {
    const errors = validateIncoming(values({ contracts: [contract("c-1"), contract("c-9", "p-9")] }), CONTEXT);
    expect(errors.contracts).toBe("Semua kontrak dalam satu registrasi harus dari partner yang sama.");
  });

  it("prefixes the errors of the truck and of each letter", () => {
    const errors = validateIncoming(
      values({
        truck: { ...knownTruck(), licenceNo: "" },
        letters: [emptyLetter(PARAMS), { ...emptyLetter(PARAMS), originGrossKg: "x" }],
      }),
      CONTEXT,
    );
    expect(errors["truck.licenceNo"]).toBe("Isi nomor SIM.");
    expect(errors["letters.1.originGrossKg"]).toBe("Isi angka bulat dalam kg, tanpa titik atau koma.");
  });

  it("builds the request with one truck and a letter per contract", () => {
    const body = incomingPayload(
      values({ letters: [{ ...emptyLetter(PARAMS), spbNo: "S1" }, emptyLetter(PARAMS)], remark: " catatan " }),
      true,
    );
    expect(body).toEqual({
      direction: "IN",
      transporterId: "p-3",
      plannedDate: "2026-11-21",
      remark: "catatan",
      submit: true,
      allocations: [{ contractId: "c-1" }, { contractId: "c-2" }],
      trips: [
        {
          vehicle: { id: "v-1" },
          driver: { id: "d-1" },
          letters: [{ allocationSeq: 1, spbNo: "S1" }, { allocationSeq: 2 }],
        },
      ],
    });
  });

  it("creates the vehicle and the driver in place when they were not found", () => {
    const body = incomingPayload(
      values({
        transporter: null,
        truck: {
          ...emptyTruck("t1"),
          plate: " zz  9 uji ",
          vehicle: { state: "missing", key: "ZZ9UJI" },
          vehicleTypeCode: "KONTAINER",
          capacityKg: "12000",
          kirValidUntil: "2027-01-31",
          licenceNo: "uji1",
          driver: { state: "missing", key: "UJI1" },
          fullName: " Supir Uji ",
          licenceClass: "B2 UMUM",
          licenceValidUntil: "2028-06-30",
          containerNo: " abcu1234567 ",
        },
      }),
      false,
    );
    expect(body.submit).toBe(false);
    expect(body.transporterId).toBeUndefined();
    expect(body.trips[0]).toMatchObject({
      vehicle: { plateDisplay: "ZZ 9 UJI", vehicleTypeCode: "KONTAINER", capacityKg: 12000, kirValidUntil: "2027-01-31" },
      driver: { licenceNo: "UJI1", fullName: "Supir Uji", licenceClass: "B2 UMUM", licenceValidUntil: "2028-06-30" },
      containerNo: "ABCU1234567",
    });
  });
});

describe("validateOutgoing and outgoingPayload", () => {
  function values(overrides: Partial<OutgoingValues> = {}): OutgoingValues {
    return {
      orders: [{ order: order("do-1"), qty: "38002" }],
      trucks: [
        knownTruck({ key: "a" }),
        knownTruck({
          key: "b",
          plate: "ZZ 0002 CTH",
          vehicle: { state: "found", key: "ZZ0002CTH", item: vehicle({ id: "v-2", plateNo: "ZZ0002CTH" }) },
          licenceNo: "CONTOH0002",
          driver: { state: "found", key: "CONTOH0002", item: driver({ id: "d-2", licenceNo: "CONTOH0002" }) },
        }),
      ],
      closeCargo: "yes",
      flexiBag: "no",
      plannedDate: "2026-11-21",
      remark: "",
      ...overrides,
    };
  }

  it("accepts a complete registration", () => {
    expect(validateOutgoing(values(), CONTEXT, true)).toEqual({});
  });

  it("needs close cargo and flexi bag when sending, not for a draft", () => {
    const open = values({ closeCargo: "", flexiBag: "" });
    expect(validateOutgoing(open, CONTEXT, true)).toEqual({
      closeCargo: "Pilih ya atau tidak.",
      flexiBag: "Pilih ya atau tidak.",
    });
    expect(validateOutgoing(open, CONTEXT, false)).toEqual({});
  });

  it("needs a delivery order, a quantity per order and at least one truck", () => {
    expect(validateOutgoing(values({ orders: [] }), CONTEXT, false).orders).toBe("Pilih paling sedikit satu DO.");
    expect(validateOutgoing(values({ orders: [{ order: order("do-1"), qty: "0" }] }), CONTEXT, false)["orders.0.qty"]).toBe(
      "Isi quantity dalam kg, angka bulat lebih dari nol.",
    );
    expect(validateOutgoing(values({ trucks: [] }), CONTEXT, false).trucks).toBe("Tambahkan paling sedikit satu truk.");
  });

  it("refuses the same vehicle or driver on two trucks", () => {
    const errors = validateOutgoing(values({ trucks: [knownTruck({ key: "a" }), knownTruck({ key: "b" })] }), CONTEXT, false);
    expect(errors["trucks.1.plate"]).toBe("Kendaraan ini sudah dipakai truk lain di registrasi ini.");
    expect(errors["trucks.1.licenceNo"]).toBe("Supir ini sudah dipakai truk lain di registrasi ini.");
    expect(errors["trucks.0.plate"]).toBeUndefined();
  });

  it("builds the request with the quantity per order and the answers as booleans", () => {
    const body = outgoingPayload(values(), true);
    expect(body).toEqual({
      direction: "OUT",
      transporterId: "p-3",
      plannedDate: "2026-11-21",
      closeCargo: true,
      flexiBag: false,
      submit: true,
      allocations: [{ deliveryOrderId: "do-1", qtyPlanned: 38002 }],
      trips: [
        { vehicle: { id: "v-1" }, driver: { id: "d-1" } },
        { vehicle: { id: "v-2" }, driver: { id: "d-2" } },
      ],
    });
  });

  it("leaves unanswered questions out of a draft", () => {
    const body = outgoingPayload(values({ closeCargo: "", flexiBag: "" }), false);
    expect("closeCargo" in body).toBe(false);
    expect("flexiBag" in body).toBe(false);
  });
});

describe("validateDeliveryOrder and deliveryOrderPayload", () => {
  const filled = {
    ...EMPTY_DELIVERY_ORDER,
    doDate: "2026-11-21",
    contractId: "c-8",
    qty: "40000",
    uom: "Kg",
    destName: "Gudang Contoh",
    destRegency: "Kab. Contoh",
    deliveryFrom: "2026-11-21",
    transporterId: "p-3",
  };

  it("accepts a delivery order made from a contract", () => {
    expect(validateDeliveryOrder(filled)).toEqual({});
  });

  it("needs customer and product without a contract", () => {
    const errors = validateDeliveryOrder({ ...filled, contractId: "" });
    expect(errors.partnerId).toBe("Pilih customer, atau pilih kontrak.");
    expect(errors.productId).toBe("Pilih barang.");
  });

  it("checks the required fields, the quantity and the dates", () => {
    const errors = validateDeliveryOrder({
      ...EMPTY_DELIVERY_ORDER,
      contractId: "c-8",
      qty: "0",
      deliveryFrom: "2026-11-21",
      deliveryUntil: "2026-11-20",
      truckCount: "1,5",
      tolerancePct: "120",
    });
    expect(errors).toEqual({
      doDate: "Isi tanggal DO.",
      qty: "Isi quantity lebih dari nol.",
      destName: "Isi nama tujuan.",
      destRegency: "Isi kabupaten atau kota tujuan.",
      deliveryUntil: "Tanggal akhir tidak boleh sebelum tanggal mulai.",
      truckCount: "Isi jumlah truk dengan angka bulat lebih dari nol.",
      tolerancePct: "Isi persen dari 0 sampai 100.",
    });
  });

  it("sends a new delivery order without the empty fields", () => {
    expect(deliveryOrderPayload({ ...filled, doNo: " ", truckCount: "4", remark: " r " }, "create")).toEqual({
      doDate: "2026-11-21",
      contractId: "c-8",
      qty: 40000,
      uom: "Kg",
      destName: "Gudang Contoh",
      destRegency: "Kab. Contoh",
      deliveryFrom: "2026-11-21",
      transporterId: "p-3",
      truckCount: 4,
      remark: "r",
    });
  });

  it("sends only the fields that stay editable once the order has left draft", () => {
    expect(deliveryOrderPayload({ ...filled, deliveryUntil: "2026-11-30", truckCount: "", remark: "" }, "limited")).toEqual({
      deliveryUntil: "2026-11-30",
      truckCount: null,
      remark: null,
    });
  });
});

describe("destinationGaps and destinationLine", () => {
  const typed = { id: null, name: "Gudang Contoh", address: "Jl. Contoh 1", district: "Kec. Contoh", regency: "Kab. Contoh", province: "Prov. Contoh" };

  it("names the parts a DO still needs before it is sent", () => {
    expect(destinationGaps(typed)).toEqual([]);
    expect(destinationGaps({ ...typed, address: null, district: " ", province: null })).toEqual(["alamat", "kecamatan", "provinsi"]);
    expect(destinationGaps(null)).toEqual(["nama", "alamat", "kecamatan", "kabupaten atau kota", "provinsi"]);
  });

  it("writes the destination on one line without the empty parts", () => {
    expect(destinationLine(typed)).toBe("Gudang Contoh, Jl. Contoh 1, Kec. Contoh, Kab. Contoh, Prov. Contoh");
    expect(destinationLine({ ...typed, address: null, district: null, province: null })).toBe("Gudang Contoh, Kab. Contoh");
    expect(destinationLine(null)).toBe("-");
  });
});

describe("validateCard and cardPayload", () => {
  it("needs a UID in hexadecimal for a new card", () => {
    expect(validateCard({ uid: "", label: "", note: "", status: "" }, true).uid).toBe(
      "Tempelkan kartu ke pembaca, atau ketik UID kartu.",
    );
    expect(validateCard({ uid: "0a:1b:2c:3d", label: "", note: "", status: "" }, true)).toEqual({});
  });

  it("normalises the UID of a new card", () => {
    expect(cardPayload({ uid: "0a:1b:2c:3d", label: " Kartu 1 ", note: "", status: "" }, true)).toEqual({
      uid: "0A1B2C3D",
      label: "Kartu 1",
    });
  });

  it("sends label, note and status when a card is edited", () => {
    expect(cardPayload({ uid: "0A1B2C3D", label: "", note: "retak", status: "LOST" }, false)).toEqual({
      label: null,
      note: "retak",
      status: "LOST",
    });
  });
});

describe("registrationFieldErrors", () => {
  it("puts the API's field messages on the fields of the incoming form", () => {
    const { errors, unplaced } = registrationFieldErrors("IN", {
      "trips.0.vehicle.plateDisplay": "Plat nomor harus 3 sampai 12 huruf atau angka.",
      "trips.0.driver.licenceValidUntil": "Masa berlaku SIM wajib diisi.",
      "trips.0.letters.1.originNetKg": "Netto asal harus sama dengan bruto dikurangi tarra.",
      "trips.0.letters.0.quality.FFA": "FFA harus antara 0 dan 20.",
      allocations: "Semua kontrak atau DO dalam satu registrasi harus satu jalur barang.",
      transporterId: "Transporter harus partner transporter.",
    });
    expect(errors).toEqual({
      "truck.plate": "Plat nomor harus 3 sampai 12 huruf atau angka.",
      "truck.licenceValidUntil": "Masa berlaku SIM wajib diisi.",
      "letters.1.originNetKg": "Netto asal harus sama dengan bruto dikurangi tarra.",
      "letters.0.quality.FFA": "FFA harus antara 0 dan 20.",
      contracts: "Semua kontrak atau DO dalam satu registrasi harus satu jalur barang.",
      transporter: "Transporter harus partner transporter.",
    });
    expect(unplaced).toEqual([]);
  });

  it("puts them on the trucks and orders of the outgoing form and keeps what has no field", () => {
    const { errors, unplaced } = registrationFieldErrors("OUT", {
      "trips.2.driver.id": "Supir tidak ditemukan.",
      "trips.1.containerNo": "Nomor kontainer wajib diisi untuk jenis kendaraan ini.",
      "allocations.0.qtyPlanned": "Quantity terlalu kecil untuk 4 truk.",
      closeCargo: "Close cargo wajib dijawab sebelum dikirim.",
      direction: "Arah registrasi tidak bisa diubah.",
    });
    expect(errors).toEqual({
      "trucks.2.licenceNo": "Supir tidak ditemukan.",
      "trucks.1.containerNo": "Nomor kontainer wajib diisi untuk jenis kendaraan ini.",
      "orders.0.qty": "Quantity terlalu kecil untuk 4 truk.",
      closeCargo: "Close cargo wajib dijawab sebelum dikirim.",
    });
    expect(unplaced).toEqual(["Arah registrasi tidak bisa diubah."]);
  });
});

describe("drafts back into the forms", () => {
  function trip(overrides: Partial<Trip> = {}): Trip {
    return {
      id: "trip-1",
      registrationId: "r-1",
      seq: 1,
      tripNo: null,
      status: "DRAFT",
      direction: "IN",
      flowCode: "IN_CPO",
      partner: { id: "p-1", name: "Partner p-1" },
      transporter: null,
      currentStep: null,
      vehicle: { id: "v-1", plateNo: "ZZ0001CTH", plateDisplay: "ZZ 0001 CTH", vehicleTypeCode: "TANGKI" },
      driver: { id: "d-1", fullName: "Supir Contoh", licenceNo: "CONTOH0001", registryStatus: "NORMAL" },
      containerNo: null,
      plannedArrival: "2026-11-21",
      qtyPlanned: null,
      docGrossKg: null,
      docTareKg: null,
      docNetKg: null,
      allocations: [],
      spj: null,
      card: null,
      checkedInAt: null,
      cancelReason: null,
      ...overrides,
    };
  }

  function registration(overrides: Partial<Registration> = {}): Registration {
    return {
      id: "r-1",
      regNo: "REG/1",
      direction: "IN",
      flowCode: "IN_CPO",
      status: "DRAFT",
      partner: { id: "p-1", name: "Partner p-1" },
      transporter: { id: "p-3", name: "Transporter" },
      plannedDate: "2026-11-21",
      truckCount: 1,
      qtyTotal: null,
      uom: "Kg",
      closeCargo: null,
      flexiBag: null,
      remark: "catatan",
      createdVia: "PORTAL",
      createdBy: { id: "u-1", fullName: "Pembuat" },
      createdAt: "2026-11-21T01:00:00Z",
      submittedAt: null,
      reviewedAt: null,
      reviewNote: null,
      findings: [],
      allocations: [],
      trips: [],
      ...overrides,
    };
  }

  const allocation = (seq: number, extra: Record<string, unknown>) => ({
    seq,
    contract: null,
    deliveryOrder: null,
    contractNo: `K-c-${seq}`,
    doNo: null,
    qtyPlanned: null,
    tolerancePct: 0.25,
    product: { id: "g-1", name: "CPO", category: "CPO" },
    partner: { id: "p-1", name: "Partner p-1" },
    ...extra,
  });

  const line = (seq: number, extra: Record<string, unknown> = {}) => ({
    seq,
    qtyPlanned: null,
    handoverNo: null,
    spbNo: null,
    spbDate: null,
    originTicketNo: null,
    originGrossKg: null,
    originTareKg: null,
    originNetKg: null,
    quality: {},
    ...extra,
  });

  it("fills the incoming form from a draft, with the plate and licence still to be looked up", () => {
    const values = incomingFromDraft(
      registration({
        allocations: [
          allocation(1, { contract: { id: "c-1", contractNo: "K-c-1" } }),
          allocation(2, { contract: { id: "c-2", contractNo: "K-c-2" } }),
        ],
        trips: [trip({ containerNo: "ABCU1", allocations: [line(1, { spbNo: "S1", originNetKg: 20000, quality: { FFA: 3.5 } }), line(2)] })],
      }),
      PARAMS,
    );
    expect(values.contracts.map((item) => [item.id, item.contractNo, item.partner.id])).toEqual([
      ["c-1", "K-c-1", "p-1"],
      ["c-2", "K-c-2", "p-1"],
    ]);
    expect(values.transporter).toEqual({ id: "p-3", name: "Transporter" });
    expect(values.plannedDate).toBe("2026-11-21");
    expect(values.remark).toBe("catatan");
    expect(values.truck).toMatchObject({ plate: "ZZ 0001 CTH", licenceNo: "CONTOH0001", containerNo: "ABCU1" });
    expect(values.truck.vehicle).toEqual({ state: "idle" });
    expect(values.letters[0]).toMatchObject({ spbNo: "S1", originNetKg: "20000", quality: { FFA: "3.5", MOISTURE: "" } });
    expect(values.letters[1]).toEqual(emptyLetter(PARAMS));
  });

  it("fills the outgoing form from a draft with the orders it names", () => {
    const values = outgoingFromDraft(
      registration({
        direction: "OUT",
        closeCargo: true,
        flexiBag: false,
        allocations: [allocation(1, { deliveryOrder: { id: "do-1", doNo: "DO-do-1" }, qtyPlanned: 38002 })],
        trips: [trip({ allocations: [line(1, { handoverNo: "H-1" })] }), trip({ id: "trip-2", seq: 2, vehicle: null, driver: null })],
      }),
      [order("do-1")],
    );
    expect(values.orders).toEqual([{ order: order("do-1"), qty: "38002" }]);
    expect(values.trucks.map((truck) => [truck.plate, truck.licenceNo, truck.handoverNo])).toEqual([
      ["ZZ 0001 CTH", "CONTOH0001", "H-1"],
      ["", "", ""],
    ]);
    expect([values.closeCargo, values.flexiBag]).toEqual(["yes", "no"]);
  });
});
