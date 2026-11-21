// The state of the control room: the zones of the plan, every truck inside the plant with the zone it is drawn in,
// the figures of the day and the latest step changes. Everything is counted in SQL, one query per block.
//
// Where a truck is drawn (docs/fase-6-rancangan.md section 2):
//   a pending weighbridge decision (plate, gross, tare, net)  -> WB, held, since the request was raised
//   a pending QC hold                                         -> QC, held, since its step started (else raised)
//   a step IN_PROGRESS                                        -> the step's work zone, since it started
//   a step READY                                              -> the step's waiting zone, since it became ready
//   no step waiting or running                                -> REG, since check-in
// A weighbridge decision comes before a QC hold: the truck stands on the scale. A step without a zone falls back to REG.
import type { Database } from "../db/client.js";
import { PLANT_TIME_ZONE, todayAtPlant } from "../http.js";
import { DEMO_ZONE_SHAPES } from "./demo-plan.js";
import { hasPlanSvg } from "./plan.js";

export interface ZoneView {
  code: string;
  name: string;
  kind: string;
  color: string | null;
  /** Polygon on the plan in fractions of its width and height; null when the zone is not on the plan. */
  shape: number[][] | null;
}

export interface TruckView {
  tripId: number;
  tripNo: string | null;
  plateNo: string | null;
  plateDisplay: string | null;
  direction: "IN" | "OUT";
  flowCode: string;
  zone: string;
  stepCode: string | null;
  stepName: string | null;
  stepStatus: "READY" | "IN_PROGRESS" | null;
  /** When the truck came to this position. */
  since: string;
  held: { type: string; since: string } | null;
}

export interface ControlRoomState {
  generatedAt: string;
  plantDay: string;
  zones: ZoneView[];
  trucks: TruckView[];
  upcoming: { in: number; out: number };
  kpi: { inside: number; upcoming: number; pendingDecisions: number; finishedToday: number; avgMinutesInPlantToday: number | null };
  zoneStats: { zone: string; count: number; longest: { tripId: number; plateDisplay: string | null; minutes: number } | null }[];
  recent: { at: string; tripId: number; plateDisplay: string | null; text: string }[];
}

/** Trucks inside the plant are the trips with one of these statuses. */
const INSIDE = "('CHECKED_IN', 'IN_PROCESS')";

// $1 now, $2 plant time zone, $3 plant day
const SITE = "site as (select id, code from sites order by id limit 1)";
const POSITIONED = `
  inside as (
    select t.id, t.trip_no, t.site_id, t.checked_in_at, r.direction, r.flow_code,
           coalesce(v.plate_no, t.plate_no) as plate_no,
           coalesce(v.plate_display, t.plate_no) as plate_display
    from trips t
    join registrations r on r.id = t.registration_id
    left join vehicles v on v.id = t.vehicle_id
    where t.status in ${INSIDE}
  ),
  active as (
    select distinct on (s.trip_id) s.trip_id, s.step_code, s.status, s.ready_at, s.started_at
    from trip_steps s
    where s.trip_id in (select id from inside) and s.status in ('READY', 'IN_PROGRESS')
    order by s.trip_id, s.seq, s.attempt desc
  ),
  held as (
    select distinct on (e.trip_id) e.trip_id, e.type, e.raised_at
    from exceptions e
    where e.trip_id in (select id from inside) and e.status = 'PENDING'
    order by e.trip_id, (e.type = 'QC_HOLD'), e.raised_at
  ),
  positioned as (
    select i.id, i.trip_no, i.site_id, i.direction, i.flow_code, i.plate_no, i.plate_display,
           a.step_code, a.status as step_status, f.name as step_name, h.type as held_type, h.raised_at as held_since,
           coalesce(case
             when h.type = 'QC_HOLD' then 'QC'
             when h.type is not null then 'WB'
             when a.status = 'IN_PROGRESS' then work_zone.code
             when a.status = 'READY' then wait_zone.code
           end, 'REG') as zone_code,
           coalesce(case
             when h.type = 'QC_HOLD' and a.status = 'IN_PROGRESS' then coalesce(a.started_at, h.raised_at)
             when h.type is not null then h.raised_at
             when a.status = 'IN_PROGRESS' then coalesce(a.started_at, a.ready_at)
             when a.status = 'READY' then a.ready_at
           end, i.checked_in_at, $1::timestamptz) as since
    from inside i
    left join active a on a.trip_id = i.id
    left join held h on h.trip_id = i.id
    left join flow_steps f on f.site_id = i.site_id and f.flow_code = i.flow_code and f.step_code = a.step_code
    left join zones wait_zone on wait_zone.id = f.wait_zone_id
    left join zones work_zone on work_zone.id = f.work_zone_id
  )`;

