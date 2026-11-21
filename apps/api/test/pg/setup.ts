// Runs in every test file of `npm run test:pg`.
import { afterAll } from "vitest";
import { closeAdmin } from "./server.js";

afterAll(async () => {
  await closeAdmin();
});
