// Every route against the module level it needs: an account one level below is refused with 403, an account with
// exactly that level gets past the guard (the answer is then whatever the route says about the request: 400, 404,
// 503 without an external system, never 403). Staff-only routes also refuse a partner account with high levels.
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModuleCode, PermissionLevel, Permissions } from "../src/auth/permissions.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Database } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { TEST_JWT_SECRET } from "./helpers/app.js";
import { bearer, seedPartner, seedPartnerUser, seedStaff } from "./helpers/users.js";

type Method = "GET" | "POST" | "PUT" | "PATCH";
type Need = [ModuleCode, PermissionLevel];
interface Row {
  method: Method;
  url: string;
  /** Any one of these is enough; empty: any staff account with at least one permission. */
  needs: Need[];
  /** Refused to partner accounts whatever their levels. */
  staffOnly: boolean;
}

const row = (method: Method, url: string, needs: Need[], staffOnly = false): Row => ({ method, url, needs, staffOnly });
const ROUTES: Row[] = [
  row("GET", "/api/contracts", [["contracts", "VIEW"]]),
  row("POST", "/api/admin/sync/odoo", [["contracts", "EDIT"]], true),
  row("GET", "/api/admin/sync/runs", [["contracts", "VIEW"], ["drivers", "VIEW"]], true),

  row("GET", "/api/drivers", [["drivers", "VIEW"]], true),
  row("POST", "/api/drivers", [["drivers", "CREATE"]], true),
  row("POST", "/api/admin/sync/vcf", [["drivers", "EDIT"]], true),

  row("GET", "/api/vehicles", [["vehicles", "VIEW"]]),
  row("GET", "/api/vehicle-types", [["vehicles", "VIEW"], ["registrations", "VIEW"]]),
  row("POST", "/api/vehicles", [["vehicles", "CREATE"]], true),
  row("PATCH", "/api/vehicles/999999", [["vehicles", "EDIT"]], true),

  row("GET", "/api/partners", [], true),

  row("GET", "/api/destinations", [["destinations", "VIEW"]]),
  row("POST", "/api/destinations", [["destinations", "CREATE"]]),
  row("PATCH", "/api/destinations/999999", [["destinations", "EDIT"]]),

  row("GET", "/api/delivery-orders", [["delivery_orders", "VIEW"]]),
  row("GET", "/api/delivery-orders/999999", [["delivery_orders", "VIEW"]]),
  row("POST", "/api/delivery-orders", [["delivery_orders", "CREATE"]], true),
  row("PATCH", "/api/delivery-orders/999999", [["delivery_orders", "EDIT"]], true),
  row("POST", "/api/delivery-orders/999999/send", [["delivery_orders", "EDIT"]], true),
  row("POST", "/api/delivery-orders/999999/close", [["delivery_orders", "EDIT"]], true),
  row("POST", "/api/delivery-orders/999999/cancel", [["delivery_orders", "EDIT"]], true),
  row("POST", "/api/delivery-orders/999999/accept", [["delivery_orders", "EDIT"]]),

  row("GET", "/api/registrations", [["registrations", "VIEW"]]),
  row("GET", "/api/registrations/999999", [["registrations", "VIEW"]]),
  row("POST", "/api/registrations", [["registrations", "CREATE"]]),
  row("PUT", "/api/registrations/999999", [["registrations", "CREATE"]]),
  row("POST", "/api/registrations/999999/submit", [["registrations", "CREATE"]]),
  row("POST", "/api/registrations/999999/approve", [["registrations", "EDIT"]], true),
  row("POST", "/api/registrations/999999/reject", [["registrations", "EDIT"]], true),
  row("POST", "/api/registrations/999999/cancel", [["registrations", "CREATE"]]),

  row("GET", "/api/quality-parameters", [["registrations", "VIEW"]]),
  row("GET", "/api/products", [["delivery_orders", "VIEW"]], true),
  row("GET", "/api/lookup/driver", [["registrations", "CREATE"]]),
  row("GET", "/api/lookup/vehicle", [["registrations", "CREATE"]]),
  row("GET", "/api/lookup/transporters", [["registrations", "CREATE"]]),

  row("GET", "/api/trips", [["gate", "VIEW"], ["registrations", "VIEW"]], true),
  row("GET", "/api/trips/999999/spj", [["registrations", "VIEW"]]),
  row("POST", "/api/trips/999999/spj/printed", [["registrations", "VIEW"]]),
  row("POST", "/api/trips/999999/spj/reissue", [["gate", "EDIT"]]),
  row("POST", "/api/trips/999999/cancel", [["gate", "EDIT"], ["registrations", "CREATE"]]),

  row("GET", "/api/gate/spj/NOTATOKEN", [["gate", "VIEW"]]),
  row("POST", "/api/gate/check-in", [["gate", "CREATE"]]),
  row("POST", "/api/gate/replace-card", [["gate", "EDIT"]]),

  row("GET", "/api/rfid-cards", [["rfid_cards", "VIEW"]]),
  row("POST", "/api/rfid-cards", [["rfid_cards", "CREATE"]]),
  row("PATCH", "/api/rfid-cards/999999", [["rfid_cards", "EDIT"]]),

  row("GET", "/api/admin/users", [["users", "VIEW"]]),
  row("GET", "/api/admin/modules", [["users", "VIEW"]]),
  row("PUT", "/api/admin/users/999999/permissions", [["users", "EDIT"]]),
  row("PATCH", "/api/admin/users/999999", [["users", "EDIT"]]),
];