const ZONES_SQL = `
  with ${SITE}
  select z.code, z.name, z.kind, z.color, z.map_shape::text as shape
  from zones z join site on site.id = z.site_id
  order by z.sort_order, z.code`;

const TRUCKS_SQL = `
  with ${POSITIONED}
  select id, trip_no, plate_no, plate_display, direction, flow_code, zone_code, step_code, step_name, step_status, since, held_type, held_since
  from positioned
  order by since, id`;

const ZONE_STATS_SQL = `
  with ${SITE}, ${POSITIONED}
  select z.code as zone,
         count(p.id)::int as count,
         (array_agg(p.id order by p.since, p.id) filter (where p.id is not null))[1] as longest_id,
         (array_agg(p.plate_display order by p.since, p.id) filter (where p.id is not null))[1] as longest_plate,
         floor(extract(epoch from ($1::timestamptz - min(p.since))) / 60)::int as longest_minutes
  from zones z
  join site on site.id = z.site_id
  left join positioned p on p.zone_code = z.code and p.site_id = z.site_id
  group by z.code, z.sort_order
  order by z.sort_order, z.code`;

/** Expected today, as the gate's list and GET /api/trips/flow count them. */
const UPCOMING_SQL = `
  select count(*) filter (where r.direction = 'IN')::int as incoming,
         count(*) filter (where r.direction = 'OUT')::int as outgoing
  from trips t
  join registrations r on r.id = t.registration_id
  where t.status in ('ISSUED', 'EXPIRED')
    and (coalesce(t.planned_arrival, r.planned_date) = $3::date or (t.checked_in_at at time zone $2)::date = $3::date)
    and $1::timestamptz is not null`;

const KPI_SQL = `
  select (select count(*)::int from trips where status in ${INSIDE}) as inside,
         (select count(*)::int from exceptions where status = 'PENDING') as pending,
         count(*)::int as finished,
         round(avg(extract(epoch from (t.completed_at - t.checked_in_at)) / 60))::float8 as avg_minutes
  from trips t
  where t.status in ('COMPLETED', 'REJECTED') and (t.completed_at at time zone $2)::date = $3::date and $1::timestamptz is not null`;

/**
 * Step changes of today from the step timestamps. A step that became ready and started at the same moment counts as
 * started, one that started and finished at the same moment as finished. Skipped steps are not changes.
 */
const RECENT_SQL = `
  with steps as (
    select s.trip_id, s.step_code, s.status, s.ready_at, s.started_at, s.finished_at, f.name,
           coalesce(v.plate_display, t.plate_no) as plate_display
    from trip_steps s
    join trips t on t.id = s.trip_id
    join registrations r on r.id = t.registration_id
    left join vehicles v on v.id = t.vehicle_id
    left join flow_steps f on f.site_id = t.site_id and f.flow_code = r.flow_code and f.step_code = s.step_code
    where greatest(s.ready_at, s.started_at, s.finished_at) >= ($3::date::timestamp at time zone $2)
      and $1::timestamptz is not null
  ),
  events as (
    select trip_id, step_code, name, plate_display, 'READY' as kind, ready_at as at
    from steps where ready_at is not null and ready_at is distinct from started_at
    union all
    select trip_id, step_code, name, plate_display, 'STARTED', started_at
    from steps where started_at is not null and started_at is distinct from finished_at
    union all
    select trip_id, step_code, name, plate_display, status, finished_at
    from steps where finished_at is not null and status in ('DONE', 'FAILED')
  )
  select trip_id, step_code, name, plate_display, kind, at
  from events
  where (at at time zone $2)::date = $3::date
  order by at desc, trip_id, kind
  limit 60`;

export const RECENT_LIMIT = 30;

/** "Timbang 1 (bruto)" -> "timbang 1"; "QC pass" stays as it is. */
export function stepLabel(name: string | null, code: string): string {
  const text = (name ?? code).replace(/\s*\([^)]*\)/g, "").trim();
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

interface EventRow {
  trip_id: number;
  step_code: string;
  name: string | null;
  plate_display: string | null;
  kind: "READY" | "STARTED" | "DONE" | "FAILED";
  at: Date;
}

