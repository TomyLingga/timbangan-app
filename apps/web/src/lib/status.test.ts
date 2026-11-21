import { describe, expect, it } from "vitest";

import {
  contractStateInfo,
  expiredDocumentLabel,
  expirySummary,
  latestRunPerEntity,
  registryStatusInfo,
  runsBySource,
  syncEntityLabel,
  syncStatusInfo,
} from "@/lib/status";
import type { SyncRun } from "@/lib/types";

function run(overrides: Partial<SyncRun>): SyncRun {
  return {
    id: 1,
    entity: "contracts",
    status: "SUCCESS",
    startedAt: "2026-11-20T03:00:00Z",
    finishedAt: "2026-11-20T03:00:02Z",
    rowsUpserted: 0,
    error: null,
    ...overrides,
  };
}

describe("contractStateInfo", () => {
  it("labels open and closed contracts whatever the letter case", () => {
    expect(contractStateInfo("OPEN")).toEqual({ label: "Aktif", tone: "success" });
    expect(contractStateInfo("open")).toEqual({ label: "Aktif", tone: "success" });
    expect(contractStateInfo("CLOSED")).toEqual({ label: "Tutup", tone: "neutral" });
    expect(contractStateInfo("done")).toEqual({ label: "Tutup", tone: "neutral" });
  });

  it("labels the other states Odoo is known to use", () => {
    expect(contractStateInfo("EXPIRED")).toEqual({ label: "Kedaluwarsa", tone: "warning" });
    expect(contractStateInfo("DRAFT")).toEqual({ label: "Draf", tone: "neutral" });
    expect(contractStateInfo("cancel")).toEqual({ label: "Batal", tone: "destructive" });
  });

  it("shows an unknown state as it is", () => {
    expect(contractStateInfo("ON_HOLD")).toEqual({ label: "ON_HOLD", tone: "neutral" });
    expect(contractStateInfo("")).toEqual({ label: "-", tone: "neutral" });
  });
});

describe("syncStatusInfo", () => {
  it("labels success, failure and a run in progress", () => {
    expect(syncStatusInfo("SUCCESS")).toEqual({ label: "Berhasil", tone: "success" });
    expect(syncStatusInfo("ok")).toEqual({ label: "Berhasil", tone: "success" });
    expect(syncStatusInfo("FAILED")).toEqual({ label: "Gagal", tone: "destructive" });
    expect(syncStatusInfo("RUNNING")).toEqual({ label: "Sedang berjalan", tone: "warning" });
  });

  it("shows an unknown status as it is", () => {
    expect(syncStatusInfo("PARTIAL")).toEqual({ label: "PARTIAL", tone: "neutral" });
  });
});

describe("syncEntityLabel", () => {
  it("names the three copied data sets", () => {
    expect(syncEntityLabel("contracts")).toBe("Kontrak");
    expect(syncEntityLabel("PARTNERS")).toBe("Partner");
    expect(syncEntityLabel("product")).toBe("Barang");
  });

  it("shows an unknown entity as it is", () => {
    expect(syncEntityLabel("uoms")).toBe("uoms");
  });
});

describe("registryStatusInfo", () => {
  it("labels the four statuses a driver can have in the registry", () => {
    expect(registryStatusInfo("NORMAL")).toEqual({ label: "Normal", tone: "success" });
    expect(registryStatusInfo("WARNING")).toEqual({ label: "Warning", tone: "warning" });
    expect(registryStatusInfo("BLACKLIST")).toEqual({ label: "Blacklist", tone: "destructive" });
    expect(registryStatusInfo("UNKNOWN")).toEqual({ label: "Belum ada di VCF", tone: "neutral" });
  });

  it("treats a missing status as not yet in the registry and shows a new one as it is", () => {
    expect(registryStatusInfo(null)).toEqual({ label: "Belum ada di VCF", tone: "neutral" });
    expect(registryStatusInfo("SUSPENDED")).toEqual({ label: "SUSPENDED", tone: "neutral" });
  });
});

describe("expiry labels", () => {
  it("names each expired vehicle document", () => {
    expect(expiredDocumentLabel("STNK")).toBe("STNK lewat");
    expect(expiredDocumentLabel("TAX")).toBe("Pajak lewat");
    expect(expiredDocumentLabel("KIR")).toBe("KIR lewat");
    expect(expiredDocumentLabel("SIO")).toBe("SIO lewat");
  });

  it("joins them into one summary line in a fixed order, or gives null", () => {
    expect(expirySummary(["KIR", "TAX"])).toBe("Pajak lewat, KIR lewat");
    expect(expirySummary(["STNK", "TAX", "KIR"])).toBe("STNK lewat, Pajak lewat, KIR lewat");
    expect(expirySummary([])).toBeNull();
    expect(expirySummary(null)).toBeNull();
  });
});

describe("runsBySource", () => {
  it("puts driver and transporter runs under VCF and the rest under Odoo", () => {
    const runs = [
      run({ id: 1, entity: "contracts" }),
      run({ id: 2, entity: "drivers" }),
      run({ id: 3, entity: "TRANSPORTERS" }),
      run({ id: 4, entity: "partners" }),
    ];
    const { odoo, vcf } = runsBySource(runs);
    expect(odoo.map((item) => item.id)).toEqual([1, 4]);
    expect(vcf.map((item) => item.id)).toEqual([2, 3]);
  });

  it("names the VCF data sets", () => {
    expect(syncEntityLabel("drivers")).toBe("Supir");
    expect(syncEntityLabel("transporters")).toBe("Transporter");
  });
});

describe("latestRunPerEntity", () => {
  it("keeps the newest run of each entity, newest first", () => {
    const runs = [
      run({ id: 1, entity: "contracts", startedAt: "2026-11-19T01:00:00Z" }),
      run({ id: 2, entity: "partners", startedAt: "2026-11-20T03:00:00Z" }),
      run({ id: 3, entity: "contracts", startedAt: "2026-11-20T03:00:05Z" }),
      run({ id: 4, entity: "products", startedAt: "2026-11-18T03:00:00Z" }),
    ];

    expect(latestRunPerEntity(runs).map((item) => item.id)).toEqual([3, 2, 4]);
  });

  it("puts runs without a start time last and copes with an empty list", () => {
    const runs = [
      run({ id: 1, entity: "partners", startedAt: null }),
      run({ id: 2, entity: "contracts", startedAt: "2026-11-20T03:00:00Z" }),
    ];

    expect(latestRunPerEntity(runs).map((item) => item.id)).toEqual([2, 1]);
    expect(latestRunPerEntity([])).toEqual([]);
  });
});
