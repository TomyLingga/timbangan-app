import { describe, expect, it } from "vitest";

import {
  exceptionStatusLabel,
  exceptionTypeLabel,
  groupShares,
  historyPeriod,
  historyStateInfo,
  legacyFields,
  sealFacts,
  tripValue,
  type LegacyTrip,
} from "@/lib/legacy-history";

function trip(overrides: Partial<LegacyTrip> = {}): LegacyTrip {
  return {
    id: 1, site: "SMK", legacyId: 101, ticketNo: "5001", direction: "IN", material: "CPO", state: "COMPLETED", entryDate: "2026-11-20",
    arrivedAt: null, leftAt: null, plateText: "ZZ 9001 RK", plateNo: "ZZ9001RK", driverName: "Supir Rekaan", licenceNo: null, transporter: null,
    partnerName: null, mill: null, productName: null, uom: null, reference: "0001/KONTRAK/REK", doNo: null, poNo: null, spbNo: null, handoverNo: null,
    docGrossKg: null, docTareKg: null, docNetKg: null, grossKg: 40000, tareKg: 15000, netKg: 25000, weigh1At: null, weigh2At: null, weigh1By: null,
    weigh2By: null, groupId: null, closeCargo: null, flexiBag: null,
    ...overrides,
  };
}

describe("historyStateInfo", () => {
  it("names the four states of the archive, and keeps an unknown one as it is", () => {
    expect(historyStateInfo("COMPLETED")).toEqual({ label: "Selesai", tone: "success" });
    expect(historyStateInfo("REJECTED_QC")).toEqual({ label: "Ditolak QC", tone: "destructive" });
    expect(historyStateInfo("REJECTED_CLEANLINESS")).toEqual({ label: "Ditolak kebersihan", tone: "destructive" });
    expect(historyStateInfo("UNFINISHED")).toEqual({ label: "Tidak selesai", tone: "neutral" });
    expect(historyStateInfo("ODD")).toEqual({ label: "ODD", tone: "neutral" });
  });
});

describe("historyPeriod", () => {
  it("covers the last 30 days up to today", () => {
    expect(historyPeriod("2026-11-24")).toEqual({ from: "2026-10-26", to: "2026-11-24" });
    expect(historyPeriod("2026-03-01")).toEqual({ from: "2026-01-31", to: "2026-03-01" });
  });
});

describe("tripValue", () => {
  it("gives the stored value when there is one", () => {
    expect(tripValue(trip({ docGrossKg: 40000 }), "docGrossKg", { "registrasi.bruto_from": "40000.4" })).toEqual({ value: 40000, original: null });
  });

  it("gives the original text of a value the import could not read", () => {
    const original = { "registrasi.bruto_from": "40.010 kg", "timbangan.tgl_timbang2": "2026-11-31 25:00" };
    expect(tripValue(trip(), "docGrossKg", original)).toEqual({ value: null, original: "40.010 kg" });
    expect(tripValue(trip(), "weigh2At", original)).toEqual({ value: null, original: "2026-11-31 25:00" });
    expect(tripValue(trip(), "docNetKg", original)).toEqual({ value: null, original: null });
    expect(tripValue(trip(), "docNetKg", undefined)).toEqual({ value: null, original: null });
  });
});

describe("legacyFields", () => {
  const labels = { no_pintu: "Nomor pintu", unloading_usr: "Petugas bongkar" };

  it("lists the known columns first under their names, then the rest under the old column name", () => {
    expect(legacyFields({ id: 601, cek_bau: "1", unloading_usr: "bongkar1", no_pintu: 2, kosong: "  ", none: null }, labels)).toEqual([
      { key: "no_pintu", label: "Nomor pintu", value: "2", known: true },
      { key: "unloading_usr", label: "Petugas bongkar", value: "bongkar1", known: true },
      { key: "cek_bau", label: "cek_bau", value: "1", known: false },
    ]);
  });

  it("leaves out the columns it is told to and answers nothing for a missing row", () => {
    expect(legacyFields({ no_pintu: "2", segel1: "S-1" }, labels, ["segel1"])).toEqual([{ key: "no_pintu", label: "Nomor pintu", value: "2", known: true }]);
    expect(legacyFields(null, labels)).toEqual([]);
    expect(legacyFields({ flag: true, nested: { a: 1 } }, {})).toEqual([
      { key: "flag", label: "flag", value: "ya", known: false },
      { key: "nested", label: "nested", value: '{"a":1}', known: false },
    ]);
  });
});

describe("sealFacts", () => {
  it("takes the seal numbers and the seal columns of the loading and unloading sheets", () => {
    const facts = sealFacts({
      seals: ["LC-REK-001", "LC-REK-002"],
      loading: { segel1: "LC-REK-001", segel2: "LC-REK-002", segel3: "", segel_usr: "segel1", remark_segel: "utuh", nama_tangki: "T-1" },
      unloading: { segel1_reject: "LC-REK-009", no_pintu: "2" },
    });
    expect(facts.numbers).toEqual(["LC-REK-001", "LC-REK-002"]);
    expect(facts.fields.map((field) => [field.label, field.value])).toEqual([
      ["Dipasang oleh", "segel1"],
      ["Catatan segel", "utuh"],
      ["Segel ditolak", "LC-REK-009"],
    ]);
    expect(sealFacts({})).toEqual({ numbers: [], fields: [] });
  });
});

describe("exception labels", () => {
  it("names the old request types and statuses", () => {
    expect(exceptionTypeLabel("NETTO_IN")).toBe("Selisih netto masuk");
    expect(exceptionTypeLabel("PLAT")).toBe("Plat tidak cocok");
    expect(exceptionTypeLabel(null)).toBe("Berita acara selisih");
    expect(exceptionTypeLabel("LAIN")).toBe("LAIN");
    expect(exceptionStatusLabel("APPROVED")).toBe("Disetujui");
    expect(exceptionStatusLabel("rejected")).toBe("Ditolak");
    expect(exceptionStatusLabel(null)).toBeNull();
    expect(exceptionStatusLabel("ANEH")).toBe("ANEH");
  });
});

describe("groupShares", () => {
  it("lists this row and the other rows of its group by legacy id, with the sum of the net", () => {
    const self = trip({ id: 3, legacyId: 103, groupId: 103, netKg: 10000 });
    const other = trip({ id: 4, legacyId: 104, groupId: 103, netKg: 8000, reference: "0004/KONTRAK/REK" });
    const shares = groupShares(self, [other]);
    expect(shares?.rows.map((row) => [row.trip.legacyId, row.current])).toEqual([
      [103, true],
      [104, false],
    ]);
    expect(shares?.totalNetKg).toBe(18000);
  });

  it("answers null for a truck without a group, and leaves an unknown net out of the sum", () => {
    expect(groupShares(trip(), [])).toBeNull();
    expect(groupShares(trip({ groupId: 101, netKg: null }), [trip({ legacyId: 102, groupId: 101, netKg: 5000 })])?.totalNetKg).toBe(5000);
  });
});
