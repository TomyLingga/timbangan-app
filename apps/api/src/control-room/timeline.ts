// One trip for the truck detail window of the control room: its papers (SPJ, driver, transporter, partner, contracts,
// card, letter and weighed figures), its steps with their times, its weighings and its decision requests.
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
  /** The truck's papers for the detail window. */
  truck: TruckPapers;
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

export interface TruckPapers {
  regNo: string;
  /** The SPJ that is not revoked. */
  spjNo: string | null;
  driverName: string | null;
  transporterName: string | null;
  /** Supplier of an incoming truck, customer of an outgoing one (the registration's partner). */
  partnerName: string;
  partnerRole: "SUPPLIER" | "CUSTOMER";
  vehicleType: string | null;
  containerNo: string | null;
  /** The number printed on the card the truck carries now, or its UID when none is printed. */
  cardLabel: string | null;
  /** Distinct products of the truck's contracts or delivery orders, in allocation order. */
  products: string[];
  allocations: { contractNo: string; doNo: string | null }[];
  /** The supplier's letter. */
  letter: Figures;
  /** From the valid weighings. */
  weighed: Figures;
}

interface Figures {
  grossKg: number | null;
  tareKg: number | null;
  netKg: number | null;
}

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

export async function tripTimeline(database: Database, tripId: number, now: Date): Promise<TripTimeline> {
  // the trip and its papers in one query: the SPJ, the card and the allocations come from subqueries
  const [trip] = await database.query<{
    id: number;
    trip_no: string | null;
    plate_display: string | null;
    direction: "IN" | "OUT";
    flow_code: string;
    status: string;
    checked_in_at: Date | null;
    completed_at: Date | null;
    reg_no: string;
    spj_no: string | null;
    driver_name: string | null;
    transporter_name: string | null;
    partner_name: string;
    vehicle_type: string | null;
    container_no: string | null;
    card_label: string | null;
    allocations: { contractNo: string; doNo: string | null; product: string | null }[] | string | null;
    doc_gross_kg: number | null;
    doc_tare_kg: number | null;
    doc_net_kg: number | null;
    gross_kg: number | null;
    tare_kg: number | null;
    net_kg: number | null;
  }>(
    `select t.id, t.trip_no, coalesce(v.plate_display, t.plate_no) as plate_display, r.direction, r.flow_code, t.status, t.checked_in_at, t.completed_at,
            r.reg_no, coalesce(t.driver_name, d.full_name) as driver_name, tp.name as transporter_name, p.name as partner_name,
            vt.name as vehicle_type, t.container_no,
            t.doc_gross_kg, t.doc_tare_kg, t.doc_net_kg, t.gross_kg, t.tare_kg, t.net_kg,
            (select s.spj_no from spj_documents s where s.trip_id = t.id and s.revoked_at is null order by s.issued_at desc limit 1) as spj_no,
            (select coalesce(c.label, c.uid) from card_assignments a join rfid_cards c on c.id = a.card_id
              where a.trip_id = t.id and a.released_at is null limit 1) as card_label,
            (select json_agg(json_build_object('contractNo', ra.contract_no, 'doNo', ra.do_no, 'product', pr.name) order by ta.seq)
               from trip_allocations ta
               join registration_allocations ra on ra.id = ta.registration_allocation_id
               left join erp_contracts ec on ec.id = ra.contract_id
               left join delivery_orders dor on dor.id = ra.delivery_order_id
               left join products pr on pr.id = coalesce(dor.product_id, ec.product_id)
              where ta.trip_id = t.id) as allocations
     from trips t
     join registrations r on r.id = t.registration_id
     join partners p on p.id = r.partner_id
     left join partners tp on tp.id = coalesce(t.transporter_id, r.transporter_id)
     left join vehicles v on v.id = t.vehicle_id
     left join vehicle_types vt on vt.code = v.vehicle_type_code
     left join drivers d on d.id = t.driver_id
     where t.id = $1`,
    [tripId],
  );
  if (!trip) throw notFound("Trip");
  // PGlite and postgres.js both parse json; a driver that hands back text is read here
  const allocations = (typeof trip.allocations === "string" ? JSON.parse(trip.allocations) : trip.allocations) as { contractNo: string; doNo: string | null; product: string | null }[] | null;
  const products = [...new Set((allocations ?? []).map((row) => row.product).filter((name): name is string => name !== null))];
  const truck: TruckPapers = {
    regNo: trip.reg_no,
    spjNo: trip.spj_no,
    driverName: trip.driver_name,
    transporterName: trip.transporter_name,
    partnerName: trip.partner_name,
    partnerRole: trip.direction === "IN" ? "SUPPLIER" : "CUSTOMER",
    vehicleType: trip.vehicle_type,
    containerNo: trip.container_no,
    cardLabel: trip.card_label,
    products,
    allocations: (allocations ?? []).map((row) => ({ contractNo: row.contractNo, doNo: row.doNo })),
    letter: { grossKg: trip.doc_gross_kg, tareKg: trip.doc_tare_kg, netKg: trip.doc_net_kg },
    weighed: { grossKg: trip.gross_kg, tareKg: trip.tare_kg, netKg: trip.net_kg },
  };

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
    truck,
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
