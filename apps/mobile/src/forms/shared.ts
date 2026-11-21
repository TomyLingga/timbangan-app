// The model every step form shares: the values a form holds, the fields it shows (described as data, so one
// renderer draws all forms), validation with Indonesian messages, the request body, and the summary sheet.
// Pure: no React Native imports.

import type { FormData, FormParameter, WorkRow } from "../api/types";
import { decimal, parseDecimal } from "../lib/format";

export interface SealPick {
  id: number;
  sealNo: string;
}

/** One seal named on the letter (or typed), with whether it is intact. */
export interface SealCheckRow {
  sealNo: string;
  intact: boolean | null;
  declared: boolean;
}

/** A seal of an earlier loading still on the truck, to be marked opened before new seals go on. */
export interface OldSealRow {
  tripSealId: number;
  sealNo: string;
  opened: boolean;
  reason: string;
}

export interface Photo {
  uri: string;
  width: number;
  height: number;
}

export type FieldValue = string | boolean | null | (SealPick | null)[] | SealCheckRow[] | OldSealRow[] | Photo[];
export type FormValues = Record<string, FieldValue>;

export type Tone = "ok" | "warn" | "bad" | "plain";

export interface ChoiceOption {
  value: string;
  label: string;
  tone?: Tone;
}

export type Field =
  | { kind: "section"; key: string; title: string; note?: string }
  | { kind: "choice"; key: string; label: string; options: ChoiceOption[]; required: boolean; columns?: number }
  | { kind: "number"; key: string; label: string; unit: string; required: boolean; hint: string }
  | { kind: "text"; key: string; label: string; required: boolean; placeholder: string; maxLength: number }
  | { kind: "tank"; key: string; label: string; required: boolean }
  | { kind: "stockSeals"; key: string; label: string }
  | { kind: "sealCheck"; key: string; label: string }
  | { kind: "oldSeals"; key: string; label: string }
  | { kind: "photos"; key: string; label: string; max: number }
  | { kind: "tick"; key: string; label: string; required: boolean }
  | { kind: "info"; key: string; label: string; value: string };

export type Errors = Record<string, string>;

export interface SummaryRow {
  label: string;
  value: string;
  tone?: Tone;
}

export interface FormContext {
  step: WorkRow;
  form: FormData;
  now: Date;
}

export interface FormDefinition {
  /** The route after /api/work/steps/:id/. */
  route: string;
  title: string;
  /** Text of the send button. */
  submitLabel: string;
  initial(ctx: FormContext): FormValues;
  fields(values: FormValues, ctx: FormContext): Field[];
  validate(values: FormValues, ctx: FormContext): Errors;
  /** The request body without photoFileIds (the queue adds them after the uploads). */
  body(values: FormValues, ctx: FormContext, clientUuid: string): Record<string, unknown>;
  summary(values: FormValues, ctx: FormContext): SummaryRow[];
  photos?(values: FormValues): Photo[];
}

// --- reading values ---

export const text = (values: FormValues, key: string): string => {
  const value = values[key];
  return typeof value === "string" ? value : "";
};
export const choice = (values: FormValues, key: string): string | null => {
  const value = values[key];
  return typeof value === "string" && value !== "" ? value : null;
};
export const flag = (values: FormValues, key: string): boolean => values[key] === true;
export const listOf = <T>(values: FormValues, key: string): T[] => {
  const value = values[key];
  return Array.isArray(value) ? (value as T[]) : [];
};
/** The remark as the API takes it: trimmed, left out when empty. */
export const remarkOf = (values: FormValues, key = "remark"): { remark?: string } => {
  const value = text(values, key).trim();
  return value ? { remark: value } : {};
};

// --- common choices (labels of the old forms) ---

export const OK_NOT_OK: ChoiceOption[] = [
  { value: "OK", label: "OK", tone: "ok" },
  { value: "NOT_OK", label: "Not OK", tone: "bad" },
];
export const ON_OFF: ChoiceOption[] = [
  { value: "ON", label: "On" },
  { value: "OFF", label: "Off" },
];
export const ADA_TIDAK: ChoiceOption[] = [
  { value: "ADA", label: "Ada", tone: "warn" },
  { value: "TIDAK", label: "Tidak Ada", tone: "ok" },
];

export const labelOf = (options: ChoiceOption[], value: string | null) => options.find((option) => option.value === value)?.label ?? "–";
export const toneOf = (options: ChoiceOption[], value: string | null): Tone => options.find((option) => option.value === value)?.tone ?? "plain";

// --- validation helpers ---

export const MESSAGES = {
  choose: "Pilih salah satu.",
  required: "Wajib diisi.",
} as const;

export function requireChoices(values: FormValues, keys: string[], errors: Errors): void {
  for (const key of keys) if (!choice(values, key)) errors[key] = MESSAGES.choose;
}

/** Old labels of the quality figures, where they differ from the parameter name. */
const PARAMETER_LABELS: Record<string, string> = {
  FFA: "FFA",
  MOISTURE: "MOIST",
  IMPURITIES: "IMPURITIES",
  MNI: "M dan I",
};

export const parameterLabel = (parameter: FormParameter, oldLabels: Record<string, string> = PARAMETER_LABELS) =>
  oldLabels[parameter.code] ?? parameter.name;

