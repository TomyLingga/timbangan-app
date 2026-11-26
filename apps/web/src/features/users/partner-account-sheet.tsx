"use client";

import { useState } from "react";

import { TextAreaField, TextField } from "@/components/form-fields";
import { FormSheet } from "@/components/form-sheet";
import { PartnerLookup } from "@/components/partner-lookup";
import { Segmented } from "@/components/segmented";
import { useAction } from "@/hooks/use-form";
import {
  EMPTY_PARTNER_ACCOUNT,
  existingPartnerOf,
  MIN_PASSWORD_LENGTH,
  partnerAccountErrorMessage,
  partnerAccountFieldErrors,
  partnerAccountPayload,
  validatePartnerAccount,
  type CompanyChoice,
  type PartnerAccountValues,
} from "@/lib/partner-accounts";
import { api } from "@/lib/session";
import type { AdminUser, PartnerRole } from "@/lib/types";
import type { FormErrors } from "@/lib/workflow-forms";

const CHOICES: ReadonlyArray<{ value: CompanyChoice; label: string }> = [
  { value: "new", label: "PKS baru" },
  { value: "existing", label: "Perusahaan yang ada" },
];
const ROLES: ReadonlyArray<{ value: PartnerRole; label: string }> = [
  { value: "supplier", label: "Supplier" },
  { value: "transporter", label: "Transporter" },
  { value: "customer", label: "Customer" },
];

/**
 * A partner account: for a company already in the system, or for a new mill (PKS) that comes in with its first
 * account. Mills that sell through a trader are not in Odoo, so this is where they are added.
 */
export function PartnerAccountSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (account: AdminUser, newMill: boolean) => void }) {
  const [values, setValues] = useState<PartnerAccountValues>(EMPTY_PARTNER_ACCOUNT);
  const [role, setRole] = useState<PartnerRole>("supplier");
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();

  const set = <K extends keyof PartnerAccountValues>(name: K, value: PartnerAccountValues[K]) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: "" } : current));
  };

  async function handleSubmit() {
    const found = validatePartnerAccount(values);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    const outcome = await save.run(() => api.request<{ user: AdminUser }>("/api/admin/users", { method: "POST", body: partnerAccountPayload(values) }));
    if (outcome.ok) {
      onSaved(outcome.value.user, values.choice === "new");
      return;
    }
    // the mill is already there: pick it, so that saving again makes only the account
    const existing = existingPartnerOf(outcome.error, values.newName);
    if (existing) {
      setRole("supplier");
      setValues((current) => ({ ...current, choice: "existing", partner: existing }));
    }
    setErrors(partnerAccountFieldErrors(outcome.error));
    setFormError(partnerAccountErrorMessage(outcome.error));
  }

  return (
    <FormSheet
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Akun partner baru"
      description="PKS yang belum ada di sistem dibuat bersama akun pertamanya. Akun karyawan tidak dibuat di sini: karyawan masuk lewat portal."
      submitLabel="Buat akun"
      pending={save.pending}
      error={formError}
      onSubmit={handleSubmit}
    >
      <Segmented label="Perusahaan akun" options={CHOICES} value={values.choice} onChange={(choice) => set("choice", choice)} />
      {values.choice === "new" ? (
        <>
          <TextField label="Nama PKS" name="newPartnerName" value={values.newName} onChange={(value) => set("newName", value)} error={errors.newName} hint="Ditulis seperti di surat pengantar PKS." />
          <TextAreaField label="Alamat PKS" name="newPartnerAddress" optional rows={2} value={values.newAddress} onChange={(value) => set("newAddress", value)} error={errors.newAddress} />
        </>
      ) : (
        <>
          <Segmented label="Jenis perusahaan" options={ROLES} value={role} onChange={(next) => { setRole(next); set("partner", null); }} />
          <PartnerLookup
            role={role}
            label="Perusahaan"
            name="accountPartnerLookup"
            placeholder="Cari nama perusahaan"
            value={values.partner}
            onChange={(partner) => set("partner", partner)}
            error={errors.partner}
          />
        </>
      )}
      <TextField label="Nama lengkap pemakai" name="accountFullName" value={values.fullName} onChange={(value) => set("fullName", value)} error={errors.fullName} />
      <TextField label="Username" name="accountUsername" autoCapitalize="none" value={values.username} onChange={(value) => set("username", value)} error={errors.username} />
      <TextField
        label="Kata sandi awal"
        name="accountPassword"
        type="password"
        autoComplete="new-password"
        value={values.password}
        onChange={(value) => set("password", value)}
        error={errors.password}
        hint={`Paling sedikit ${MIN_PASSWORD_LENGTH} karakter. Sampaikan ke pemakai lewat jalur yang aman.`}
      />
    </FormSheet>
  );
}
