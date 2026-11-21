import { describe, expect, it } from "vitest";

import type { Driver, VcfSyncResult } from "@/lib/types";
import { driverSavedMessage, registryPushInfo, vcfSyncSummary } from "@/lib/vcf";

function driver(overrides: Partial<Driver>): Driver {
  return {
    id: "d-1",
    fullName: "Uji Satu",
    licenceNo: "UJI0001",
    licenceClass: "B2 UMUM",
    licenceValidUntil: "2027-06-30",
    licenceExpired: false,
    registryStatus: "UNKNOWN",
    registrySyncedAt: null,
    registryPush: "PENDING",
    registryPushError: null,
    isActive: true,
    ...overrides,
  };
}

function result(overrides: Partial<VcfSyncResult>): VcfSyncResult {
  return { drivers: 10, transporters: 2, skipped: 0, durationMs: 400, pushed: 0, pushFailed: 0, ...overrides };
}

describe("registryPushInfo", () => {
  it("labels a driver waiting to be sent and one that could not be sent", () => {
    expect(registryPushInfo("PENDING")).toEqual({ label: "Menunggu dikirim ke VCF", tone: "warning" });
    expect(registryPushInfo("FAILED")).toEqual({ label: "Gagal dikirim ke VCF", tone: "destructive" });
  });

  it("gives no indicator when nothing is waiting, whatever the letter case", () => {
    expect(registryPushInfo("SENT")).toBeNull();
    expect(registryPushInfo("NONE")).toBeNull();
    expect(registryPushInfo("none")).toBeNull();
    expect(registryPushInfo(null)).toBeNull();
    expect(registryPushInfo(undefined)).toBeNull();
    expect(registryPushInfo("")).toBeNull();
  });

  it("recognises lower case and shows a new value as it is", () => {
    expect(registryPushInfo("pending")?.label).toBe("Menunggu dikirim ke VCF");
    expect(registryPushInfo("RETRYING")).toEqual({ label: "RETRYING", tone: "neutral" });
  });
});

describe("vcfSyncSummary", () => {
  it("gives the duration, the counts taken and the counts sent", () => {
    expect(vcfSyncSummary(result({ pushed: 3, pushFailed: 1 }))).toBe(
      "Selesai dalam 400 ms. Diambil dari VCF: 10 supir, 2 transporter. Dikirim ke VCF: 3 supir, gagal 1.",
    );
  });

  it("says so when nothing had to be sent", () => {
    expect(vcfSyncSummary(result({ durationMs: 2400 }))).toBe(
      "Selesai dalam 2,4 detik. Diambil dari VCF: 10 supir, 2 transporter. Tidak ada supir yang perlu dikirim ke VCF.",
    );
  });

  it("adds skipped rows, a stopped push and Indonesian number grouping", () => {
    expect(vcfSyncSummary(result({ drivers: 1250, skipped: 4, pushed: 2, pushFailed: 5, pushStopped: true }))).toBe(
      "Selesai dalam 400 ms. Diambil dari VCF: 1.250 supir, 2 transporter. Dilewati: 4. Dikirim ke VCF: 2 supir, gagal 5. Pengiriman ke VCF berhenti sebelum semua supir terkirim.",
    );
  });

  it("copes with an older answer that has no push counts", () => {
    const older = { drivers: 8, transporters: 2, skipped: 0, durationMs: 400 } as VcfSyncResult;
    expect(vcfSyncSummary(older)).toBe("Selesai dalam 400 ms. Diambil dari VCF: 8 supir, 2 transporter.");
  });
});

describe("driverSavedMessage", () => {
  it("names the driver and the push state the server returned", () => {
    expect(driverSavedMessage(driver({ registryPush: "PENDING" }))).toBe(
      "Supir Uji Satu ditambahkan dan menunggu dikirim ke VCF.",
    );
    expect(driverSavedMessage(driver({ registryPush: "SENT" }))).toBe(
      "Supir Uji Satu ditambahkan dan sudah dikirim ke VCF.",
    );
    expect(driverSavedMessage(driver({ registryPush: "FAILED", registryPushError: "Registry timeout" }))).toBe(
      "Supir Uji Satu ditambahkan, tetapi gagal dikirim ke VCF. Pesan server: Registry timeout",
    );
  });

  it("stays short when the server gives no push state or no reason", () => {
    expect(driverSavedMessage(driver({ registryPush: "NONE" }))).toBe("Supir Uji Satu ditambahkan.");
    expect(driverSavedMessage(driver({ registryPush: null }))).toBe("Supir Uji Satu ditambahkan.");
    expect(driverSavedMessage(driver({ registryPush: "FAILED", registryPushError: null }))).toBe(
      "Supir Uji Satu ditambahkan, tetapi gagal dikirim ke VCF.",
    );
  });
});