const rangeText = (parameter: FormParameter) => `${decimal(parameter.minValid, 0)} sampai ${decimal(parameter.maxValid, 0)}`;

/** The fields of quality figures, keyed `value.<CODE>`. */
export function parameterFields(parameters: FormParameter[], oldLabels?: Record<string, string>): Field[] {
  return parameters.map((parameter) => {
    const spec = parameter.spec;
    const specText =
      spec && (spec.min !== null || spec.max !== null)
        ? ` · spek ${spec.min !== null ? `≥ ${decimal(spec.min, parameter.decimals)}` : ""}${spec.min !== null && spec.max !== null ? " dan " : ""}${spec.max !== null ? `≤ ${decimal(spec.max, parameter.decimals)}` : ""}`
        : "";
    return {
      kind: "number",
      key: `value.${parameter.code}`,
      label: parameterLabel(parameter, oldLabels),
      unit: parameter.unit,
      required: parameter.required,
      hint: `Isi ${rangeText(parameter)}${specText}`,
    };
  });
}

/** Checks the figures against their plausibility range; the API refuses the same. */
export function validateParameters(values: FormValues, parameters: FormParameter[], errors: Errors, oldLabels?: Record<string, string>): void {
  for (const parameter of parameters) {
    const key = `value.${parameter.code}`;
    const label = parameterLabel(parameter, oldLabels);
    const parsed = parseDecimal(text(values, key));
    if (parsed === null) {
      if (parameter.required) errors[key] = `${label} wajib diisi.`;
      continue;
    }
    if (Number.isNaN(parsed)) errors[key] = `${label} harus angka, misalnya 3,25.`;
    else if (parsed < parameter.minValid || parsed > parameter.maxValid) errors[key] = `${label} harus antara ${rangeText(parameter)}.`;
    else {
      const decimals = text(values, key).trim().split(/[.,]/)[1]?.length ?? 0;
      if (decimals > parameter.decimals) errors[key] = `${label} paling banyak ${parameter.decimals} angka di belakang koma.`;
    }
  }
}

/** The figures that were filled, by parameter code. */
export function parameterValues(values: FormValues, parameters: FormParameter[]): Record<string, number> {
  const found: Record<string, number> = {};
  for (const parameter of parameters) {
    const parsed = parseDecimal(text(values, `value.${parameter.code}`));
    if (parsed !== null && !Number.isNaN(parsed)) found[parameter.code] = parsed;
  }
  return found;
}

export const outsideSpec = (parameter: FormParameter, value: number) =>
  !!parameter.spec && ((parameter.spec.min !== null && value < parameter.spec.min) || (parameter.spec.max !== null && value > parameter.spec.max));

export function parameterSummary(values: FormValues, parameters: FormParameter[], oldLabels?: Record<string, string>): SummaryRow[] {
  return parameters.flatMap((parameter) => {
    const parsed = parseDecimal(text(values, `value.${parameter.code}`));
    if (parsed === null || Number.isNaN(parsed)) return parameter.required ? [{ label: parameterLabel(parameter, oldLabels), value: "–" }] : [];
    const off = outsideSpec(parameter, parsed);
    return [{
      label: parameterLabel(parameter, oldLabels),
      value: `${decimal(parsed, parameter.decimals)}${parameter.unit ? ` ${parameter.unit}` : ""}${off ? " · di luar spek" : ""}`,
      tone: off ? ("warn" as const) : undefined,
    }];
  });
}

// --- seals from stock ---

export const STOCK_SLOTS = 4;
export const emptySlots = (): (SealPick | null)[] => Array.from({ length: STOCK_SLOTS }, () => null);

/** Seal 1 is required; the same seal may not be chosen twice. */
export function validateStockSeals(values: FormValues, key: string, errors: Errors): void {
  const slots = listOf<SealPick | null>(values, key);
  if (!slots[0]) errors[key] = "No Segel 1 wajib dipilih.";
  const ids = slots.filter((slot): slot is SealPick => !!slot).map((slot) => slot.id);
  if (new Set(ids).size !== ids.length) errors[key] = "Segel yang sama dipilih dua kali.";
}

export const pickedSeals = (values: FormValues, key: string) => listOf<SealPick | null>(values, key).filter((slot): slot is SealPick => !!slot);

export const sealSummary = (values: FormValues, key: string): SummaryRow[] =>
  listOf<SealPick | null>(values, key).flatMap((slot, index) => (slot ? [{ label: `No Segel ${index + 1}`, value: slot.sealNo }] : []));

export const photoSummary = (values: FormValues, key = "photos"): SummaryRow => {
  const count = listOf<Photo>(values, key).length;
  return { label: "Foto", value: count === 0 ? "Tidak ada" : `${count} foto` };
};

export const remarkSummary = (values: FormValues, label: string, key = "remark"): SummaryRow[] => {
  const value = text(values, key).trim();
  return value ? [{ label, value }] : [];
};

export const remarkField = (label: string, placeholder: string, required = false, key = "remark", maxLength = 500): Field => ({
  kind: "text",
  key,
  label,
  required,
  placeholder,
  maxLength,
});
