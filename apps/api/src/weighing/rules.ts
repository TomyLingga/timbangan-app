// The weighing rules as pure functions, and the lookup of the exception rule that applies.
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { exceptionRules, type ExceptionType } from "../db/schema.js";
import { lettersAndDigits, todayAtPlant } from "../http.js";

/** Percentages are stored with four decimals; scaling by 10 000 keeps the comparison in whole numbers. */
const PCT_SCALE = 10_000;

/**
 * Whether the weighed figure is outside the tolerance of the reference, as in the old system:
 * `|reference - weighed| / reference > percent / 100`. With a kilogram limit too, meeting either limit passes.
 * Without any limit nothing is checked.
 */
export function exceedsTolerance(reference: number, weighed: number, limits: { pct: number | null; kg: number | null }): boolean {
  if (limits.pct === null && limits.kg === null) return false;
  const diff = Math.abs(reference - weighed);
  const withinPct = limits.pct !== null && reference > 0 && diff * 100 * PCT_SCALE <= Math.round(limits.pct * PCT_SCALE) * reference;
  const withinKg = limits.kg !== null && diff <= limits.kg;
  return !(withinPct || withinKg);
}

/**
 * The tolerance of the gross check of an incoming truck: the rule's percent when it has one, otherwise the
 * smallest contract tolerance above zero. Null when every contract has zero: then nothing is checked.
 */
export function grossTolerance(rulePct: number | null, contractTolerances: number[]): number | null {
  if (rulePct !== null) return rulePct;
  const positive = contractTolerances.filter((value) => value > 0);
  return positive.length ? Math.min(...positive) : null;
}

/** Camera text against the registered plate, both upper case without spaces. No text never matches. */
export function platesMatch(read: string | null, registered: string): boolean {
  if (!read) return false;
  const cleaned = lettersAndDigits(read);
  return cleaned.length > 0 && cleaned === lettersAndDigits(registered);
}

export type ExceptionRule = typeof exceptionRules.$inferSelect;

/** The active rule of this type for the flow (a rule for the flow wins over one for every flow), or null. */
export async function findRule(orm: Orm, siteId: number, type: ExceptionType, flowCode: string, now: Date): Promise<ExceptionRule | null> {
  const [rule] = await orm
    .select()
    .from(exceptionRules)
    .where(
      and(
        eq(exceptionRules.siteId, siteId),
        eq(exceptionRules.type, type),
        eq(exceptionRules.isActive, true),
        or(eq(exceptionRules.flowCode, flowCode), isNull(exceptionRules.flowCode)),
        lte(exceptionRules.validFrom, todayAtPlant(now)),
      ),
    )
    .orderBy(sql`${exceptionRules.flowCode} is null`, desc(exceptionRules.validFrom))
    .limit(1);
  return rule ?? null;
}
