// The control room (docs/fase-6-rancangan.md): the live plant map for staff holding the dashboard module.
//   GET /api/control-room/state      the whole state once
//   GET /api/control-room/stream     the same state as server-sent events, sent again when it changes
//   GET /api/control-room/trips/:id  one trip's timeline
//   GET /api/control-room/plan.svg   the plan drawing (the made-up demo plan until one is imported)
// The web app reads the stream with fetch and the bearer header; EventSource cannot send that header.
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { accountOf, type Guards } from "../auth/guard.js";
import { covers } from "../auth/permissions.js";
import { forbidden } from "../errors.js";
import { idParams } from "../http.js";
import { DEMO_PLAN_SVG } from "./demo-plan.js";
import { readPlanSvg } from "./plan.js";
import { computeState } from "./state.js";
import { tripTimeline } from "./timeline.js";
import { StateWatcher } from "./watcher.js";

export const STATE_INTERVAL_MS = 2_000;
export const HEARTBEAT_MS = 15_000;

export interface ControlRoomOptions {
  /** How often the shared watcher recomputes the state while clients listen. */
  intervalMs?: number;
  heartbeatMs?: number;
}

type Context = Pick<AppContext, "config" | "database" | "now">;

export function registerControlRoomRoutes(app: FastifyInstance, context: Context, guards: Guards, options: ControlRoomOptions = {}) {
  // `dashboard` is not in ModuleCode (src/auth/permissions.ts), so the level is checked here
  async function requireDashboard(request: FastifyRequest): Promise<void> {
    if (!covers(accountOf(request).permissions.dashboard, "VIEW")) throw forbidden();
  }
  const viewers = { preHandler: [guards.authenticate, guards.requireInternal, requireDashboard] };

  const siteCode = async () => (await context.database.query<{ code: string }>("select code from sites order by id limit 1"))[0]?.code ?? null;
  const compute = () => computeState(context.database, context.now(), context.config.files.dir);

  const watcher = new StateWatcher({
    compute,
    intervalMs: options.intervalMs ?? STATE_INTERVAL_MS,
    heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
    onError: (error) => app.log.error({ err: error }, "control room state failed"),
  });
  const streams = new Set<PassThrough>();
  // preClose: open streams would otherwise keep the server from closing
  app.addHook("preClose", async () => {
    watcher.stop();
    for (const stream of streams) stream.end();
  });

  app.get("/api/control-room/state", viewers, async () => compute());

  app.get("/api/control-room/stream", viewers, async (_request, reply) => {
    const stream = new PassThrough();
    streams.add(stream);
    const leave = watcher.subscribe((frame) => {
      stream.write(frame);
    });
    // Fastify destroys the stream when the client goes away; ending it on shutdown ends the response
    stream.on("close", () => {
      leave();
      streams.delete(stream);
    });
    // the first bytes send the headers at once, before the first state is ready
    stream.write(": connected\n\n");
    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .header("x-accel-buffering", "no")
      .send(stream);
  });

  app.get("/api/control-room/trips/:id", viewers, async (request) => {
    const { id } = idParams.parse(request.params);
    return tripTimeline(context.database, id, context.now());
  });

  app.get("/api/control-room/plan.svg", viewers, async (_request, reply) => {
    const code = await siteCode();
    const svg = (code ? await readPlanSvg(context.config.files.dir, code) : null) ?? DEMO_PLAN_SVG;
    return reply
      .header("content-type", "image/svg+xml; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .header("cache-control", "private, no-cache")
      .send(svg);
  });

  return { watcher };
}