/** Plain sentences for the step changes, newest first; a finished step and the next one ready at the same moment become one line. */
export function describeEvents(rows: EventRow[], limit = RECENT_LIMIT): ControlRoomState["recent"] {
  const used = new Set<EventRow>();
  const lines: ControlRoomState["recent"] = [];
  for (const row of rows) {
    if (used.has(row)) continue;
    used.add(row);
    const plate = row.plate_display ?? "Truk";
    const label = stepLabel(row.name, row.step_code);
    let text: string;
    if (row.kind === "READY") text = `${plate} menunggu ${label}`;
    else if (row.kind === "STARTED") text = `${plate} mulai ${label}`;
    else if (row.kind === "FAILED") text = `${plate} tidak lolos ${label}`;
    else if (row.step_code === "CHECK_IN") text = `${plate} check-in`;
    else if (row.step_code === "CHECK_OUT") text = `${plate} mengembalikan kartu dan keluar`;
    else text = `${plate} selesai ${label}`;
    if (row.kind === "DONE" || row.kind === "FAILED") {
      const next = rows.find((other) => !used.has(other) && other.kind === "READY" && other.trip_id === row.trip_id && other.at.getTime() === row.at.getTime());
      if (next) {
        used.add(next);
        text += `, menunggu ${stepLabel(next.name, next.step_code)}`;
      }
    }
    lines.push({ at: row.at.toISOString(), tripId: Number(row.trip_id), plateDisplay: row.plate_display, text });
    if (lines.length === limit) break;
  }
  return lines;
}

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

export async function computeState(database: Database, now: Date, filesDir: string): Promise<ControlRoomState> {
  const plantDay = todayAtPlant(now);
  const params = [now, PLANT_TIME_ZONE, plantDay];
  const zoneRows = await database.query<{ code: string; name: string; kind: string; color: string | null; shape: string | null }>(ZONES_SQL);
  const [site] = await database.query<{ code: string }>("select code from sites order by id limit 1");
  // without an imported drawing the demo plan is served, so its zones are drawn as well
  const demo = site ? !(await hasPlanSvg(filesDir, site.code)) : true;
  const zones: ZoneView[] = zoneRows.map((row) => ({
    code: row.code,
    name: row.name,
    kind: row.kind,
    color: row.color,
    shape: row.shape !== null ? (JSON.parse(row.shape) as number[][]) : demo ? (DEMO_ZONE_SHAPES[row.code] ?? null) : null,
  }));

  const truckRows = await database.query<{
    id: number;
    trip_no: string | null;
    plate_no: string | null;
    plate_display: string | null;
    direction: "IN" | "OUT";
    flow_code: string;
    zone_code: string;
    step_code: string | null;
    step_name: string | null;
    step_status: "READY" | "IN_PROGRESS" | null;
    since: Date;
    held_type: string | null;
    held_since: Date | null;
  }>(TRUCKS_SQL, [now]);
  const trucks: TruckView[] = truckRows.map((row) => ({
    tripId: Number(row.id),
    tripNo: row.trip_no,
    plateNo: row.plate_no,
    plateDisplay: row.plate_display,
    direction: row.direction,
    flowCode: row.flow_code,
    zone: row.zone_code,
    stepCode: row.step_code,
    stepName: row.step_name,
    stepStatus: row.step_status,
    since: iso(row.since)!,
    held: row.held_type ? { type: row.held_type, since: iso(row.held_since)! } : null,
  }));

  const [upcomingRow] = await database.query<{ incoming: number; outgoing: number }>(UPCOMING_SQL, params);
  const upcoming = { in: upcomingRow?.incoming ?? 0, out: upcomingRow?.outgoing ?? 0 };
  const [kpiRow] = await database.query<{ inside: number; pending: number; finished: number; avg_minutes: number | null }>(KPI_SQL, params);

  const statRows = await database.query<{ zone: string; count: number; longest_id: number | null; longest_plate: string | null; longest_minutes: number | null }>(
    ZONE_STATS_SQL,
    [now],
  );
  const zoneStats = statRows.map((row) => ({
    zone: row.zone,
    count: row.count,
    longest: row.longest_id === null ? null : { tripId: Number(row.longest_id), plateDisplay: row.longest_plate, minutes: Math.max(0, row.longest_minutes ?? 0) },
  }));

  const recent = describeEvents(await database.query<EventRow>(RECENT_SQL, params));

  return {
    generatedAt: now.toISOString(),
    plantDay,
    zones,
    trucks,
    upcoming,
    kpi: {
      inside: kpiRow?.inside ?? 0,
      upcoming: upcoming.in + upcoming.out,
      pendingDecisions: kpiRow?.pending ?? 0,
      finishedToday: kpiRow?.finished ?? 0,
      avgMinutesInPlantToday: kpiRow?.avg_minutes ?? null,
    },
    zoneStats,
    recent,
  };
}
