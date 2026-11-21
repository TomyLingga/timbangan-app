// How the net weight of a truck is divided over its contracts (incoming) or DOs (outgoing). Whole kilograms;
// the shares always add up to the net.

export type SplitMethod = "SINGLE" | "PROPORTIONAL" | "SEQUENTIAL";

export interface SplitLine {
  seq: number;
  /** Net on the supplier's letter for this contract (incoming). */
  originNetKg: number | null;
  /** What the DO still has to deliver before this truck (outgoing). */
  remaining: number | null;
}

/** Equal shares, the remainder to the last. */
export function splitEqually(net: number, count: number): number[] {
  const each = Math.floor(net / count);
  return Array.from({ length: count }, (_, index) => (index === count - 1 ? net - each * (count - 1) : each));
}

/** In proportion to the weights, rounded to the kilogram; the rounding remainder goes to the last. */
export function splitProportional(net: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return splitEqually(net, weights.length);
  const shares: number[] = [];
  let given = 0;
  for (const [index, weight] of weights.entries()) {
    if (index === weights.length - 1) {
      shares.push(net - given);
      break;
    }
    const share = Math.min(Math.round((net * weight) / total), net - given);
    shares.push(share);
    given += share;
  }
  return shares;
}

/**
 * The line with the smallest remainder is filled first, then the next; the last in that order takes whatever
 * is left. Answers the shares in the order of the input.
 */
export function splitSequential(net: number, remaining: number[]): number[] {
  const order = remaining.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const shares = new Array<number>(remaining.length).fill(0);
  let left = net;
  for (const [position, line] of order.entries()) {
    const share = position === order.length - 1 ? left : Math.min(left, Math.max(line.value, 0));
    shares[line.index] = share;
    left -= share;
  }
  return shares;
}

/** The split the rules give for this direction and these lines (in seq order). */
export function splitNet(direction: "IN" | "OUT", net: number, lines: SplitLine[]): { method: SplitMethod; shares: number[] } {
  if (lines.length === 1) return { method: "SINGLE", shares: [net] };
  if (direction === "IN") {
    const weights = lines.map((line) => line.originNetKg);
    const complete = weights.every((weight): weight is number => weight !== null && weight > 0);
    return { method: "PROPORTIONAL", shares: complete ? splitProportional(net, weights) : splitEqually(net, lines.length) };
  }
  return { method: "SEQUENTIAL", shares: splitSequential(net, lines.map((line) => line.remaining ?? Number.POSITIVE_INFINITY)) };
}
