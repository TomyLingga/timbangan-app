// Attachments: the DO letter on a delivery order and the weighbridge slip ("slip timbang") per truck of an
// incoming registration. The API (apps/api src/files/routes.ts, src/attachments/routes.ts) checks every rule
// again; these helpers decide what the page offers.

import { canCreate, canEdit, canCreateIncoming, isStaff } from "@/lib/permissions";
import type { User } from "@/lib/types";

type MaybeUser = User | null | undefined;

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DO_FILES = 5;
export const MAX_TRIP_SLIPS = 3;
export const ATTACHMENT_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

/** What the browser tells about a chosen file. */
export interface ChosenFile {
  name: string;
  type: string;
  size: number;
}

function kindOf(file: ChosenFile): "pdf" | "image" | null {
  if (file.type === "application/pdf" || (!file.type && /\.pdf$/i.test(file.name))) return "pdf";
  if (IMAGE_TYPES.includes(file.type) || (!file.type && IMAGE_EXTENSIONS.test(file.name))) return "image";
  return null;
}

/** The reason a file cannot be sent, in the words the page shows; null when it may go. */
export function checkAttachment(file: ChosenFile): string | null {
  const kind = kindOf(file);
  if (!kind) return "Pilih berkas PDF atau gambar JPEG, PNG, atau WebP.";
  if (file.size === 0) return "Berkas ini kosong.";
  if (kind === "pdf" && file.size > MAX_PDF_BYTES) return "PDF paling besar 10 MB.";
  if (kind === "image" && file.size > MAX_IMAGE_BYTES) return "Gambar paling besar 5 MB.";
  return null;
}

/** "820 KB", "1,5 MB". */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(mb)} MB`;
}

/** POST and DELETE /api/delivery-orders/:id/files: staff with delivery_orders CREATE, while the DO is DRAFT or SENT. */
export function canChangeDoFiles(user: MaybeUser, order: { status: string }): boolean {
  const status = order.status.toUpperCase();
  return isStaff(user) && canCreate(user, "delivery_orders") && (status === "DRAFT" || status === "SENT");
}

/**
 * POST and DELETE /api/registrations/:id/trips/:tripId/files, incoming only: the supplier on its own draft; staff
 * with registrations EDIT while the registration is a draft, waiting or approved.
 */
export function canChangeSlips(user: MaybeUser, registration: { status: string; direction: "IN" | "OUT" }): boolean {
  if (!user || registration.direction !== "IN") return false;
  const status = registration.status.toUpperCase();
  if (isStaff(user)) return canEdit(user, "registrations") && ["DRAFT", "SUBMITTED", "APPROVED"].includes(status);
  return status === "DRAFT" && canCreateIncoming(user);
}
