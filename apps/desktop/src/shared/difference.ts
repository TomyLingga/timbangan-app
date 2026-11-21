// The "Selisih" panel: the figures on the letters next to the figures weighed here, and the difference of each
// pair as soon as both sides exist. Weighed figures come from the trip (saved weighings); the stage being weighed
// takes the live weight until it is saved. Net is gross minus tare. Pure.

export interface DifferenceRow {
  doc: number | null;
  weighed: number | null;
  /** weighed minus doc, in kilograms. */
  diffKg: number | null;
  /** diffKg as a percentage of doc, two decimals; null against a zero or missing doc. */
  diffPct: number | null;
}

export interface Difference {
  gross: DifferenceRow;
  tare: DifferenceRow;
  net: DifferenceRow;
}

export interface LetterFigures {
  docGrossKg: number | null;
  docTareKg: number | null;
  docNetKg: number | null;
}

export interface WeighedFigures {
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
}

function row(doc: number | null, weighed: number | null): DifferenceRow {
  const diffKg = doc !== null && weighed !== null ? weighed - doc : null;
  const diffPct = diffKg !== null && doc !== null && doc > 0 ? Math.round((diffKg / doc) * 10_000) / 100 : null;
  return { doc, weighed, diffKg, diffPct };
}

export function computeDifference(letters: LetterFigures, trip: WeighedFigures, live: { kind: "GROSS" | "TARE"; weightKg: number | null } | null): Difference {
  const liveKg = live && live.weightKg !== null && live.weightKg > 0 ? live.weightKg : null;
  const gross = trip.grossKg ?? (live?.kind === "GROSS" ? liveKg : null);
  const tare = trip.tareKg ?? (live?.kind === "TARE" ? liveKg : null);
  const net = trip.netKg ?? (gross !== null && tare !== null ? gross - tare : null);
  return { gross: row(letters.docGrossKg, gross), tare: row(letters.docTareKg, tare), net: row(letters.docNetKg, net) };
}
