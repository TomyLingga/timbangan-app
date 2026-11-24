// Where an outgoing truck is going: the map pins of the delivery orders its trip carries. A trip is tied to delivery
// orders through its allocations (trip_allocations -> registration_allocations.delivery_order_id), one per DO line the
// truck loads; a DO without a pin gives no entry. Whoever may see the trip sees its destinations.
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { deliveryOrders, registrationAllocations, tripAllocations } from "../db/schema.js";
import { distanceKm } from "./geo.js";

export interface TripDestination {
  deliveryOrderId: number;
  doNo: string;
  name: string | null;
  regency: string | null;
  lat: number;
  lon: number;
}

/** The pinned destinations of each trip, one per delivery order, in allocation order. Trips without one get []. */
export async function destinationsOfTrips(orm: Orm, tripIds: number[]): Promise<Map<number, TripDestination[]>> {
  const found = new Map<number, TripDestination[]>(tripIds.map((id) => [id, []]));
  if (tripIds.length === 0) return found;
  const rows = await orm
    .select({
      tripId: tripAllocations.tripId,
      deliveryOrderId: deliveryOrders.id,
      doNo: deliveryOrders.doNo,
      name: deliveryOrders.destName,
      regency: deliveryOrders.destRegency,
      lat: deliveryOrders.destLat,
      lon: deliveryOrders.destLon,
    })
    .from(tripAllocations)
    .innerJoin(registrationAllocations, eq(registrationAllocations.id, tripAllocations.registrationAllocationId))
    .innerJoin(deliveryOrders, eq(deliveryOrders.id, registrationAllocations.deliveryOrderId))
    .where(and(inArray(tripAllocations.tripId, tripIds), isNotNull(deliveryOrders.destLat), isNotNull(deliveryOrders.destLon)))
    .orderBy(asc(tripAllocations.tripId), asc(tripAllocations.seq), asc(tripAllocations.id));
  for (const row of rows) {
    const list = found.get(row.tripId) ?? [];
    // two lines of the same DO on one truck still make one destination
    if (row.lat === null || row.lon === null || list.some((entry) => entry.deliveryOrderId === row.deliveryOrderId)) continue;
    list.push({ deliveryOrderId: row.deliveryOrderId, doNo: row.doNo, name: row.name, regency: row.regency, lat: Number(row.lat), lon: Number(row.lon) });
    found.set(row.tripId, list);
  }
  return found;
}

/** Adds the distance from the truck's last point, in km with one decimal; null without a point. */
export function withDistance(destinations: TripDestination[], last: { lat: number; lon: number } | null) {
  return destinations.map((entry) => ({ ...entry, distanceKm: last ? Math.round(distanceKm(last, entry) * 10) / 10 : null }));
}
