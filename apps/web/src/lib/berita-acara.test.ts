import { describe, expect, it } from "vitest";

import { documentText, plateLines, reportTitleOf, signatureColumns, weightLines } from "@/lib/berita-acara";
import type { ExceptionReport } from "@/lib/types";

const signers: ExceptionReport["signers"] = [
  { role: "REGISTRAR", title: "Dibuat oleh", position: "Operator registrasi", user: { id: 2, fullName: "Petugas Pos Contoh" } },
  { role: "APPROVER", title: "Disetujui oleh", position: "Penyetuju", user: { id: 1, fullName: "Admin Contoh" } },
];

describe("signatureColumns", () => {
  it("gives exactly the registrar and the approver, in that order", () => {
    expect(signatureColumns({ signers: [...signers].reverse() })).toEqual([
      { title: "Dibuat oleh", position: "Operator registrasi", name: "Petugas Pos Contoh" },
      { title: "Disetujui oleh", position: "Penyetuju", name: "Admin Contoh" },
    ]);
  });

  it("never adds a third column, even when one is sent", () => {
    const columns = signatureColumns({ signers: [...signers, { role: "ACKNOWLEDGER", title: "Diketahui", position: "Kepala", user: null }] });
    expect(columns.map((column) => column.title)).toEqual(["Dibuat oleh", "Disetujui oleh"]);
  });

  it("keeps a column with an empty name when the API names nobody", () => {
    expect(signatureColumns({ signers: [{ ...signers[0], user: null }] })).toEqual([
      { title: "Dibuat oleh", position: "Operator registrasi", name: "" },
      { title: "Disetujui oleh", position: "Penyetuju", name: "" },
    ]);
  });
});

describe("the lines of a report", () => {
  it("names the plates of a plate report and says when the camera read nothing", () => {
    expect(plateLines({ plate: { read: "ZZ0002CTN", registered: "ZZ 0002 CTH" } })).toEqual([
      { label: "Plat terbaca kamera", value: "ZZ0002CTN" },
      { label: "Plat terdaftar", value: "ZZ 0002 CTH" },
    ]);
    expect(plateLines({ plate: { read: null, registered: "ZZ 0002 CTH" } })[0]).toEqual({ label: "Plat terbaca kamera", value: "Tidak terbaca" });
    expect(plateLines({ plate: null })).toEqual([]);
  });

  it("gives the weights of a weight report and none of a plate report", () => {
    const report = { type: "GROSS_IN", plate: null, expectedKg: 34000, weighedKg: 34650, diffKg: 650, diffPct: 1.9118, tolerancePct: 0.25 };
    expect(weightLines(report)).toEqual([
      { label: "Bruto surat", value: "34.000 kg" },
      { label: "Timbangan", value: "34.650 kg" },
      { label: "Selisih", value: "+650 kg (1,912%)" },
      { label: "Toleransi", value: "0,25%" },
    ]);
    expect(weightLines({ ...report, type: "PLATE", plate: { read: null, registered: "ZZ 0002 CTH" } })).toEqual([]);
  });

  it("uses the title the API sends", () => {
    expect(reportTitleOf({ title: "Berita Acara Plat Tidak Terbaca" })).toBe("Berita Acara Plat Tidak Terbaca");
    expect(reportTitleOf({ title: "" })).toBe("Berita Acara");
  });

  it("lists the contracts and delivery orders of the truck", () => {
    expect(documentText({ lines: [{ seq: 1, contractNo: "PC-CONTOH-01", doNo: null }, { seq: 2, contractNo: "SC-CONTOH-02", doNo: "001/DO/CTH/XI/2026" }] })).toBe(
      "PC-CONTOH-01, SC-CONTOH-02 / DO 001/DO/CTH/XI/2026",
    );
    expect(documentText({ lines: [] })).toBe("-");
  });
});
