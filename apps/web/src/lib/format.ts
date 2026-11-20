// Display helpers. Numbers follow Indonesian grouping (1.000.000 and 0,3).
// Dates read as "20 Nov 2026". Timestamps are shown in plant time (WIB) so
// every screen agrees, whatever the device clock says.

export const PLANT_TIME_ZONE = "Asia/Jakarta";

const EMPTY = "-";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"] as const;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

type Numeric = number | string | null | undefined;

function toNumber(value: Numeric): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const numberFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });
const oneDecimalFormat = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

export function formatNumber(value: Numeric): string {
  const parsed = toNumber(value);
  return parsed === null ? EMPTY : numberFormat.format(parsed);
}

export function formatQuantity(value: Numeric, uom: string | null | undefined): string {
  const parsed = toNumber(value);
  if (parsed === null) return EMPTY;
  const unit = uom?.trim();
  return unit ? `${numberFormat.format(parsed)} ${unit}` : numberFormat.format(parsed);
}

export function formatPercent(value: Numeric): string {
  const parsed = toNumber(value);
  return parsed === null ? EMPTY : `${numberFormat.format(parsed)}%`;
}

interface DateParts {
  day: number;
  month: number;
  year: number;
  hour: string;
  minute: string;
}

function partsInZone(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: Number(pick("day")),
    month: Number(pick("month")),
    year: Number(pick("year")),
    hour: pick("hour"),
    minute: pick("minute"),
  };
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function writeDate(day: number, month: number, year: number): string {
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** "20 Nov 2026". A date-only value is printed as written, with no zone shift. */
export function formatDate(value: string | null | undefined, timeZone: string = PLANT_TIME_ZONE): string {
  if (!value) return EMPTY;
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return EMPTY;
    return writeDate(day, month, Number(dateOnly[1]));
  }
  const date = parseTimestamp(value);
  if (!date) return EMPTY;
  const parts = partsInZone(date, timeZone);
  return writeDate(parts.day, parts.month, parts.year);
}

/** "20 Nov 2026 10.15". */
export function formatDateTime(value: string | null | undefined, timeZone: string = PLANT_TIME_ZONE): string {
  const date = parseTimestamp(value);
  if (!date) return EMPTY;
  const parts = partsInZone(date, timeZone);
  return `${writeDate(parts.day, parts.month, parts.year)} ${parts.hour}.${parts.minute}`;
}

/** "850 ms" below one second, "2,4 detik" from one second up. */
export function formatDuration(ms: number | null | undefined): string {
  const parsed = toNumber(ms);
  if (parsed === null) return EMPTY;
  if (parsed < 1000) return `${Math.round(parsed)} ms`;
  return `${oneDecimalFormat.format(parsed / 1000)} detik`;
}
