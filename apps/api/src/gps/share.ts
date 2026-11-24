// The link a driver opens from the SPJ to share the phone's location for one trip. The token is 128 bits derived from
// the link's row id with a server secret (HMAC-SHA256), so the SPJ can be printed again with the same QR code; the
// table keeps only the SHA-256 of the token, filled the first time the token is shown. Issuing or reissuing the SPJ
// revokes the old link and makes a new one.
import { createHash, createHmac } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { tripShareLinks } from "../db/schema.js";

/** The page of the web application the QR code opens. */
export const SHARE_PAGE_PATH = "/bagi-lokasi/";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const shareTokenFor = (secret: string, linkId: number) =>
  createHmac("sha256", secret).update(`trip-share-link:${linkId}`, "utf8").digest().subarray(0, 16).toString("base64url");

export const hashShareToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Whether the text can be a share token at all; anything else is not looked up. */
export const looksLikeShareToken = (text: string) => TOKEN_PATTERN.test(text);

export const shareUrlFor = (webOrigin: string, token: string) => `${webOrigin}${SHARE_PAGE_PATH}${token}`;

/** Revokes the active link of the trip, if there is one. Answers whether one was revoked. */
export async function revokeShareLink(orm: Orm, tripId: number, actor: number | null, now: Date): Promise<boolean> {
  const revoked = await orm
    .update(tripShareLinks)
    .set({ revokedAt: now, revokedBy: actor })
    .where(and(eq(tripShareLinks.tripId, tripId), isNull(tripShareLinks.revokedAt)))
    .returning({ id: tripShareLinks.id });
  return revoked.length > 0;
}

/** A new link for the trip; the active one is revoked first. Its token hash is filled when the token is shown. */
export async function replaceShareLink(orm: Orm, tripId: number, actor: number | null, now: Date): Promise<number> {
  await revokeShareLink(orm, tripId, actor, now);
  const [row] = await orm.insert(tripShareLinks).values({ tripId, createdBy: actor, createdAt: now }).returning({ id: tripShareLinks.id });
  if (!row) throw new Error("The share link was not created.");
  return row.id;
}

/** The token of the trip's active link, filling its hash on first use; null when the trip has no active link. */
export async function activeShareToken(orm: Orm, secret: string, tripId: number): Promise<string | null> {
  const [link] = await orm
    .select({ id: tripShareLinks.id, tokenHash: tripShareLinks.tokenHash })
    .from(tripShareLinks)
    .where(and(eq(tripShareLinks.tripId, tripId), isNull(tripShareLinks.revokedAt)));
  if (!link) return null;
  const token = shareTokenFor(secret, link.id);
  if (link.tokenHash === null) await orm.update(tripShareLinks).set({ tokenHash: hashShareToken(token) }).where(eq(tripShareLinks.id, link.id));
  return token;
}

/** Whether the trip ever had a link: trips issued before 0011 have none. */
export async function hadShareLink(orm: Orm, tripId: number): Promise<boolean> {
  const [row] = await orm.select({ id: tripShareLinks.id }).from(tripShareLinks).where(eq(tripShareLinks.tripId, tripId)).limit(1);
  return row !== undefined;
}
