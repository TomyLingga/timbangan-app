// Wording for the driver registry (VCF): whether a driver entered here still
// has to be sent there, and what a sync from it did.

import { formatDuration, formatNumber } from "@/lib/format";
import type { StatusInfo } from "@/lib/status";
import type { Driver, VcfSyncResult } from "@/lib/types";

const PUSH_STATES: Record<string, StatusInfo | null> = {
  pending: { label: "Menunggu dikirim ke VCF", tone: "warning" },
  failed: { label: "Gagal dikirim ke VCF", tone: "destructive" },
  sent: null,
  none: null,
};

/** Indicator for a driver that is waiting to be sent or could not be sent; null when nothing is waiting. */
export function registryPushInfo(push: string | null | undefined): StatusInfo | null {
  const key = push?.trim().toLowerCase();
  if (!key) return null;
  return key in PUSH_STATES ? PUSH_STATES[key] : { label: push as string, tone: "neutral" };
}

/** One paragraph after "Ambil dari VCF": how long, what came in, what went out. */
export function vcfSyncSummary(result: VcfSyncResult): string {
  const parts = [
    `Selesai dalam ${formatDuration(result.durationMs)}.`,
    `Diambil dari VCF: ${formatNumber(result.drivers)} supir, ${formatNumber(result.transporters)} transporter.`,
  ];
  if (result.skipped > 0) parts.push(`Dilewati: ${formatNumber(result.skipped)}.`);

  const pushed = result.pushed ?? null;
  const pushFailed = result.pushFailed ?? null;
  if (pushed !== null || pushFailed !== null) {
    const sent = pushed ?? 0;
    const failed = pushFailed ?? 0;
    if (sent === 0 && failed === 0) {
      parts.push("Tidak ada supir yang perlu dikirim ke VCF.");
    } else {
      parts.push(`Dikirim ke VCF: ${formatNumber(sent)} supir, gagal ${formatNumber(failed)}.`);
    }
  }
  if (result.pushStopped) parts.push("Pengiriman ke VCF berhenti sebelum semua supir terkirim.");
  return parts.join(" ");
}

/** Notice after "Supir baru" is saved, built from the push state the server returned. */
export function driverSavedMessage(driver: Driver): string {
  const push = driver.registryPush?.trim().toUpperCase();
  if (push === "PENDING") return `Supir ${driver.fullName} ditambahkan dan menunggu dikirim ke VCF.`;
  if (push === "SENT") return `Supir ${driver.fullName} ditambahkan dan sudah dikirim ke VCF.`;
  if (push === "FAILED") {
    const reason = driver.registryPushError?.trim();
    const base = `Supir ${driver.fullName} ditambahkan, tetapi gagal dikirim ke VCF.`;
    return reason ? `${base} Pesan server: ${reason}` : base;
  }
  return `Supir ${driver.fullName} ditambahkan.`;
}