const BELOW: Record<PermissionLevel, PermissionLevel | null> = { VIEW: null, CREATE: "VIEW", EDIT: "CREATE" };
/** Partner accounts at the top of every module they may hold. */
const PARTNER_TOP: Permissions = { contracts: "EDIT", drivers: "EDIT", vehicles: "EDIT", delivery_orders: "EDIT", registrations: "EDIT" };

let database: Database;
let app: FastifyInstance;
const accounts = new Map<string, { authorization: string }>();
let partnerHeaders: { authorization: string };

/** An account with exactly these permissions, made once per set. */
async function holding(permissions: Permissions) {
  const key = JSON.stringify(Object.entries(permissions).sort());
  const known = accounts.get(key);
  if (known) return known;
  const username = `staff-${accounts.size + 1}`;
  await seedStaff(database, username, permissions);
  const headers = await bearer(app, username);
  accounts.set(key, headers);
  return headers;
}

const send = (route: Row, headers: { authorization: string }) =>
  app.inject({ method: route.method, url: route.url, headers, ...(route.method === "GET" ? {} : { payload: {} }) });

beforeAll(async () => {
  database = await createDb("pglite://memory");
  await migrate(database);
  // the clock stays still, so the access tokens made here do not expire during the run
  const now = new Date("2026-11-20T03:00:00Z");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: "pglite://memory", JWT_SECRET: TEST_JWT_SECRET }), database, now: () => now, logger: false });
  await seedPartnerUser(database, "partner-top", await seedPartner(database, "PT Contoh Serba", { supplier: true, transporter: true }), PARTNER_TOP);
  partnerHeaders = await bearer(app, "partner-top");
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

const label = (route: Row) => `${route.method} ${route.url}`;

describe("route permissions", () => {
  it.each(ROUTES.map((route) => [label(route), route] as const))("%s refuses below its level and lets its level pass", async (_name, route) => {
    // one level below every alternative at once; an account needs some permission to get past NO_ACCESS
    const below: Permissions = {};
    for (const [moduleCode, level] of route.needs) {
      const lower = BELOW[level];
      if (lower) below[moduleCode] = lower;
    }
    if (Object.keys(below).length === 0) Object.assign(below, route.needs.some(([code]) => code === "users") ? { rfid_cards: "VIEW" } : { users: "VIEW" });
    if (route.needs.length > 0) {
      const refused = await send(route, await holding(below));
      expect(refused.statusCode, `${label(route)} with ${JSON.stringify(below)}`).toBe(403);
      expect(refused.json().error.code).toBe("FORBIDDEN");
    }

    const alternatives = route.needs.length > 0 ? route.needs.map(([code, level]) => ({ [code]: level })) : [{ gate: "VIEW" } as Permissions];
    for (const exact of alternatives) {
      const allowed = await send(route, await holding(exact));
      expect(allowed.statusCode, `${label(route)} with ${JSON.stringify(exact)}: ${allowed.body}`).not.toBe(403);
    }

    const partner = await send(route, partnerHeaders);
    if (route.staffOnly) {
      expect(partner.statusCode, `${label(route)} as a partner account`).toBe(403);
      expect(partner.json().error.code).toBe("FORBIDDEN");
    } else if (route.needs.some(([code]) => code in PARTNER_TOP)) {
      expect(partner.statusCode, `${label(route)} as a partner account: ${partner.body}`).not.toBe(403);
    }
  });

  it("answers NO_ACCESS on every route to a staff account without any permission", async () => {
    const nothing = await holding({});
    for (const route of ROUTES) {
      const response = await send(route, nothing);
      expect(response.statusCode, label(route)).toBe(403);
      expect(response.json().error.code, label(route)).toBe("NO_ACCESS");
    }
  });
});
