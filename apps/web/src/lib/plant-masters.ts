// Plant masters (module plant_masters): storage tanks synced from Odoo and the stock of seal numbers. The API rules
// are in apps/api src/plant-masters/routes.ts; these helpers prepare what the pages show and send.

import type { StorageTank, TankSyncResult } from "@/lib/types";

export const MAX_SEAL_BATCH = 5000;

export const SEAL_STATUS_FILTERS = [
  { value: "", label: "Semua" },
  { value: "AVAILABLE", label: "Tersedia" },
  { value: "USED", label: "Terpakai" },
  { value: "VOID", label: "Batal" },
] as const;

export const SEAL_KINDS = [
  { value: "LOCIS", label: "Locis" },
  { value: "CUSTOMS", label: "Bea cukai" },
] as const;

/** What the product column says: the synced product, else the Odoo label, else that the tank takes any product. */
export function tankProductText(tank: Pick<StorageTank, "product" | "productLabel">): string {
  if (tank.product) return tank.product.name ?? "Produk tanpa nama";
  if (tank.productLabel) return tank.productLabel;
  return "Semua produk";
}

export interface SealBatchValues {
  kind: string;
  prefix: string;
  from: string;
  to: string;
  width: string;
}

export type SealBatchField = "prefix" | "from" | "to" | "width";

export type SealBatchPreview =
  | { ok: true; body: { kind: string; prefix: string; from: number; to: number; width: number }; first: string; last: string; count: number }
  | { ok: false; errors: Partial<Record<SealBatchField, string>> };

const wholeNumber = (text: string): number | null => (/^\d{1,12}$/.test(text.trim()) ? Number(text.trim()) : null);

/** Checks a roll of seal numbers the way the API does and shows its first and last number. */
export function sealBatchPreview(values: SealBatchValues): SealBatchPreview {
  const errors: Partial<Record<SealBatchField, string>> = {};
  const prefix = values.prefix.trim().toUpperCase();
  if (prefix.length > 20) errors.prefix = "Awalan paling panjang 20 huruf.";
  else if (!/^[A-Z0-9/-]*$/.test(prefix)) errors.prefix = "Awalan hanya boleh huruf, angka, garis miring, dan tanda minus.";
  const from = wholeNumber(values.from);
  const to = wholeNumber(values.to);
  const width = wholeNumber(values.width);
  if (from === null) errors.from = "Isi nomor awal dengan angka bulat.";
  if (to === null) errors.to = "Isi nomor akhir dengan angka bulat.";
  if (width === null || width < 1 || width > 12) errors.width = "Lebar angka 1 sampai 12.";
  if (from !== null && to !== null) {
    if (to < from) errors.to = "Nomor akhir tidak boleh lebih kecil dari nomor awal.";
    else if (to - from + 1 > MAX_SEAL_BATCH) errors.to = "Paling banyak 5.000 segel sekali tambah.";
  }
  if (to !== null && width !== null && !errors.width && String(to).length > width) errors.width = `Lebar angka kurang untuk nomor ${to}.`;
  if (Object.keys(errors).length > 0 || from === null || to === null || width === null) return { ok: false, errors };
  const number = (n: number) => `${prefix}${String(n).padStart(width, "0")}`;
  return { ok: true, body: { kind: values.kind, prefix, from, to, width }, first: number(from), last: number(to), count: to - from + 1 };
}

/** One sentence about the tank step of an Odoo sync. */
export function tankSyncSummary(result: TankSyncResult | undefined): string {
  if (!result) return "Server belum menyalin tangki dari Odoo.";
  if (result.status === "SKIPPED") return "Tangki tidak disalin: lokasi induk tangki di Odoo belum diatur di server.";
  const parts = [`${result.written} tangki baru atau berubah`];
  if (result.deactivated > 0) parts.push(`${result.deactivated} dinonaktifkan karena tidak ada lagi di Odoo`);
  if (result.skipped > 0) parts.push(`${result.skipped} dilewati karena kodenya sudah dipakai`);
  return `Tangki dari Odoo: ${parts.join(", ")}.`;
}
