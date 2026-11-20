import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test starts its own in-process PostgreSQL (PGlite) and applies the migrations.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
