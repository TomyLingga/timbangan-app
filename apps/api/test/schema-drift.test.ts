// The Drizzle table definitions are written by hand; the SQL migrations are the source of truth.
// This compares every declared table and column with information_schema.columns of the migrated database.
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { emptyDatabase } from "./helpers/app.js";

interface ColumnRow {
  column_name: string;
  data_type: string;
  udt_name: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: "YES" | "NO";
  is_identity: "YES" | "NO";
  column_default: string | null;
}

let database: Database;

beforeAll(async () => {
  database = await emptyDatabase();
  await migrate(database);
});

afterAll(async () => {
  await database.close();
});

const tables: PgTable[] = Object.values(schema).filter((value) => is(value, PgTable));

describe("Drizzle definitions against the migrated database", () => {
  it("declares the tables this slice uses", () => {
    expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual([
      "audit_log",
      "auth_sessions",
      "card_assignments",
      "delivery_order_files",
      "delivery_orders",
      "destinations",
      "document_counters",
      "driver_blocks",
      "drivers",
      "erp_contracts",
      "erp_sync_runs",
      "exception_rules",
      "exceptions",
      "field_submissions",
      "files",
      "flow_steps",
      "gate_scans",
      "gps_sources",
      "gps_unknown_devices",
      "handlings",
      "inspections",
      "modules",
      "notification_deliveries",
      "notifications",
      "partners",
      "product_quality_specs",
      "products",
      "quality_checks",
      "quality_parameters",
      "quality_values",
      "registration_allocations",
      "registrations",
      "rfid_cards",
      "seals",
      "settings",
      "shipment_request_files",
      "shipment_requests",
      "sites",
      "spj_documents",
      "stations",
      "storage_tanks",
      "trip_allocations",
      "trip_files",
      "trip_seals",
      "trip_share_links",
      "trip_steps",
      "trips",
      "user_devices",
      "user_permissions",
      "users",
      "vehicle_last_positions",
      "vehicle_positions",
      "vehicle_tare_history",
      "vehicle_trackers",
      "vehicle_types",
      "vehicles",
      "weighbridge_requests",
      "weighings",
      "zones",
    ]);
  });

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))("%s has the same columns", async (name, table) => {
    const actual = await database.query<ColumnRow>(
      `select column_name, data_type, udt_name, numeric_precision, numeric_scale, is_nullable, is_identity, column_default
       from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
      [name],
    );
    expect(actual.length, `table ${name} does not exist`).toBeGreaterThan(0);

    const describeActual = (row: ColumnRow) => ({
      name: row.column_name,
      type:
        row.data_type === "numeric"
          ? `numeric(${row.numeric_precision}, ${row.numeric_scale})`
          : row.data_type === "ARRAY"
            ? `${row.udt_name.replace(/^_/, "")}[]`
            : row.data_type,
      notNull: row.is_nullable === "NO",
      identity: row.is_identity === "YES",
      hasDefault: row.column_default !== null || row.is_identity === "YES",
    });
    const declared = getTableConfig(table).columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      notNull: column.notNull,
      identity: column.generatedIdentity !== undefined,
      hasDefault: column.hasDefault,
    }));
    const byName = <T extends { name: string }>(rows: T[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(declared)).toEqual(byName(actual.map(describeActual)));
  });
});
