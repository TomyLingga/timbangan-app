import { describe, expect, it } from "vitest";

import { verificationText, verificationView } from "@/lib/vehicle-verification";

const vehicle = (plateDisplay: string, verified: boolean, tareKg: number | string | null = 5000) => ({ plateDisplay, verified, tareKg });

describe("verificationView", () => {
  const items = [vehicle("ZZ 0001 CTH", true), vehicle("ZZ 0005 CTH", false), vehicle("ZZ 0006 CTH", false)];

  it("shows every loaded vehicle without the filter and counts the unverified ones", () => {
    const view = verificationView(items, 3, "");
    expect(view.rows).toHaveLength(3);
    expect(view.counts).toEqual({ "": 3, belum: 2 });
    expect(view.partial).toBe(false);
  });

  it("keeps the unverified ones with the filter, and says when the server holds more than the page", () => {
    const view = verificationView(items, 120, "belum");
    expect(view.rows.map((row) => row.plateDisplay)).toEqual(["ZZ 0005 CTH", "ZZ 0006 CTH"]);
    expect(view.counts).toEqual({ "": 120, belum: 2 });
    expect(view.partial).toBe(true);
  });

  it("treats an unknown filter value as no filter", () => {
    expect(verificationView(items, 3, "aneh").rows).toHaveLength(3);
  });
});

describe("verificationText", () => {
  it("names the plate and the master tare that becomes the reference", () => {
    expect(verificationText(vehicle("ZZ 0005 CTH", false, "5000.000"), true)).toEqual({
      title: "Verifikasi ZZ 0005 CTH",
      description: "Setelah diverifikasi, tarra master 5.000 Kg dipakai sebagai acuan timbang tarra truk outgoing, dan registrasi berikutnya dengan kendaraan ini tidak lagi diberi catatan belum diverifikasi.",
      submitLabel: "Verifikasi",
      done: "Kendaraan ZZ 0005 CTH diverifikasi.",
    });
    expect(verificationText(vehicle("ZZ 0005 CTH", false, null), true).description).toBe(
      "Kendaraan ini belum punya tarra master, jadi timbang tarra truk outgoing tetap meminta keputusan sampai tarra diisi. Registrasi berikutnya dengan kendaraan ini tidak lagi diberi catatan belum diverifikasi.",
    );
  });

  it("says what is lost when the verification is cancelled", () => {
    expect(verificationText(vehicle("ZZ 0001 CTH", true), false)).toEqual({
      title: "Batalkan verifikasi ZZ 0001 CTH",
      description: "Tarra master kendaraan ini tidak lagi dipakai sebagai acuan, jadi timbang tarra truk outgoing berikutnya meminta keputusan. Registrasi berikutnya dengan kendaraan ini diberi catatan belum diverifikasi.",
      submitLabel: "Batalkan verifikasi",
      done: "Verifikasi kendaraan ZZ 0001 CTH dibatalkan.",
    });
  });
});
