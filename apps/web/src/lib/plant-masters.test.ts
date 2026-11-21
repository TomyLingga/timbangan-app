import { describe, expect, it } from "vitest";

import { sealBatchPreview, tankProductText, tankSyncSummary } from "@/lib/plant-masters";

const roll = (over: Partial<{ kind: string; prefix: string; from: string; to: string; width: string }> = {}) => ({
  kind: "LOCIS",
  prefix: "lc-",
  from: "1",
  to: "100",
  width: "4",
  ...over,
});

describe("sealBatchPreview", () => {
  it("pads the running number and shows the first, the last and how many", () => {
    expect(sealBatchPreview(roll())).toEqual({
      ok: true,
      body: { kind: "LOCIS", prefix: "LC-", from: 1, to: 100, width: 4 },
      first: "LC-0001",
      last: "LC-0100",
      count: 100,
    });
    expect(sealBatchPreview(roll({ prefix: "", from: "7", to: "7", width: "1" }))).toMatchObject({ ok: true, first: "7", last: "7", count: 1 });
  });

  it("refuses what the API refuses", () => {
    expect(sealBatchPreview(roll({ to: "0", from: "5" }))).toEqual({ ok: false, errors: { to: "Nomor akhir tidak boleh lebih kecil dari nomor awal." } });
    expect(sealBatchPreview(roll({ from: "1", to: "5001" }))).toEqual({ ok: false, errors: { to: "Paling banyak 5.000 segel sekali tambah." } });
    expect(sealBatchPreview(roll({ from: "12000", to: "12345", width: "4" }))).toEqual({ ok: false, errors: { width: "Lebar angka kurang untuk nomor 12345." } });
    expect(sealBatchPreview(roll({ prefix: "LC 1" }))).toMatchObject({ ok: false, errors: { prefix: expect.any(String) } });
    expect(sealBatchPreview(roll({ from: "x", to: "-1", width: "13" }))).toEqual({
      ok: false,
      errors: { from: "Isi nomor awal dengan angka bulat.", to: "Isi nomor akhir dengan angka bulat.", width: "Lebar angka 1 sampai 12." },
    });
  });
});

describe("tankProductText", () => {
  it("prefers the product, then the Odoo label", () => {
    expect(tankProductText({ product: { id: 1, name: "Minyak Contoh" }, productLabel: "CPO" })).toBe("Minyak Contoh");
    expect(tankProductText({ product: null, productLabel: "PFAD" })).toBe("PFAD");
    expect(tankProductText({ product: null, productLabel: null })).toBe("Semua produk");
  });
});

describe("tankSyncSummary", () => {
  it("says what the tank step did or why it did not run", () => {
    expect(tankSyncSummary({ status: "OK", written: 3, deactivated: 1, skipped: 0 })).toBe(
      "Tangki dari Odoo: 3 tangki baru atau berubah, 1 dinonaktifkan karena tidak ada lagi di Odoo.",
    );
    expect(tankSyncSummary({ status: "SKIPPED", reason: "x" })).toBe("Tangki tidak disalin: lokasi induk tangki di Odoo belum diatur di server.");
  });
});
