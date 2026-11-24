// Values, checks and request bodies of the master data forms. Form state is
// kept as strings (what the inputs hold); the payload builders turn it into
// the types the API expects.

import { plateDisplay, plateError } from "@/lib/plate";

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

const text = (value: string): string => value.trim();

// --- drivers ----------------------------------------------------------------

/** Licence classes offered in the form. The API contract does not list them. */
export const LICENCE_CLASSES = ["A", "A UMUM", "B1", "B1 UMUM", "B2", "B2 UMUM"] as const;

export interface DriverValues {
  fullName: string;
  licenceNo: string;
  licenceClass: string;
  licenceValidUntil: string;
  phone: string;
}

export const EMPTY_DRIVER: DriverValues = {
  fullName: "",
  licenceNo: "",
  licenceClass: "",
  licenceValidUntil: "",
  phone: "",
};

export function validateDriver(values: DriverValues): FieldErrors<DriverValues> {
  const errors: FieldErrors<DriverValues> = {};
  if (!text(values.fullName)) errors.fullName = "Isi nama supir.";
  if (!text(values.licenceNo)) errors.licenceNo = "Isi nomor SIM.";
  if (!values.licenceClass) errors.licenceClass = "Pilih jenis SIM.";
  if (!values.licenceValidUntil) errors.licenceValidUntil = "Isi tanggal berlaku SIM.";
  if (text(values.phone) && !/^\+?[\d\s-]{6,20}$/.test(text(values.phone))) {
    errors.phone = "Nomor telepon hanya berisi angka, spasi, tanda tambah, dan tanda hubung.";
  }
  return errors;
}

export function driverPayload(values: DriverValues): Record<string, string> {
  const payload: Record<string, string> = {
    fullName: text(values.fullName),
    licenceNo: text(values.licenceNo).toUpperCase(),
    licenceClass: values.licenceClass,
    licenceValidUntil: values.licenceValidUntil,
  };
  if (text(values.phone)) payload.phone = text(values.phone);
  return payload;
}

// --- vehicles ---------------------------------------------------------------

export interface VehicleValues {
  plateDisplay: string;
  vehicleTypeCode: string;
  ownerPartnerId: string;
  ownership: string;
  capacityKg: string;
  productionYear: string;
  tareKg: string;
  tareReason: string;
  stnkValidUntil: string;
  taxValidUntil: string;
  kirValidUntil: string;
  isActive: boolean;
}

export const EMPTY_VEHICLE: VehicleValues = {
  plateDisplay: "",
  vehicleTypeCode: "",
  ownerPartnerId: "",
  ownership: "",
  capacityKg: "",
  productionYear: "",
  tareKg: "",
  tareReason: "",
  stnkValidUntil: "",
  taxValidUntil: "",
  kirValidUntil: "",
  isActive: true,
};

/** What the form needs to know about the vehicle being edited. */
export interface VehicleOriginal {
  tareKg: number | string | null;
}

const WHOLE_NUMBER_ERROR = "Isi angka bulat lebih dari nol, tanpa titik atau koma.";

function positiveWhole(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed > 0 ? parsed : null;
}

/** True when an existing vehicle gets a different tare than it had. */
export function tareChanged(values: VehicleValues, original: VehicleOriginal | null): boolean {
  if (!original) return false;
  const before = original.tareKg === null || original.tareKg === "" ? null : Number(original.tareKg);
  const after = values.tareKg.trim() === "" ? null : Number(values.tareKg.trim());
  return before !== after;
}

export function validateVehicle(
  values: VehicleValues,
  original: VehicleOriginal | null,
  currentYear: number,
): FieldErrors<VehicleValues> {
  const errors: FieldErrors<VehicleValues> = {};

  const plate = plateError(values.plateDisplay);
  if (plate) errors.plateDisplay = plate;

  if (values.capacityKg.trim() && positiveWhole(values.capacityKg) === null) errors.capacityKg = WHOLE_NUMBER_ERROR;
  if (values.tareKg.trim() && positiveWhole(values.tareKg) === null) errors.tareKg = WHOLE_NUMBER_ERROR;

  if (values.productionYear.trim()) {
    const year = positiveWhole(values.productionYear);
    // Next year's model can already be on the road, nothing later.
    const latest = currentYear + 1;
    if (year === null || year < 1900 || year > latest) {
      errors.productionYear = `Isi tahun dengan empat angka, paling akhir ${latest}.`;
    }
  }

  if (tareChanged(values, original) && !text(values.tareReason)) {
    errors.tareReason = "Isi alasan perubahan tarra.";
  }
  return errors;
}

export function vehiclePayload(values: VehicleValues, original: VehicleOriginal | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    plateDisplay: plateDisplay(values.plateDisplay),
    vehicleTypeCode: values.vehicleTypeCode || null,
    ownerPartnerId: values.ownerPartnerId || null,
    ownership: values.ownership || null,
    capacityKg: positiveWhole(values.capacityKg),
    productionYear: positiveWhole(values.productionYear),
    tareKg: positiveWhole(values.tareKg),
    stnkValidUntil: values.stnkValidUntil || null,
    taxValidUntil: values.taxValidUntil || null,
    kirValidUntil: values.kirValidUntil || null,
  };
  if (original) {
    payload.isActive = values.isActive;
    if (tareChanged(values, original)) payload.tareReason = text(values.tareReason);
  }
  return payload;
}
