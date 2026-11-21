// Quantity rules of the registration (docs/fase-3-rancangan.md, section 2).
// The server computes the same numbers; the screens show them before saving.

type Numeric = number | string | null | undefined;

function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Avoids 500.49999 style leftovers when a fraction is carried to the last truck. */
const roundGrams = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Planned quantity per truck: the total split evenly, each share rounded down to
 * the kilogram, and what is left goes to the last truck.
 */
export function splitQuantity(total: number, trucks: number): number[] {
  if (!Number.isFinite(total) || total < 0 || !Number.isInteger(trucks) || trucks < 1) return [];
  const share = Math.floor(total / trucks);
  const shares = Array.from({ length: trucks }, () => share);
  shares[trucks - 1] = roundGrams(total - share * (trucks - 1));
  return shares;
}

/** Shares of several delivery orders on the same trucks: per order, and added up per truck. */
export function planPerTruck(
  orders: ReadonlyArray<{ qty: Numeric }>,
  trucks: number,
): { perOrder: number[][]; perTruck: number[] } {
  const perOrder = orders.map((order) => splitQuantity(toNumber(order.qty) ?? 0, trucks));
  const perTruck = Array.from({ length: Math.max(trucks, 0) }, (_, index) =>
    roundGrams(perOrder.reduce((sum, shares) => sum + (shares[index] ?? 0), 0)),
  );
  return { perOrder, perTruck };
}

export interface LetterWeights {
  originGrossKg: Numeric;
  originTareKg: Numeric;
  originNetKg: Numeric;
}

export interface DocumentTotals {
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
}

/**
 * Weights of the truck taken from its letters (rule of the old system): tare is
 * the smallest origin tare above zero, net is the sum of the origin nets, and
 * gross is the two added. Empty while no net is filled.
 */
export function documentTotals(letters: ReadonlyArray<LetterWeights>): DocumentTotals {
  const nets = letters.map((letter) => toNumber(letter.originNetKg)).filter((value): value is number => value !== null);
  if (nets.length === 0) return { grossKg: null, tareKg: null, netKg: null };
  const netKg = roundGrams(nets.reduce((sum, value) => sum + value, 0));
  const tares = letters
    .map((letter) => toNumber(letter.originTareKg))
    .filter((value): value is number => value !== null && value > 0);
  const tareKg = tares.length > 0 ? Math.min(...tares) : null;
  return { grossKg: tareKg === null ? null : roundGrams(netKg + tareKg), tareKg, netKg };
}

/** A whole, non-negative number of kilograms typed without separators, or null. */
export function wholeKg(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}
