// Values of the settings table: a row of the site wins over the global row (site_id null).
import { asc, eq } from "drizzle-orm";
import type { Orm } from "./db/client.js";
import { settings, sites } from "./db/schema.js";
import { AppError } from "./errors.js";

export async function readSetting<T = unknown>(orm: Orm, siteId: number, key: string): Promise<T | undefined> {
  const rows = await orm.select({ siteId: settings.siteId, value: settings.value }).from(settings).where(eq(settings.key, key));
  const own = rows.find((row) => row.siteId === siteId) ?? rows.find((row) => row.siteId === null);
  return own?.value as T | undefined;
}

export interface Site {
  id: number;
  code: string;
}

/**
 * The site new documents belong to. There is one site today; with several, the first active one is used
 * until accounts or requests name a site.
 */
export async function defaultSite(orm: Orm): Promise<Site> {
  const [site] = await orm.select({ id: sites.id, code: sites.code }).from(sites).where(eq(sites.isActive, true)).orderBy(asc(sites.id)).limit(1);
  if (!site) throw new AppError(503, "NOT_CONFIGURED", "Cabang belum diatur di server.");
  return site;
}

export async function siteById(orm: Orm, id: number): Promise<Site> {
  const [site] = await orm.select({ id: sites.id, code: sites.code }).from(sites).where(eq(sites.id, id));
  if (!site) throw new Error(`Site ${id} does not exist.`);
  return site;
}
