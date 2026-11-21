// Pre-handler for the routes the weighbridge program calls: the X-Station-Key header identifies an active
// weighbridge station. There is no user account behind these requests.
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Orm } from "../db/client.js";
import { stations } from "../db/schema.js";
import { AppError } from "../errors.js";
import { keyMatches, stationIdOfKey } from "./keys.js";

/** The station a request came from. */
export interface StationIdentity {
  id: number;
  siteId: number;
  code: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the station guard; null on routes called by people. */
    station: StationIdentity | null;
  }
}

const refused = () => new AppError(401, "STATION_UNAUTHENTICATED", "Kunci stasiun tidak valid.", undefined, { speech: ["Kunci stasiun tidak valid."] });

export function createStationGuard(orm: Orm) {
  return async function authenticateStation(request: FastifyRequest): Promise<void> {
    const header = request.headers["x-station-key"];
    const key = typeof header === "string" ? header.trim() : "";
    const stationId = stationIdOfKey(key);
    if (stationId === null) throw refused();
    const [station] = await orm.select().from(stations).where(eq(stations.id, stationId));
    // the hash is compared even for a station that will be refused, so the answer time says nothing
    const matches = keyMatches(station?.apiKeyHash ?? null, key);
    if (!station || !matches || !station.isActive || station.kind !== "WEIGHBRIDGE") throw refused();
    request.station = { id: station.id, siteId: station.siteId, code: station.code, name: station.name, kind: station.kind, config: station.config };
  };
}

/** The station the guard put on the request. */
export function stationOf(request: FastifyRequest): StationIdentity {
  if (!request.station) throw refused();
  return request.station;
}
