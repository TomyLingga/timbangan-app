// A partner account made by the admin on the Pengguna page (POST /api/admin/users, apps/api src/users/routes.ts).
// Mills (PKS) that sell through a trader are not in Odoo (owner, 26 November 2026): a mill comes into the system with
// its first account, so the form takes either a company that is already there or the name of a new mill. The API
// makes the new mill and the account in one transaction: a refused account leaves no mill behind.

import { isApiError } from "@/lib/api-client";
import { errorMessage } from "@/lib/messages";
import type { PartnerRef } from "@/lib/types";
import type { FormErrors } from "@/lib/workflow-forms";

/** "existing": a company already in the system; "new": a mill typed here, made a supplier. */
export type CompanyChoice = "existing" | "new";

export interface PartnerAccountValues {
  choice: CompanyChoice;
  partner: PartnerRef | null;
  newName: string;
  newAddress: string;
  username: string;
  fullName: string;
  password: string;
}

export const EMPTY_PARTNER_ACCOUNT: PartnerAccountValues = {
  choice: "new",
  partner: null,
  newName: "",
  newAddress: "",
  username: "",
  fullName: "",
  password: "",
};

/** MIN_PASSWORD_LENGTH in apps/api src/users/create-user.ts. */
export const MIN_PASSWORD_LENGTH = 8;
const USERNAME = /^[A-Za-z0-9._-]{3,60}$/;

export function validatePartnerAccount(values: PartnerAccountValues): FormErrors {
  const errors: FormErrors = {};
  if (values.choice === "existing" && !values.partner) errors.partner = "Pilih perusahaan.";
  if (values.choice === "new") {
    const name = values.newName.trim();
    if (name.length < 2 || name.length > 200) errors.newName = "Isi nama PKS, 2 sampai 200 huruf.";
    if (values.newAddress.trim().length > 500) errors.newAddress = "Alamat paling banyak 500 huruf.";
  }
  if (!USERNAME.test(values.username.trim())) errors.username = "Username 3 sampai 60 huruf, angka, titik, garis bawah, atau tanda minus.";
  const fullName = values.fullName.trim();
  if (fullName.length < 2 || fullName.length > 200) errors.fullName = "Isi nama lengkap pemakai akun.";
  if (values.password.length < MIN_PASSWORD_LENGTH) errors.password = `Kata sandi paling sedikit ${MIN_PASSWORD_LENGTH} karakter.`;
  return errors;
}

/** The body of POST /api/admin/users. */
export function partnerAccountPayload(values: PartnerAccountValues): Record<string, unknown> {
  const body: Record<string, unknown> = { username: values.username.trim(), fullName: values.fullName.trim(), password: values.password };
  if (values.choice === "existing") body.partnerId = values.partner?.id;
  else body.newPartner = { name: values.newName.trim(), ...(values.newAddress.trim() ? { address: values.newAddress.trim() } : {}) };
  return body;
}

/** Form field of an API field path of POST /api/admin/users. */
const FIELDS: Record<string, string> = {
  username: "username",
  fullName: "fullName",
  password: "password",
  partnerId: "partner",
  "newPartner.name": "newName",
  "newPartner.address": "newAddress",
};

export function partnerAccountFieldErrors(error: unknown): FormErrors {
  if (!isApiError(error)) return {};
  return Object.fromEntries(Object.entries(error.fieldMessages).map(([path, message]) => [FIELDS[path] ?? path, message]));
}

/** The mill name the API found already there (PARTNER_EXISTS), to pick it instead; null otherwise. */
export function existingPartnerOf(error: unknown, typedName: string): PartnerRef | null {
  if (!isApiError(error) || error.code !== "PARTNER_EXISTS") return null;
  const id = error.details.partnerId;
  return typeof id === "string" || typeof id === "number" ? { id, name: typedName.trim() } : null;
}

export function partnerAccountErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "USERNAME_TAKEN") return "Username ini sudah dipakai akun lain. Pilih username lain.";
    if (error.code === "PARTNER_EXISTS") return "PKS dengan nama ini sudah ada. Perusahaannya sudah dipilih di bawah; simpan lagi untuk membuat akunnya.";
    if (error.code === "VALIDATION" || error.status === 400) return "Ada isian yang belum benar. Periksa tanda merah di formulir.";
  }
  return errorMessage(error);
}
