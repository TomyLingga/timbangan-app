// Made-up stations, accounts and trucks for the phase 4 tests. Trucks are registered and checked in through the
// phase 3 routes, so they carry the same rows a real truck would.
import type { Database } from "../../src/db/client.js";
import { generateStationKey } from "../../src/stations/keys.js";
import { phase3App, seedCard, seedContract, seedDestination, seedDriver, seedVehicle } from "./fixtures.js";
import { seedStaff } from "./users.js";

export interface StationSeed {
  code: string;
  directions: ("IN" | "OUT")[];
  plateAttempts?: number;
  cameraWeigh1?: number | null;
  cameraWeigh2?: number | null;
}

/** A weighbridge station with a machine key; answers its id and key. */
export async function seedWeighbridge(database: Database, seed: StationSeed): Promise<{ id: number; key: string }> {
  const config = { directions: seed.directions, cameraWeigh1: seed.cameraWeigh1 ?? null, cameraWeigh2: seed.cameraWeigh2 ?? null, plateAttempts: seed.plateAttempts ?? 1 };
  const [row] = await database.query<{ id: number }>(
    "insert into stations (site_id, code, name, kind, config) select id, $1, $2, 'WEIGHBRIDGE', $3 from sites order by id limit 1 returning id",
    [seed.code, `Timbangan ${seed.code}`, JSON.stringify(config)],
  );
  const id = Number(row?.id);
  const { key, hash } = generateStationKey(id);
  await database.query("update stations set api_key_hash = $1 where id = $2", [hash, id]);
  return { id, key };
}

export interface IncomingSeed {
  plate?: string;
  /** One entry per contract on the truck. */
  contracts?: { tolerancePct?: number; originNetKg?: number | null }[];
  originTareKg?: number;
  product?: "cpo" | "olein";
}

export interface OutgoingSeed {
  plate?: string;
  /** Quantity of each DO on the truck. */
  dos?: number[];
  closeCargo?: boolean;
  flexiBag?: boolean;
  /** Master tare of the vehicle; null leaves it empty. */
  tareKg?: number | null;
  verified?: boolean;
  product?: "olein" | "packed";
}

export interface SeededTrip {
  tripId: number;
  cardUid: string;
  plateNo: string;
  vehicleId: number;
}

let serial = 0;

/**
 * The phase 3 application plus: stations WB-IN (incoming) and WB-OUT (outgoing) with keys, `atasan` (approvals
 * EDIT), `lapangan` (every field-step module at CREATE), `admin4` (registrations EDIT, reports VIEW).
 */
