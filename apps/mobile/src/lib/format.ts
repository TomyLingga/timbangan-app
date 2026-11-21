// Formatting for the screens: kilograms, percent, plates, flows, and times on the plant clock (WIB, UTC+7).

const PLANT_OFFSET_MS = 7 * 60 * 60 * 1000;

/** A typed figure: comma or dot as decimal mark. Null when empty, NaN when it is not a number. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+([.,]\d+)?$/.test(trimmed) && !/^\d+[.,]$/.test(trimmed)) return Number.NaN;
  return Number(trimmed.replace(",", "."));
}

const thousands = (value: number) => Math.round(Math.abs(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export const kg = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${value < 0 ? "−" : ""}${thousands(value)} kg`);

export const signedKg = (value: number | null | undefined) =>
  value === null || value === undefined ? "–" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${thousands(value)} kg`;

export const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "–" : `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(2).replace(".", ",")}%`;

/** A figure with its decimals and the decimal comma. */
export const decimal = (value: number, decimals: number) => value.toFixed(decimals).replace(".", ",");

export const plateOf = (truck: { plateDisplay: string | null; plateNo: string | null }) => truck.plateDisplay ?? truck.plateNo ?? "Tanpa plat";

const FLOWS: Record<string, string> = {
  IN_CPO: "Masuk · CPO",
  IN_GOODS: "Masuk · barang",
  OUT_BULK: "Keluar · curah",
  OUT_PACKED: "Keluar · kemasan",
};
export const flowLabel = (flowCode: string) => FLOWS[flowCode] ?? flowCode;

/** How long ago, in hours and minutes. */
export function readyFor(since: string | null, now: Date = new Date()): string {
  if (!since) return "–";
  const minutes = Math.floor((now.getTime() - new Date(since).getTime()) / 60_000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes} menit`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} jam` : `${hours} jam ${rest} menit`;
}

/** "14.05" on the plant clock. */
export function clockTime(value: string | Date): string {
  const shifted = new Date(new Date(value).getTime() + PLANT_OFFSET_MS);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}.${mm}`;
}
