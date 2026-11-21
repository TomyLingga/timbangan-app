// The timeline of one trip for the side sheet of the control room: its steps with their times, its weighings and its
// decision requests.
import type { Database } from "../db/client.js";
import { notFound } from "../errors.js";

export interface TripTimeline {
  trip: {
    id: number;
    tripNo: string | null;
    plateDisplay: string | null;
    direction: "IN" | "OUT";
    flowCode: string;
    status: string;
    checkedInAt: string | null;
    completedAt: string | null;
  };
  steps: {
    code: string;
    name: string | null;
    status: string;
    result: string | null;
    readyAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    /** From ready (or started) to finished, or to now while not finished; null before the step was ready. */
    minutes: number | null;
  }[];
  weighings: { stage: number; kind: string; kg: number; at: string; mode: string; plateCheck: string; status: string }[];
  exceptions: { type: string; status: string; raisedAt: string; decidedAt: string | null; decisionCode: string | null }[];
}

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

export async function tripTimeline(database: Database, tripId: number, now: Date): Promise<TripTimeline> {
  const [trip] = await database.query<{
    id: number;
    trip_no: string | null;
    plate_display: string | null;
    direction: "IN" | "OUT";
    flow_code: string;
    status: string;
    checked_in_at: Date | null;
    completed_at: Date | null;
  }>(
    `select t.id, t.trip_no, coalesce(v.plate_display, t.plate_no) as plate_display, r.direction, r.flow_code, t.status, t.checked_in_at, t.completed_at
     from trips t join registrations r on r.id = t.registration_id left join vehicles v on v.id = t.vehicle_id
     where t.id = $1`,
    [tripId],
  );
  if (!trip) throw notFound("Trip");

  const steps = await database.query<{
    step_code: string;
    name: string | null;
    status: string;
    result: string | null;
    ready_at: Date | null;
    started_at: Date | null;
    finished_at: Date | null;
    minutes: number | null;
  }>(
    `select s.step_code, f.name, s.status, s.result, s.ready_at, s.started_at, s.finished_at,
            floor(extract(epoch from (coalesce(s.finished_at, $2::timestamptz) - coalesce(s.ready_at, s.started_at))) / 60)::int as minutes
     from trip_steps s
     join trips t on t.id = s.trip_id
     join registrations r on r.id = t.registration_id
     left join flow_steps f on f.site_id = t.site_id and f.flow_code = r.flow_code and f.step_code = s.step_code
     where s.trip_id = $1
     order by s.seq, s.attempt`,
    [tripId, now],
  );
  const weighings = await database.query<{ stage: number; kind: string; weight_kg: number; weighed_at: Date; mode: string; plate_check: string; status: string }>(
    "select stage, kind, weight_kg, weighed_at, mode, plate_check, status from weighings where trip_id = $1 order by weighed_at, id",
    [tripId],
  );
  const exceptions = await database.query<{ type: string; status: string; raised_at: Date; decided_at: Date | null; decision_code: string | null }>(
    "select type, status, raised_at, decided_at, decision_code from exceptions where trip_id = $1 order by raised_at, id",
    [tripId],
  );

  return {
    trip: {
      id: Number(trip.id),
      tripNo: trip.trip_no,
      plateDisplay: trip.plate_display,
      direction: trip.direction,
      flowCode: trip.flow_code,
      status: trip.status,
      checkedInAt: iso(trip.checked_in_at),
      completedAt: iso(trip.completed_at),
    },
    steps: steps.map((row) => ({
      code: row.step_code,
      name: row.name,
      status: row.status,
      result: row.result,
      readyAt: iso(row.ready_at),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      minutes: row.minutes === null ? null : Math.max(0, row.minutes),
    })),
    weighings: weighings.map((row) => ({
      stage: row.stage,
      kind: row.kind,
      kg: row.weight_kg,
      at: iso(row.weighed_at)!,
      mode: row.mode,
      plateCheck: row.plate_check,
      status: row.status,
    })),
    exceptions: exceptions.map((row) => ({ type: row.type, status: row.status, raisedAt: iso(row.raised_at)!, decidedAt: iso(row.decided_at), decisionCode: row.decision_code })),
  };
}
