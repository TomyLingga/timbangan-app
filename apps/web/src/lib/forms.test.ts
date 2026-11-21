import { describe, expect, it } from "vitest";

import {
  destinationPayload,
  driverPayload,
  EMPTY_DESTINATION,
  EMPTY_DRIVER,
  EMPTY_VEHICLE,
  validateDestination,
  validateDriver,
  validateVehicle,
  vehiclePayload,
  type VehicleValues,
} from "@/lib/forms";

const TODAY_YEAR = 2026;

describe("validateDriver", () => {
  const filled = {
    fullName: "Supir Contoh",
    licenceNo: "contoh 0001",
    licenceClass: "B2 UMUM",
    licenceValidUntil: "2030-01-31",
    phone: "",
  };

  it("passes a complete form", () => {
    expect(validateDriver(filled)).toEqual({});
  });

  it("asks for every required field", () => {
    expect(validateDriver(EMPTY_DRIVER)).toEqual({
      fullName: "Isi nama supir.",
      licenceNo: "Isi nomor SIM.",
      licenceClass: "Pilih jenis SIM.",
      licenceValidUntil: "Isi tanggal berlaku SIM.",
    });
  });

  it("checks the phone number only when one is given", () => {
    expect(validateDriver({ ...filled, phone: "0800 0000 0000" })).toEqual({});
    expect(validateDriver({ ...filled, phone: "+62 800-0000-0000" })).toEqual({});
    expect(validateDriver({ ...filled, phone: "telepon" })).toEqual({
      phone: "Nomor telepon hanya berisi angka, spasi, tanda tambah, dan tanda hubung.",
    });
  });

  it("builds the request body, leaving out an empty phone", () => {
    expect(driverPayload(filled)).toEqual({
      fullName: "Supir Contoh",
      licenceNo: "CONTOH 0001",
      licenceClass: "B2 UMUM",
      licenceValidUntil: "2030-01-31",
    });
    expect(driverPayload({ ...filled, phone: " 0800 0000 0000 " }).phone).toBe("0800 0000 0000");
  });
});

describe("validateVehicle", () => {
  const filled: VehicleValues = {
    ...EMPTY_VEHICLE,
    plateDisplay: "zz 0001 cth",
    capacityKg: "10000",
    productionYear: "2020",
    tareKg: "5000",
  };

  it("needs only the plate", () => {
    expect(validateVehicle({ ...EMPTY_VEHICLE, plateDisplay: "ZZ 0001 CTH" }, null, TODAY_YEAR)).toEqual({});
    expect(validateVehicle(EMPTY_VEHICLE, null, TODAY_YEAR)).toEqual({ plateDisplay: "Isi nomor plat." });
  });

  it("passes a complete form", () => {
    expect(validateVehicle(filled, null, TODAY_YEAR)).toEqual({});
  });

  it("wants positive whole numbers", () => {
    expect(validateVehicle({ ...filled, capacityKg: "0", tareKg: "-5" }, null, TODAY_YEAR)).toEqual({
      capacityKg: "Isi angka bulat lebih dari nol, tanpa titik atau koma.",
      tareKg: "Isi angka bulat lebih dari nol, tanpa titik atau koma.",
    });
    expect(validateVehicle({ ...filled, capacityKg: "10.000" }, null, TODAY_YEAR)).toEqual({
      capacityKg: "Isi angka bulat lebih dari nol, tanpa titik atau koma.",
    });
  });

  it("wants a four-digit year that is not in the future", () => {
    expect(validateVehicle({ ...filled, productionYear: "20" }, null, TODAY_YEAR).productionYear).toBe(
      "Isi tahun dengan empat angka, paling akhir 2027.",
    );
    expect(validateVehicle({ ...filled, productionYear: "2031" }, null, TODAY_YEAR).productionYear).toBe(
      "Isi tahun dengan empat angka, paling akhir 2027.",
    );
    expect(validateVehicle({ ...filled, productionYear: "2027" }, null, TODAY_YEAR)).toEqual({});
  });

  it("asks why the tare changed, only when it changed on an existing vehicle", () => {
    expect(validateVehicle({ ...filled, tareKg: "5200" }, { tareKg: 5000 }, TODAY_YEAR)).toEqual({
      tareReason: "Isi alasan perubahan tarra.",
    });
    expect(validateVehicle({ ...filled, tareKg: "5200", tareReason: "Ganti bak" }, { tareKg: 5000 }, TODAY_YEAR)).toEqual({});
    expect(validateVehicle(filled, { tareKg: 5000 }, TODAY_YEAR)).toEqual({});
    expect(validateVehicle({ ...filled, tareKg: "5200" }, null, TODAY_YEAR)).toEqual({});
  });
});

describe("vehiclePayload", () => {
  const values: VehicleValues = {
    plateDisplay: " zz  0001 cth ",
    vehicleTypeCode: "TANGKI",
    ownerPartnerId: "p-1",
    ownership: "MITRA",
    capacityKg: "10000",
    productionYear: "2020",
    tareKg: "5000",
    tareReason: "",
    stnkValidUntil: "2030-01-31",
    taxValidUntil: "",
    kirValidUntil: "",
    isActive: true,
  };

  it("sends numbers as numbers and empty fields as null on create", () => {
    expect(vehiclePayload(values, null)).toEqual({
      plateDisplay: "ZZ 0001 CTH",
      vehicleTypeCode: "TANGKI",
      ownerPartnerId: "p-1",
      ownership: "MITRA",
      capacityKg: 10000,
      productionYear: 2020,
      tareKg: 5000,
      stnkValidUntil: "2030-01-31",
      taxValidUntil: null,
      kirValidUntil: null,
    });
  });

  it("adds isActive on edit and the reason only when the tare changed", () => {
    const same = vehiclePayload(values, { tareKg: 5000 });
    expect(same.isActive).toBe(true);
    expect("tareReason" in same).toBe(false);

    const changed = vehiclePayload({ ...values, tareKg: "5200", tareReason: " Ganti bak " }, { tareKg: 5000 });
    expect(changed.tareKg).toBe(5200);
    expect(changed.tareReason).toBe("Ganti bak");
  });
});

describe("validateDestination", () => {
  it("asks for the place name and the address", () => {
    expect(validateDestination(EMPTY_DESTINATION)).toEqual({
      name: "Isi nama tempat.",
      address: "Isi alamat.",
    });
    expect(validateDestination({ ...EMPTY_DESTINATION, name: "Gudang Contoh", address: "Jalan Contoh 1" })).toEqual({});
  });

  it("builds the request body with trimmed text and null for empty optional fields", () => {
    expect(
      destinationPayload({
        partnerId: "",
        name: " Gudang Contoh ",
        address: " Jalan Contoh 1 ",
        district: "",
        regency: " Kabupaten Contoh ",
        province: "",
        isActive: false,
      }),
    ).toEqual({
      partnerId: null,
      name: "Gudang Contoh",
      address: "Jalan Contoh 1",
      district: null,
      regency: "Kabupaten Contoh",
      province: null,
      isActive: false,
    });
  });
});
