// Pieces the list and write routes share: query parameters, text search, today's date at the plant.
import { z } from "zod";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

const LIMIT_MESSAGE = "Limit harus angka mulai dari 1.";
/** `limit` of a list: 20 when absent, never more than 50. */
export const limitParam = z.coerce
  .number(LIMIT_MESSAGE)
  .int(LIMIT_MESSAGE)
  .min(1, LIMIT_MESSAGE)
  .default(DEFAULT_LIMIT)
  .transform((value) => Math.min(value, MAX_LIMIT));

/** `q` of a list: a search word. */
export const searchParam = z.string().trim().max(100, "Kata pencarian terlalu panjang.").optional();

const ID_MESSAGE = "Id tidak valid.";
export const idNumber = z.coerce.number(ID_MESSAGE).int(ID_MESSAGE).positive(ID_MESSAGE);
/** `:id` in a path. */
export const idParams = z.object({ id: idNumber });

/** A date as "YYYY-MM-DD". */
export const dateText = (label: string) => z.iso.date(`${label} harus berformat YYYY-MM-DD.`);

/** `%`, `_` and `\` in a search word are text, not LIKE wildcards. */
export const likeText = (word: string) => `%${word.replace(/[\\%_]/g, "\\$&")}%`;

/** The plant's time zone: "today" for a validity date is the date there. */
export const PLANT_TIME_ZONE = "Asia/Jakarta";
export const todayAtPlant = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TIME_ZONE }).format(now);

/** Upper-case letters and digits only: the stored form of a plate or a licence number. */
export const lettersAndDigits = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
