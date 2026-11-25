// How a reading is compared with the master data, and how an answer of the reading service is taken apart.
// Every number and name here is made up.
import { describe, expect, it } from "vitest";
import { companyKey, compareNames, compareNumbers, editDistance, foldLookalikes, nameKey } from "../src/gate/matching.js";
import { readingOf } from "../src/gate/ocr-client.js";
import { letterAnswer, orderAnswer } from "./helpers/fake-ocr.js";

const numbers = (list: string[]) => list.map((no) => ({ no }));
const near = (read: string, list: string[]) => compareNumbers(read, numbers(list), (row) => row.no).near.map((found) => [found.item.no, found.distance, found.lookalikeOnly]);
const equal = (read: string, list: string[]) => compareNumbers(read, numbers(list), (row) => row.no).equal.map((row) => row.no);

describe("editDistance", () => {
  it("counts inserted, deleted and replaced characters, and stops counting past the limit", () => {
    expect(editDistance("ABC", "ABC", 2)).toBe(0);
    expect(editDistance("ABC", "ABD", 2)).toBe(1);
    expect(editDistance("ABC", "ABCD", 2)).toBe(1);
    expect(editDistance("XI2026", "IX2026", 2)).toBe(2);
    expect(editDistance("ABCDEF", "UVWXYZ", 2)).toBe(3);
    expect(editDistance("AB", "ABCDEFG", 2)).toBe(3);
    expect(editDistance("", "AB", 2)).toBe(2);
  });
});

describe("compareNumbers", () => {
  it("takes numbers as equal whatever their case, slashes, dashes and spaces", () => {
    expect(equal("0012/uji/cpo-l/xi/2026", ["0012/UJI/CPO-L/XI/2026", "0013/UJI/CPO-L/XI/2026"])).toEqual(["0012/UJI/CPO-L/XI/2026"]);
    expect(equal(" 0012 UJI CPO L XI 2026 ", ["0012/UJI/CPO-L/XI/2026"])).toEqual(["0012/UJI/CPO-L/XI/2026"]);
    expect(equal("", ["0012/UJI/CPO-L/XI/2026"])).toEqual([]);
  });

  it("offers numbers at most two characters apart, the nearest first, and none beyond", () => {
    expect(near("0012/UJI/CPO-L/XII/2026", ["0012/UJI/CPO-L/X/2026", "0012/UJI/CPO-L/XI/2026", "0012/UJI/CPO-L/IV/2025", "0099/UJI/CPO-L/V/2026"])).toEqual([
      ["0012/UJI/CPO-L/XI/2026", 1, false],
      ["0012/UJI/CPO-L/X/2026", 2, false],
    ]);
  });

  it("offers a number that is the same once O/0 and I/L/1 are folded, before the others and however many they are", () => {
    expect(foldLookalikes("OIL0I1")).toBe("011011");
    expect(near("OO12/UJ1/CPO-I/X1/2O26", ["0012/UJI/CPO-L/XI/2026", "OO12/UJ1/CPO-I/X1/2O27"])).toEqual([
      ["0012/UJI/CPO-L/XI/2026", 6, true],
      ["OO12/UJ1/CPO-I/X1/2O27", 1, false],
    ]);
  });

  it("gives a short number less room, so a few characters do not match everything", () => {
    expect(near("AB1", ["AB2", "AC1", "AB1X"])).toEqual([]);
    expect(near("AB12", ["AB13", "AC13"])).toEqual([["AB13", 1, false]]);
    expect(near("AB123456", ["AB123499", "AB129999"])).toEqual([["AB123499", 2, false]]);
  });
});