export async function weighingApp(options: { plateAttempts?: number } = {}) {
  const context = await phase3App();
  const { database, call, app, companies, products } = context;
  await seedStaff(database, "atasan", { approvals: "EDIT" });
  await seedStaff(database, "lapangan", { security_check: "CREATE", qc: "CREATE", unloading: "CREATE", loading: "CREATE", sealing: "CREATE" });
  await seedStaff(database, "admin4", { registrations: "EDIT", reports: "VIEW", gate: "CREATE" });
  const wbIn = await seedWeighbridge(database, { code: "WB-IN", directions: ["IN"], cameraWeigh1: 3, cameraWeigh2: 4, plateAttempts: options.plateAttempts ?? 1 });
  const wbOut = await seedWeighbridge(database, { code: "WB-OUT", directions: ["OUT"], cameraWeigh1: 1, cameraWeigh2: 2, plateAttempts: options.plateAttempts ?? 1 });
  const place = await seedDestination(database, "Gudang Uji Timbang", companies.customer1);
  // the seeded rules are valid from the day the migration ran, which can be after the test clock's date
  await database.query("update exception_rules set valid_from = '2026-01-01'");

  /** A request of the weighbridge program, signed with the station key. */
  const station = (key: string, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: { "x-station-key": key }, ...(payload ? { payload } : {}) });
  let requestNo = 0;
  /** POST /api/weighbridge/weigh with a fresh request id unless one is given. */
  const weigh = (key: string, body: { cardUid: string; weightKg: number; plateRead: string | null; requestId?: string }) =>
    station(key, "POST", "/api/weighbridge/weigh", { requestId: `req-${++requestNo}-${Date.now()}`, ...body });

  const checkIn = async (token: string, cardUid: string) => {
    const response = await call("POST", "/api/gate/check-in", "pos", { token, cardUid });
    if (response.statusCode !== 200) throw new Error(`check-in failed: ${response.body}`);
  };

  /** An incoming truck, registered by supplier1 and checked in with a new card. */
  const incoming = async (seed: IncomingSeed = {}): Promise<SeededTrip> => {
    const n = ++serial;
    const plate = seed.plate ?? `BK ${8000 + n} AA`;
    const contracts = seed.contracts ?? [{ originNetKg: 20_000 }];
    const contractIds: number[] = [];
    for (const [index, contract] of contracts.entries()) {
      contractIds.push(
        await seedContract(database, {
          no: `PC-${n}${index}/UJI`,
          partnerId: companies.supplier1,
          productId: seed.product === "olein" ? products.olein : products.cpo,
          qty: 500_000,
          tolerancePct: contract.tolerancePct ?? 0,
        }),
      );
    }
    const vehicleId = await seedVehicle(database, { plate, ownerId: companies.transporter1 });
    const driver = await seedDriver(database, { name: `Supir Masuk ${n}`, licence: `SIMIN${String(n).padStart(5, "0")}` });
    const cardUid = `C1${String(n).padStart(10, "0")}`;
    await seedCard(database, cardUid);
    const tare = seed.originTareKg ?? 10_000;
    const created = await call("POST", "/api/registrations", "pks1", {
      direction: "IN",
      submit: true,
      transporterId: companies.transporter1,
      plannedDate: "2026-11-20",
      allocations: contractIds.map((contractId) => ({ contractId })),
      trips: [
        {
          vehicle: { id: vehicleId },
          driver: { id: driver },
          letters: contracts.map((contract, index) => ({
            allocationSeq: index + 1,
            handoverNo: `PNY-${n}-${index + 1}`,
            spbNo: `SPB-${n}-${index + 1}`,
            spbDate: "2026-11-19",
            ...(contract.originNetKg === null ? {} : { originGrossKg: (contract.originNetKg ?? 20_000) + tare, originTareKg: tare, originNetKg: contract.originNetKg ?? 20_000 }),
            quality: { FFA: 3.1 },
          })),
        },
      ],
    });
    if (created.statusCode !== 201) throw new Error(`registration failed: ${created.body}`);
    const trip = created.json().registration.trips[0];
    if (trip.status !== "ISSUED") throw new Error(`trip not issued: ${created.body}`);
    await checkIn(trip.spj.barcodeToken, cardUid);
    return { tripId: trip.id, cardUid, plateNo: plate.replace(/\s/g, ""), vehicleId };
  };

  /** An outgoing truck of transporter1 for one or more new DOs, checked in with a new card. */
  const outgoing = async (seed: OutgoingSeed = {}): Promise<SeededTrip & { doIds: number[] }> => {
    const n = ++serial;
    const plate = seed.plate ?? `BK ${7000 + n} BB`;
    const product = seed.product === "packed" ? products.packed : products.olein;
    const sale = await seedContract(database, { no: `SC-${n}/UJI`, direction: "OUT", partnerId: companies.customer1, productId: product, qty: 1_000_000, uom: seed.product === "packed" ? "karton" : "kg" });
    const doIds: number[] = [];
    for (const qty of seed.dos ?? [30_000]) {
      const created = await call("POST", "/api/delivery-orders", "logistics", {
        doDate: "2026-11-20", contractId: sale, qty, destinationId: place, deliveryFrom: "2026-11-20", deliveryUntil: "2026-11-30", transporterId: companies.transporter1,
      });
      if (created.statusCode !== 201) throw new Error(`DO failed: ${created.body}`);
      const order = created.json().deliveryOrder as { id: number };
      await call("POST", `/api/delivery-orders/${order.id}/send`, "logistics", {});
      await call("POST", `/api/delivery-orders/${order.id}/accept`, "angkut1", {});
      doIds.push(order.id);
    }
    const vehicleId = await seedVehicle(database, { plate, ownerId: companies.transporter1, capacityKg: 60_000 });
    const tareKg = seed.tareKg === undefined ? 15_000 : seed.tareKg;
    if (tareKg !== null) await database.query("update vehicles set tare_kg = $1 where id = $2", [tareKg, vehicleId]);
    const driver = await seedDriver(database, { name: `Supir Keluar ${n}`, licence: `SIMOUT${String(n).padStart(5, "0")}` });
    const cardUid = `C2${String(n).padStart(10, "0")}`;
    await seedCard(database, cardUid);
    const created = await call("POST", "/api/registrations", "angkut1", {
      direction: "OUT",
      submit: true,
      closeCargo: seed.closeCargo ?? false,
      flexiBag: seed.flexiBag ?? false,
      plannedDate: "2026-11-20",
      allocations: doIds.map((deliveryOrderId) => ({ deliveryOrderId })),
      trips: [{ vehicle: { id: vehicleId }, driver: { id: driver }, handoverNo: `PNY-K${n}` }],
    });
    if (created.statusCode !== 201) throw new Error(`registration failed: ${created.body}`);
    const trip = created.json().registration.trips[0];
    if (trip.status !== "ISSUED") throw new Error(`trip not issued: ${created.body}`);
    await checkIn(trip.spj.barcodeToken, cardUid);
    // an unverified vehicle would send the registration to review; it loses its verification after check-in
    if (seed.verified === false) await database.query("update vehicles set verified_at = null where id = $1", [vehicleId]);
    return { tripId: trip.id, cardUid, plateNo: plate.replace(/\s/g, ""), vehicleId, doIds };
  };

  /**
   * Test shortcut for the field steps: every waiting step before `stepCode` that is not a weighing is marked
   * done (an optional one skipped), and `stepCode` becomes READY.
   */
  const forceReady = async (tripId: number, stepCode: string) => {
    await database.query(
      `update trip_steps s set status = case when f.is_optional then 'SKIPPED' else 'DONE' end, result = case when f.is_optional then null else 'PASS' end
       from trips t join registrations r on r.id = t.registration_id, flow_steps f
       where s.trip_id = $1 and t.id = s.trip_id and f.site_id = t.site_id and f.flow_code = r.flow_code and f.step_code = s.step_code
         and s.status in ('PENDING', 'READY') and s.step_code not like 'WEIGH%'
         and s.seq < (select seq from trip_steps where trip_id = $1 and step_code = $2 order by attempt desc limit 1)`,
      [tripId, stepCode],
    );
    await database.query("update trip_steps set status = 'READY', ready_at = now() where trip_id = $1 and step_code = $2 and status = 'PENDING'", [tripId, stepCode]);
    await database.query("update trips set current_step = $2 where id = $1", [tripId, stepCode]);
  };

  const steps = async (tripId: number) =>
    database.query<{ step_code: string; attempt: number; status: string; result: string | null }>(
      "select step_code, attempt, status, result from trip_steps where trip_id = $1 order by seq, attempt",
      [tripId],
    );
  const tripRow = async (tripId: number) =>
    (await database.query<Record<string, unknown>>("select status, outcome, gross_kg, tare_kg, net_kg, current_step, exited_at from trips where id = $1", [tripId]))[0];
  const allocations = async (tripId: number) =>
    database.query<{ seq: number; net_kg: number | null; qty_actual: string | null; split_method: string | null }>(
      "select seq, net_kg, qty_actual::text as qty_actual, split_method from trip_allocations where trip_id = $1 order by seq",
      [tripId],
    );

  return { ...context, wbIn, wbOut, place, station, weigh, incoming, outgoing, forceReady, steps, tripRow, allocations };
}
