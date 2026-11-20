// Odoo sends `false` for every empty field, a many2one as [id, "display name"], a datetime as
// "YYYY-MM-DD HH:MM:SS" in UTC and a date as "YYYY-MM-DD". These helpers turn them into plain values.

export function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Zero stays zero; only `false` (or anything that is not a number) is empty. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function many2one(value: unknown): { id: number; name: string } | null {
  if (!Array.isArray(value) || typeof value[0] !== "number") return null;
  return { id: value[0], name: typeof value[1] === "string" ? value[1] : "" };
}

/** The date part of a date or a datetime, as Odoo sent it. */
export function datePart(value: unknown): string | null {
  const text = textOrNull(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}
