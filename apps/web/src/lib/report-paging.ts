// Paging of the reports: the API answers one page of rows plus the number of matching rows and totals over all of
// them (GET /api/reports/contracts and /trips with limit and offset). The page number lives in the address bar.

import { formatNumber } from "@/lib/format";

export const REPORT_PAGE_SIZE = 50;

/** The page number in the address bar: a whole number from 1, else 1. */
export function pageFromParam(value: string): number {
  return /^[1-9]\d*$/.test(value) ? Number(value) : 1;
}

export function pageOffset(page: number, size = REPORT_PAGE_SIZE): number {
  return (page - 1) * size;
}

/** The number of the last page; 1 when nothing matches. */
export function lastPage(total: number, size = REPORT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/** "51–100 dari 4.052": the rows on this page of all the matching ones. */
export function pageRangeText(page: number, shown: number, total: number, size = REPORT_PAGE_SIZE): string {
  if (shown === 0) return `0 dari ${formatNumber(total)}`;
  const first = pageOffset(page, size) + 1;
  return `${formatNumber(first)}–${formatNumber(first + shown - 1)} dari ${formatNumber(total)}`;
}

/** Realisation per unit, as "31.000 kg dan 120 karton"; quantities of different units are not added up. */
export function realisedText(byUom: ReadonlyArray<{ uom: string | null; realised: number }>): string {
  if (byUom.length === 0) return "0";
  return byUom.map((row) => `${formatNumber(row.realised)}${row.uom ? ` ${row.uom}` : ""}`).join(" dan ");
}
