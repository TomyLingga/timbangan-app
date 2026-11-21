// Prints how many tr_test_ databases are on the server of DATABASE_URL; 0 after a clean `npm run test:pg`.
// Run: npx tsx test/pg/leftovers.ts. Prints only the count, never a name or the server address.
import { serverUrl } from "./global-setup.js";
import { adminClient, testDatabases } from "./server.js";

const admin = adminClient(serverUrl());
try {
  console.log(`tr_test_ databases on the server: ${(await testDatabases(admin, "tr_test_")).length}`);
} finally {
  await admin.end();
}
