// Verification of a vehicle (POST /api/vehicles/:id/verify and /unverify, staff with vehicles EDIT). While a vehicle
// is not verified its master tare is not the reference of the tare check (apps/api src/weighing/checks.ts TARE_OUT),
// so the tare weighing of an outgoing truck always raises a decision, and a registration with it gets the finding
// VEHICLE_UNVERIFIED (apps/api src/registrations/checks.ts).

import { formatQuantity } from "@/lib/format";

/** One line for the badge, the filter and the tare column. */
export const UNVERIFIED_NOTE =
  "Tarra master kendaraan yang belum diverifikasi tidak dipakai sebagai acuan, jadi timbang tarra truk outgoing-nya selalu meminta keputusan.";

/** The filter in the address bar: "" for every vehicle, "belum" for the unverified ones. */
export type VerificationFilter = "" | "belum";

export const VERIFICATION_FILTERS: ReadonlyArray<{ value: VerificationFilter; label: string }> = [
  { value: "", label: "Semua" },
  { value: "belum", label: "Belum diverifikasi" },
];

interface Verifiable {
  plateDisplay: string;
  verified: boolean;
  tareKg: number | string | null;
}

/**
 * The rows to show and the chip counts. GET /api/vehicles has no verification filter, so the filter works on the
 * vehicles of the loaded page; `partial` says the server holds more than that page.
 */
export function verificationView<T extends Verifiable>(items: readonly T[], total: number, filter: string): { rows: T[]; counts: Record<VerificationFilter, number>; partial: boolean } {
  const unverified = items.filter((item) => !item.verified);
  return {
    rows: filter === "belum" ? unverified : [...items],
    counts: { "": total, belum: unverified.length },
    partial: total > items.length,
  };
}

/** Texts of the confirmation, which names the plate. */
export function verificationText(vehicle: Verifiable, verify: boolean): { title: string; description: string; submitLabel: string; done: string } {
  if (verify) {
    return {
      title: `Verifikasi ${vehicle.plateDisplay}`,
      description:
        vehicle.tareKg === null || vehicle.tareKg === ""
          ? "Kendaraan ini belum punya tarra master, jadi timbang tarra truk outgoing tetap meminta keputusan sampai tarra diisi. Registrasi berikutnya dengan kendaraan ini tidak lagi diberi catatan belum diverifikasi."
          : `Setelah diverifikasi, tarra master ${formatQuantity(vehicle.tareKg, "Kg")} dipakai sebagai acuan timbang tarra truk outgoing, dan registrasi berikutnya dengan kendaraan ini tidak lagi diberi catatan belum diverifikasi.`,
      submitLabel: "Verifikasi",
      done: `Kendaraan ${vehicle.plateDisplay} diverifikasi.`,
    };
  }
  return {
    title: `Batalkan verifikasi ${vehicle.plateDisplay}`,
    description:
      "Tarra master kendaraan ini tidak lagi dipakai sebagai acuan, jadi timbang tarra truk outgoing berikutnya meminta keputusan. Registrasi berikutnya dengan kendaraan ini diberi catatan belum diverifikasi.",
    submitLabel: "Batalkan verifikasi",
    done: `Verifikasi kendaraan ${vehicle.plateDisplay} dibatalkan.`,
  };
}
