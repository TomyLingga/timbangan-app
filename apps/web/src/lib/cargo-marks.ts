// Close cargo and flexi bag of an outgoing truck. The operator of the registration post marks both when the truck
// checks in (API migration 0015); the net weight check at the second weighing depends on them. A bulk outgoing
// truck (flow OUT_BULK) cannot check in without the two answers; other flows do not ask.

export type YesNo = "" | "yes" | "no";

export interface CargoMarkValues {
  closeCargo: YesNo;
  flexiBag: YesNo;
}

export const NO_MARKS: CargoMarkValues = { closeCargo: "", flexiBag: "" };

/** Whether POST /api/gate/check-in refuses this truck without the two marks. */
export function needsCargoMarks(trip: { flowCode: string }): boolean {
  return trip.flowCode === "OUT_BULK";
}

export const yesNoOf = (value: boolean | null | undefined): YesNo => (value === null || value === undefined ? "" : value ? "yes" : "no");

/** The marks a truck already carries: answers of an older registration, or of an earlier check-in. */
export function marksOf(trip: { closeCargo?: boolean | null; flexiBag?: boolean | null }): CargoMarkValues {
  return { closeCargo: yesNoOf(trip.closeCargo), flexiBag: yesNoOf(trip.flexiBag) };
}

export const marksComplete = (marks: CargoMarkValues): boolean => marks.closeCargo !== "" && marks.flexiBag !== "";

/** A message per mark that is still open, keyed like the fields of the API. */
export function cargoMarkErrors(marks: CargoMarkValues): Partial<Record<keyof CargoMarkValues, string>> {
  const errors: Partial<Record<keyof CargoMarkValues, string>> = {};
  if (!marks.closeCargo) errors.closeCargo = "Pilih ya atau tidak.";
  if (!marks.flexiBag) errors.flexiBag = "Pilih ya atau tidak.";
  return errors;
}

/** The two answers as the API takes them; an open mark is left out. */
export function cargoMarkPayload(marks: CargoMarkValues): { closeCargo?: boolean; flexiBag?: boolean } {
  return {
    ...(marks.closeCargo ? { closeCargo: marks.closeCargo === "yes" } : {}),
    ...(marks.flexiBag ? { flexiBag: marks.flexiBag === "yes" } : {}),
  };
}

/** How a mark reads in a list: "Ya", "Tidak", or that the post has not marked the truck yet. */
export function cargoMarkText(value: boolean | null | undefined): string {
  return value === null || value === undefined ? "belum ditandai" : value ? "Ya" : "Tidak";
}
