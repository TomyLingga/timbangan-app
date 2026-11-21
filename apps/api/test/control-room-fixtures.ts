// Made-up trips for the control room tests: rows are written straight into the tables, so a test can put a truck in
// any state without walking it through the gate and the weighbridge. Every plate and name here is invented.
import type { Database } from "../src/db/client.js";
import { seedStaff } from "./helpers/users.js";

type Flow = "IN_CPO" | "IN_GOODS" | "OUT_BULK" | "OUT_PACKED";
type TripStatus = "ISSUED" | "EXPIRED" | "CHECKED_IN" | "IN_PROCESS" | "COMPLETED" | "REJECTED" | "CANCELLED";
type StepStatus = "PENDING" | "READY" | "IN_PROGRESS" | "DONE" | "SKIPPED" | "FAILED";

export interface StepSeed {
  code: string;
  status: StepStatus;
  result?: "PASS" | "FAIL" | "HOLD";
  readyAt?: string;
  startedAt?: string;
  finishedAt?: string;
  attempt?: number;
}

export interface TripSeed {
  plate: string;
  flow?: Flow;
  status?: TripStatus;
  checkedInAt?: string | null;
  plannedArrival?: string | null;
  completedAt?: string | null;
  steps?: StepSeed[];
}

export interface SeededTrip {
  tripId: number;
  /** Trip step id per step code (the last attempt). */
  steps: Record<string, number>;
}

export interface Base {
  ownerId: number;
  partnerId: number;
  stationId: number;
}

let counter = 0;
const one = async (database: Database, text: string, params: unknown[]) => Number((await database.query<{ id: number }>(text, params))[0]?.id);

/** A staff owner for the registrations, one company and one weighbridge. */
export async function seedBase(database: Database): Promise<Base> {
  counter++;
  const ownerId = await seedStaff(database, `cr-owner-${counter}`, { gate: "VIEW" });
  const partnerId = await one(database, "insert into partners (name, is_supplier, is_customer) values ($1, true, true) returning id", [`PT Contoh Peta ${counter}`]);
  const stationId = await one(
    database,
    "insert into stations (site_id, code, name, kind) select id, $1, 'Timbangan contoh', 'WEIGHBRIDGE' from sites where code = 'SMK' returning id",
    [`WB-CR-${counter}`],
  );
  return { ownerId, partnerId, stationId };
}

/** One registration, vehicle, driver and trip, with the given trip steps. */
export async function seedTrip(database: Database, base: Base, seed: TripSeed): Promise<SeededTrip> {
  counter++;
  const flow = seed.flow ?? "IN_CPO";
  const direction = flow.startsWith("IN") ? "IN" : "OUT";
  const registrationId = await one(
    database,
    `insert into registrations (site_id, reg_no, direction, flow_code, partner_id, status, planned_date, created_via, created_by, close_cargo, flexi_bag)
     select id, $1, $2, $3, $4, 'APPROVED', $5, 'OPERATOR', $6, false, false from sites where code = 'SMK' returning id`,
    [`REG-CR-${counter}`, direction, flow, base.partnerId, seed.plannedArrival ?? null, base.ownerId],
  );
  const vehicleId = await one(database, "insert into vehicles (plate_no, plate_display, vehicle_type_code) values ($1, $2, 'TANGKI') returning id", [
    seed.plate.replace(/\s/g, ""),
    seed.plate,
  ]);
  const driverId = await one(database, "insert into drivers (full_name, licence_no) values ($1, $2) returning id", [`Supir Contoh ${counter}`, `SIMCR${String(counter).padStart(6, "0")}`]);
  const status = seed.status ?? "CHECKED_IN";
  const tripId = await one(
    database,
    `insert into trips (site_id, registration_id, trip_no, status, outcome, vehicle_id, driver_id, plate_no, planned_arrival, checked_in_at, completed_at)
     select id, $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz from sites where code = 'SMK' returning id`,
    [
      registrationId,
      status === "ISSUED" || status === "EXPIRED" ? null : `TRIP-CR-${counter}`,
      status,
      status === "COMPLETED" ? "OK" : status === "REJECTED" ? "SPEC_REJECT" : null,
      vehicleId,
      driverId,
      seed.plate.replace(/\s/g, ""),
      seed.plannedArrival ?? null,
      seed.checkedInAt === undefined ? (status === "ISSUED" || status === "EXPIRED" ? null : "2026-11-20T01:00:00Z") : seed.checkedInAt,
      seed.completedAt ?? null,
    ],
  );
  const steps: Record<string, number> = {};
  for (const step of seed.steps ?? []) {
    steps[step.code] = await one(
      database,
      `insert into trip_steps (trip_id, step_code, seq, attempt, status, result, ready_at, started_at, finished_at)
       select $1, step_code, seq, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz from flow_steps where flow_code = $8 and step_code = $9
       returning id`,
      [tripId, step.attempt ?? 1, step.status, step.result ?? null, step.readyAt ?? null, step.startedAt ?? null, step.finishedAt ?? null, flow, step.code],
    );
    if (!steps[step.code]) throw new Error(`flow ${flow} has no step ${step.code}`);
  }
  return { tripId, steps };
}

export interface ExceptionSeed {
  type: "PLATE" | "GROSS_IN" | "TARE_OUT" | "NET_IN" | "NET_OUT" | "QC_HOLD";
  status?: "PENDING" | "CANCELLED";
  raisedAt: string;
  stepId?: number;
}

export async function seedException(database: Database, tripId: number, seed: ExceptionSeed): Promise<number> {
  return one(
    database,
    `insert into exceptions (site_id, trip_id, trip_step_id, type, status, approver_module, raised_at)
     select site_id, id, $2, $3, $4, $5, $6::timestamptz from trips where id = $1 returning id`,
    [tripId, seed.stepId ?? null, seed.type, seed.status ?? "PENDING", seed.type === "QC_HOLD" ? "qc_approvals" : "approvals", seed.raisedAt],
  );
}

export async function seedWeighing(
  database: Database,
  base: Base,
  tripId: number,
  seed: { stage: 1 | 2; kind: "GROSS" | "TARE"; kg: number; at: string; mode?: "AUTO" | "EXCEPTION"; plateCheck?: "MATCH" | "CONFIRMED" | "BYPASSED" },
): Promise<number> {
  return one(
    database,
    `insert into weighings (trip_id, station_id, stage, kind, weight_kg, weighed_at, mode, plate_check)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8) returning id`,
    [tripId, base.stationId, seed.stage, seed.kind, seed.kg, seed.at, seed.mode ?? "AUTO", seed.plateCheck ?? "MATCH"],
  );
}