describe("compareNames", () => {
  const names = (list: string[]) => list.map((name) => ({ name }));
  const found = (read: string, list: string[], key?: (text: string) => string) => {
    const result = compareNames(read, names(list), (row) => row.name, key);
    return { equal: result.equal.map((row) => row.name), near: result.near.map((item) => [item.item.name, item.distance]) };
  };

  it("takes names as equal whatever their case, punctuation and spacing", () => {
    expect(nameKey(" Supir  Contoh, S.Kom ")).toBe("SUPIR CONTOH S KOM");
    expect(found("SUPIR CONTOH SATU", ["Supir Contoh Satu", "Supir Contoh Dua"]).equal).toEqual(["Supir Contoh Satu"]);
    expect(found("SUPIRCONTOH SATU", ["Supir Contoh Satu"]).equal).toEqual(["Supir Contoh Satu"]);
  });

  it("leaves the legal form out of a company name", () => {
    expect(companyKey("PT. Angkut Contoh, Tbk")).toBe("ANGKUT CONTOH");
    expect(found("ANGKUT CONTOH, PT", ["PT Angkut Contoh", "CV Angkut Lain"], companyKey).equal).toEqual(["PT Angkut Contoh"]);
    // with the legal form counted, "…, PT" and "PT …" are two names
    expect(found("ANGKUT CONTOH, PT", ["PT Angkut Contoh"])).toEqual({ equal: [], near: [] });
  });

  it("offers names up to two characters apart first, then names that contain each other, the closest in length first", () => {
    expect(found("ZULKARNAN CONTOH", ["Zulkarnain Contoh", "Zulkarnaen Contoh Panjang Sekali", "Zulkarnan Contoh Dua", "Orang Lain"])).toEqual({
      equal: [],
      near: [
        ["Zulkarnain Contoh", 1],
        ["Zulkarnan Contoh Dua", null],
      ],
    });
    // too short to look for inside other names
    expect(found("ALI", ["Ali Contoh", "Alif Contoh"]).near).toEqual([]);
  });
});

describe("readingOf", () => {
  it("takes the fields with the flag and the reason the service gave each, and the detector's counts", () => {
    const answer = letterAnswer({}, { perlu_cek_manual: { ...(letterAnswer().perlu_cek_manual as object), no_sim: true }, perbaikan: { no_sim: "keyakinan baca rendah" }, peringatan: ["periksa lagi", ""] });
    const reading = readingOf(answer, 12);
    expect(reading).toMatchObject({ read: true, unreadable: false, fieldsFound: 12, fieldsTotal: 12, warnings: ["periksa lagi"], netConsistent: true, netConsistentReason: null, ms: 12 });
    expect(reading.fields.find((field) => field.key === "no_sim")).toEqual({ key: "no_sim", value: "SIMSURAT0001", needsCheck: true, reason: "keyakinan baca rendah" });
    expect(reading.fields.find((field) => field.key === "brutto_kg")).toEqual({ key: "brutto_kg", value: 40120, needsCheck: false, reason: null });
    expect(reading.lines).toHaveLength(1);
    expect(reading.lines[0]?.nomor_kontrak).toEqual({ key: "nomor_kontrak", value: "0012/UJI/CPO-L/XI/2026", needsCheck: false, reason: null });
  });

  it("flags every field of a further row unless the service says otherwise", () => {
    const answer = letterAnswer();
    const reading = readingOf({ ...answer, baris: [...(answer.baris as object[]), { nomor_kontrak: "0013/UJI/CPO-L/XI/2026", netto_kg: 2000 }], perlu_cek_manual: { ...(answer.perlu_cek_manual as object), netto_kg_baris2: false } }, 1);
    expect(reading.lines[1]).toEqual({
      nomor_kontrak: { key: "nomor_kontrak", value: "0013/UJI/CPO-L/XI/2026", needsCheck: true, reason: null },
      netto_kg: { key: "netto_kg", value: 2000, needsCheck: false, reason: null },
    });
  });

  it("calls a document unreadable below half of the fields, as the old proxy did, and when there is no reading", () => {
    const withCounts = (found: number, total: number) => readingOf({ ...orderAnswer(), yolo: { field_ditemukan: found, field_total: total } }, 1).unreadable;
    expect([withCounts(4, 9), withCounts(5, 9), withCounts(9, 9), withCounts(0, 0)]).toEqual([true, false, false, false]);
    // without the detector's counts a reading is taken as it is
    expect(readingOf({ ...orderAnswer(), yolo: null }, 1)).toMatchObject({ read: true, unreadable: false, fieldsFound: null, fieldsTotal: null });
    for (const answer of [null, "teks", [], {}, { status: "error" }, { status: "success", data: {} }, { status: "success", data: null }]) {
      expect(readingOf(answer, 1), JSON.stringify(answer)).toMatchObject({ read: false, unreadable: true, fields: [], lines: [] });
    }
  });

  it("keeps texts and numbers and drops everything else a field might hold", () => {
    const reading = readingOf({ status: "success", data: { a: "  teks  ", b: "", c: 3.5, d: true, e: { x: 1 }, f: null, g: Number.NaN } }, 1);
    expect(reading.fields.map((field) => field.value)).toEqual(["teks", null, 3.5, null, null, null, null]);
  });
});
