// Global setup of `npm run test:pg`: reads DATABASE_URL from .env with Node's own env-file parser (only that key is
// used; nothing from .env reaches the test processes except the server address), builds one migrated template
// database, and drops every database of the run at the end, also after failed tests.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { TestProject } from "vitest/node";
import { createDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";
import { adminClient, createDatabase, dropDatabase, testDatabases, urlFor } from "./server.js";

export function serverUrl(): string {
  const file = new URL("../../.env", import.meta.url);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error("npm run test:pg reads DATABASE_URL from apps/api/.env, and that file is missing");
  }
  const url = parseEnv(text).DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    throw new Error("npm run test:pg needs DATABASE_URL in .env to be a postgres:// server address");
  }
  return url;
}

export default async function setup(project: TestProject) {
  const url = serverUrl();
  const run = randomBytes(4).toString("hex");
  const template = `tr_test_${run}_template`;
  const admin = adminClient(url);

  const dropAll = async () => {
    for (const name of await testDatabases(admin, `tr_test_${run}_`)) await dropDatabase(admin, name);
  };

  try {
    await createDatabase(admin, template, "template0");
    const database = await createDb(urlFor(url, template));
    try {
      await migrate(database);
    } finally {
      await database.close();
    }
  } catch (error) {
    await dropAll();
    await admin.end();
    throw error;
  }

  project.provide("pgServer", { url, run, template });

  return async () => {
    try {
      await dropAll();
    } finally {
      await admin.end();
    }
  };
}
