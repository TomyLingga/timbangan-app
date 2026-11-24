// Surat jalan (SPJ): one active document per trip, with a random barcode token.
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { drivers, spjDocuments, trips, vehicles } from "../db/schema.js";
import { replaceShareLink } from "../gps/share.js";
import { nextDocumentNo } from "../numbering.js";
import { readSetting, siteById } from "../settings.js";

/** Crockford base32: digits and letters without I, L, O and U. The table's check constraint wants this set. */
export const TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TOKEN_LENGTH = 12;
const DEFAULT_VALID_DAYS = 7;
const DAY_MS = 86_400_000;

/** 12 characters from the cryptographic random generator; 32 symbols, so the low 5 bits of a byte are uniform. */
export function newBarcodeToken(): string {
  return Array.from(randomBytes(TOKEN_LENGTH), (byte) => TOKEN_ALPHABET[byte & 31]).join("");
}

/** What a scanner or a person typed, as stored: upper case, no separators, I and L read as 1, O as 0. */
export const normaliseToken = (text: string) => text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

/**
 * Issues an SPJ for the trip: freezes plate, driver name and licence on the trip, sets it ISSUED, and writes
 * the document with a new number and token. A previous active SPJ must have been revoked first.
 */
export async function issueSpj(orm: Orm, tripId: number, actor: number, now: Date): Promise<void> {
  const [trip] = await orm
    .select({ siteId: trips.siteId, plateNo: vehicles.plateNo, driverName: drivers.fullName, licenceNo: drivers.licenceNo })
    .from(trips)
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .where(eq(trips.id, tripId));
  if (!trip) throw new Error(`Trip ${tripId} does not exist.`);
  const site = await siteById(orm, trip.siteId);
  const days = Number((await readSetting(orm, site.id, "spj_valid_days")) ?? DEFAULT_VALID_DAYS);
  const validUntil = new Date(now.getTime() + (Number.isFinite(days) && days > 0 ? days : DEFAULT_VALID_DAYS) * DAY_MS);
  await orm
    .update(trips)
    .set({ status: "ISSUED", plateNo: trip.plateNo, driverName: trip.driverName, licenceNo: trip.licenceNo, updatedAt: now })
    .where(eq(trips.id, tripId));
  await orm.insert(spjDocuments).values({
    tripId,
    spjNo: await nextDocumentNo(orm, "SPJ", site.code, now),
    barcodeToken: newBarcodeToken(),
    issuedBy: actor,
    issuedAt: now,
    validUntil,
  });
  // the driver's location-sharing link printed with it; a reissue replaces the old one
  await replaceShareLink(orm, tripId, actor, now);
}

/** Revokes the active SPJ of the trip, if there is one. */
export async function revokeSpj(orm: Orm, tripId: number, actor: number, now: Date, reason: string): Promise<void> {
  await orm
    .update(spjDocuments)
    .set({ revokedAt: now, revokedBy: actor, revokeReason: reason })
    .where(and(eq(spjDocuments.tripId, tripId), isNull(spjDocuments.revokedAt)));
}
