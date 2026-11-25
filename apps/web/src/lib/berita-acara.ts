// The printed Berita Acara of an approved request (GET /api/exceptions/:id/report). The owner's rule of 25 November
// 2026: every Berita Acara is signed by two people, the operator who registered the truck at the post and the
// approver, with no "Diketahui" column. Plate reports name the plate the camera read and the registered one.

import { formatNumber } from "@/lib/format";
import type { ExceptionReport } from "@/lib/types";
import { referenceLabel } from "@/lib/weighing";

export interface SignatureColumn {
  title: string;
  position: string;
  /** The name under the line; empty when the API names nobody yet. */
  name: string;
}

const COLUMNS: ReadonlyArray<{ role: string; title: string; position: string }> = [
  { role: "REGISTRAR", title: "Dibuat oleh", position: "Operator registrasi" },
  { role: "APPROVER", title: "Disetujui oleh", position: "Penyetuju" },
];

/** Exactly the two columns, registrar then approver, in the API's words when it sends them; nothing else. */
export function signatureColumns(report: Pick<ExceptionReport, "signers">): SignatureColumn[] {
  return COLUMNS.map((column) => {
    const signer = (report.signers ?? []).find((item) => item.role === column.role);
    return {
      title: signer?.title || column.title,
      position: signer?.position || column.position,
      name: signer?.user?.fullName?.trim() ?? "",
    };
  });
}

export const reportTitleOf = (report: Pick<ExceptionReport, "title">): string => report.title?.trim() || "Berita Acara";

/** The plate lines of a plate report; none for a weight report. */
export function plateLines(report: Pick<ExceptionReport, "plate">): Array<{ label: string; value: string }> {
  if (!report.plate) return [];
  return [
    { label: "Plat terbaca kamera", value: report.plate.read?.trim() || "Tidak terbaca" },
    { label: "Plat terdaftar", value: report.plate.registered?.trim() || "-" },
  ];
}

/** What the weighing was compared with, per report type. */
const REFERENCE: Record<string, string> = { GROSS_IN: "Bruto surat", NET_IN: "Netto surat", TARE_OUT: "Tarra master" };

const kg = (value: number | null) => (value === null ? "-" : `${formatNumber(value)} kg`);
const pct = (value: number | null) => (value === null ? "-" : `${formatNumber(value)}%`);

/** The weight lines of a weight report; none for a plate report. */
export function weightLines(report: Pick<ExceptionReport, "type" | "plate" | "expectedKg" | "weighedKg" | "diffKg" | "diffPct" | "tolerancePct">): Array<{ label: string; value: string }> {
  if (report.plate || report.type === "PLATE") return [];
  const diff = report.diffKg === null ? "-" : `${report.diffKg > 0 ? "+" : ""}${formatNumber(report.diffKg)} kg (${pct(report.diffPct)})`;
  return [
    { label: REFERENCE[report.type] ?? referenceLabel(report.type), value: kg(report.expectedKg) },
    { label: "Timbangan", value: kg(report.weighedKg) },
    { label: "Selisih", value: diff },
    { label: "Toleransi", value: pct(report.tolerancePct) },
  ];
}

/** "PC-1, DO 001/DO/..." for the contract and DO lines of the truck. */
export function documentText(report: Pick<ExceptionReport, "lines">): string {
  const parts = report.lines.map((line) => [line.contractNo, line.doNo ? `DO ${line.doNo}` : null].filter(Boolean).join(" / "));
  return parts.filter(Boolean).join(", ") || "-";
}
