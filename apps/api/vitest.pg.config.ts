import { defineConfig } from "vitest/config";

// `npm run test:pg`: the same tests, with every database from test/helpers on a real PostgreSQL server reached
// through the postgres.js driver the production code uses. The server is the one in DATABASE_URL of .env; each
// test gets its own database tr_test_<run>_<random>, dropped when the test ends.
export default defineConfig({
  test: {
    // *.pg-test.ts: tests only a server can run (requests overlapping on separate connections)
    include: ["test/**/*.test.ts", "test/**/*.pg-test.ts"],
    globalSetup: ["test/pg/global-setup.ts"],
    setupFiles: ["test/pg/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each running test holds a few server connections and a database copy; four at a time stays far below
    // the default max_connections of 100 and the memory of a 16 GB laptop.
    maxWorkers: 4,
  },
});
