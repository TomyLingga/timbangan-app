// How the files of a delivery order and the weighbridge slips of a truck are shown. Kept apart from the routes so
// the trip view can list slips without importing the routes.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { deliveryOrderFiles, files, tripFiles, users } from "../db/schema.js";

export const SLIP_LABEL = "SLIP_TIMBANG";

export interface AttachedFile {
  id: number;
  label: string | null;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  addedAt: Date | null;
  addedBy: { id: number; fullName: string } | null;
}

/** The files of these delivery orders, oldest link first. */
export async function deliveryOrderFilesOf(orm: Orm, deliveryOrderId: number): Promise<AttachedFile[]> {
  const rows = await orm
    .select({ link: deliveryOrderFiles, file: files, fullName: users.fullName })
    .from(deliveryOrderFiles)
    .innerJoin(files, eq(files.id, deliveryOrderFiles.fileId))
    .innerJoin(users, eq(users.id, deliveryOrderFiles.addedBy))
    .where(eq(deliveryOrderFiles.deliveryOrderId, deliveryOrderId))
    .orderBy(asc(deliveryOrderFiles.addedAt), asc(deliveryOrderFiles.fileId));
  return rows.map(({ link, file, fullName }) => ({
    id: file.id,
    label: link.label,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    addedAt: link.addedAt,
    addedBy: { id: link.addedBy, fullName },
  }));
}

/** The weighbridge slips of these trips, per trip, oldest first. */
export async function tripSlipsOf(orm: Orm, tripIds: number[]): Promise<Map<number, AttachedFile[]>> {
  const found = new Map<number, AttachedFile[]>();
  if (tripIds.length === 0) return found;
  const rows = await orm
    .select({ link: tripFiles, file: files, fullName: users.fullName })
    .from(tripFiles)
    .innerJoin(files, eq(files.id, tripFiles.fileId))
    .leftJoin(users, eq(users.id, tripFiles.addedBy))
    .where(and(inArray(tripFiles.tripId, tripIds), eq(tripFiles.label, SLIP_LABEL)))
    .orderBy(asc(tripFiles.addedAt), asc(tripFiles.fileId));
  for (const { link, file, fullName } of rows) {
    const list = found.get(link.tripId) ?? [];
    list.push({
      id: file.id,
      label: link.label,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      addedAt: link.addedAt,
      addedBy: link.addedBy !== null && fullName !== null ? { id: link.addedBy, fullName } : null,
    });
    found.set(link.tripId, list);
  }
  return found;
}

