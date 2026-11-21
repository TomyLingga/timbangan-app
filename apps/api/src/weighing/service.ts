// Weighing a truck: which weighing is due, saving it with the trip figures and the step progression, and
// splitting the net after the second weighing.
import { and, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Orm } from "../db/client.js";
import { auditLog, cardAssignments, registrations, rfidCards, tripAllocations, trips, vehicles, weighings } from "../db/schema.js";
import { lettersAndDigits } from "../http.js";
import { RELEASED_STATUSES } from "../trips/view.js";
import { messages, weighbridgeError } from "./messages.js";
import { splitNet } from "./split.js";
import { advance, finishStep, loadSteps, readyStep, type StepInfo } from "./steps.js";
import { loadAllocations, uomOf } from "./view.js";

export type WeighKind = "GROSS" | "TARE";

/** Everything the weighing rules need about one trip at its weighing step. */
export interface WeighContext {
  trip: typeof trips.$inferSelect;
  direction: "IN" | "OUT";
  flowCode: string;
  closeCargo: boolean;
  flexiBag: boolean;
  vehicle: { id: number; plateNo: string; plateDisplay: string; tareKg: number | null; verifiedAt: Date | null } | null;
  step: StepInfo;
  stage: 1 | 2;
  kind: WeighKind;
  /** Letters and digits of the registered plate. */
  plateNo: string;
  plateDisplay: string;
}

/** Incoming: gross first, tare second. Outgoing: the other way round. */
export const kindOf = (direction: "IN" | "OUT", stage: 1 | 2): WeighKind => ((direction === "IN") === (stage === 1) ? "GROSS" : "TARE");

/** The trip that carries this card now; refuses an unknown card or one that is not handed out. */
export async function tripOfCard(orm: Orm, uidText: string): Promise<number> {
  const uid = uidText.toUpperCase().replace(/[\s:.-]/g, "");
  if (!/^[0-9A-F]{8,20}$/.test(uid)) throw weighbridgeError(404, "CARD_UNKNOWN", messages.cardUnknown());
  const [card] = await orm.select({ id: rfidCards.id }).from(rfidCards).where(eq(rfidCards.uid, uid));
  if (!card) throw weighbridgeError(404, "CARD_UNKNOWN", messages.cardUnknown());
  const [assigned] = await orm.select({ tripId: cardAssignments.tripId }).from(cardAssignments).where(and(eq(cardAssignments.cardId, card.id), isNull(cardAssignments.releasedAt)));
  if (!assigned) throw weighbridgeError(404, "CARD_UNKNOWN", messages.cardNotInUse());
  return assigned.tripId;
}

/**
 * The trip at its weighing step, locked when `lock` is set. Refuses a trip whose weighing step is not READY
 * (naming the step it waits for) and a trip of a direction the station does not serve.
 */
export async function loadWeighContext(orm: Orm, tripId: number, directions: ("IN" | "OUT")[] | null, lock = false): Promise<WeighContext> {
  const query = orm
    .select({ trip: trips, direction: registrations.direction, flowCode: registrations.flowCode, closeCargo: registrations.closeCargo, flexiBag: registrations.flexiBag })
    .from(trips)
    .innerJoin(registrations, eq(registrations.id, trips.registrationId))
    .where(eq(trips.id, tripId));
  const [row] = lock ? await query.for("update", { of: trips }) : await query;
  if (!row) throw weighbridgeError(404, "CARD_UNKNOWN", messages.cardNotInUse());
  if (directions && !directions.includes(row.direction)) throw weighbridgeError(409, "WRONG_STATION", messages.wrongStation());
  const steps = await loadSteps(orm, tripId);
  const ready = readyStep(steps);
  const inside = row.trip.status === "CHECKED_IN" || row.trip.status === "IN_PROCESS";
  if (!inside || !ready || (ready.stepCode !== "WEIGH_1" && ready.stepCode !== "WEIGH_2")) {
    const waiting = inside ? ready : null;
    throw weighbridgeError(409, "NOT_READY", messages.notReady(waiting?.name ?? null), { waitingStep: waiting?.stepCode ?? null });
  }
  const [vehicle] =
    row.trip.vehicleId === null
      ? []
      : await orm
          .select({ id: vehicles.id, plateNo: vehicles.plateNo, plateDisplay: vehicles.plateDisplay, tareKg: vehicles.tareKg, verifiedAt: vehicles.verifiedAt })
          .from(vehicles)
          .where(eq(vehicles.id, row.trip.vehicleId));
  const stage = ready.stepCode === "WEIGH_1" ? 1 : 2;
  const plateNo = lettersAndDigits(row.trip.plateNo ?? vehicle?.plateNo ?? "");
  return {
    trip: row.trip,
    direction: row.direction,
    flowCode: row.flowCode,
    closeCargo: row.closeCargo ?? false,
    flexiBag: row.flexiBag ?? false,
    vehicle: vehicle ?? null,
    step: ready,
    stage,
    kind: kindOf(row.direction, stage),
    plateNo,
    plateDisplay: vehicle && lettersAndDigits(vehicle.plateNo) === plateNo ? vehicle.plateDisplay : plateNo,
  };
}

/** An audit row for a change a station made (no user account). */
export async function writeStationAudit(orm: Orm, stationId: number, ip: string | null, at: Date, entry: { action: string; entityType: string; entityId: number; before: unknown; after: unknown; reason?: string }) {
  await orm.insert(auditLog).values({ ...entry, at, userId: null, stationId, ip });
}

export interface SaveInput {
  stationId: number;
  weightKg: number;
  plateRead: string | null;
  cardUid: string | null;
  plateCheck: "MATCH" | "CONFIRMED" | "BYPASSED";
  mode: "AUTO" | "EXCEPTION";
  /** The supervisor who approved an exception, when the weighing is saved by that decision. */
  decidedBy?: number | null;
  ip: string | null;
}

/**
 * Saves the weighing: the trip gets its gross or tare (and the net at the second weighing), the weighing step
 * is done and the next step READY; the first weighing puts the trip IN_PROCESS. After the second weighing the
 * net is split over the allocations, unless the trip was rejected or the net is below zero.
 */
export async function saveWeighing(orm: Orm, context: WeighContext, input: SaveInput, now: Date) {
  const { trip, stage, kind } = context;
  const [weighing] = await orm
    .insert(weighings)
    .values({
      tripId: trip.id,
      tripStepId: context.step.id,
      stationId: input.stationId,
      stage,
      kind,
      weightKg: input.weightKg,
      weighedAt: now,
      mode: input.mode,
      cardUid: input.cardUid,
      plateRead: input.plateRead,
      plateCheck: input.plateCheck,
      createdAt: now,
    })
    .returning();
  if (!weighing) throw new Error("The weighing was not saved.");
  const grossKg = kind === "GROSS" ? input.weightKg : trip.grossKg;
  const tareKg = kind === "TARE" ? input.weightKg : trip.tareKg;
  const netKg = stage === 2 && grossKg !== null && tareKg !== null ? grossKg - tareKg : null;
  await orm
    .update(trips)
    .set({ grossKg, tareKg, netKg, ...(trip.status === "CHECKED_IN" ? { status: "IN_PROCESS" as const } : {}), updatedAt: now })
    .where(eq(trips.id, trip.id));
  await finishStep(orm, context.step.id, { status: "DONE", result: "PASS", stationId: input.stationId, performedBy: input.decidedBy ?? null }, now);
  const next = await advance(orm, trip.id, now);
  if (netKg !== null && netKg >= 0 && trip.outcome === null) await splitTripNet(orm, trip.id, context.direction, netKg, now);
  await writeStationAudit(orm, input.stationId, input.ip, now, {
    action: "WEIGHING_SAVED",
    entityType: "trip",
    entityId: trip.id,
    before: { grossKg: trip.grossKg, tareKg: trip.tareKg },
    after: { weighingId: weighing.id, stage, kind, weightKg: input.weightKg, netKg },
  });
  return { weighing, netKg, next };
}

/** What a DO has received from other trips that are not released and already split. */
async function deliveredByOthers(orm: Orm, deliveryOrderId: number, tripId: number): Promise<number> {
  const [row] = await orm
    .select({ total: sql<string | null>`sum(coalesce(${tripAllocations.qtyActual}, ${tripAllocations.netKg}))` })
    .from(tripAllocations)
    .innerJoin(trips, eq(trips.id, tripAllocations.tripId))
    .where(
      and(
        sql`${tripAllocations.registrationAllocationId} in (select id from registration_allocations where delivery_order_id = ${deliveryOrderId})`,
        ne(trips.id, tripId),
        notInArray(trips.status, RELEASED_STATUSES),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Splits the net over the trip's allocations by the rules of its direction. Kilogram lines get qty_actual too. */
export async function splitTripNet(orm: Orm, tripId: number, direction: "IN" | "OUT", netKg: number, now: Date): Promise<void> {
  const rows = await loadAllocations(orm, tripId);
  if (rows.length === 0) return;
  const lines = [];
  for (const row of rows) {
    const remaining = row.deliveryOrderId !== null && row.doQty !== null ? row.doQty - (await deliveredByOthers(orm, row.deliveryOrderId, tripId)) : null;
    lines.push({ seq: row.seq, originNetKg: row.originNetKg, remaining });
  }
  const { method, shares } = splitNet(direction, netKg, lines);
  for (const [index, row] of rows.entries()) {
    const share = shares[index] ?? 0;
    await orm
      .update(tripAllocations)
      .set({ netKg: share, splitMethod: method, splitBy: null, splitAt: now, ...(uomOf(row) === "kg" ? { qtyActual: share } : {}) })
      .where(eq(tripAllocations.id, row.id));
  }
}
