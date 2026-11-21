// The routes the weighbridge program calls, signed with the station key (X-Station-Key), not a user account.
// Every answer, errors included, carries `message` for the screen and `speech` for the voice.
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Orm } from "../db/client.js";
import { exceptions, weighbridgeRequests } from "../db/schema.js";
import { AppError, violatedUnique } from "../errors.js";
import { stationAnswer } from "../exceptions/decide.js";
import { expireStaleExceptions, openException, pendingSpoken, recordLiveWeight } from "../exceptions/service.js";
import { idParams } from "../http.js";
import { speak } from "../speech/engine.js";
import { createStationGuard, stationOf } from "../stations/guard.js";
import { checkStationPin, PIN_PATTERN } from "../stations/pin.js";
import { readWeighbridgeConfig } from "../stations/routes.js";
import { proceed } from "./flow.js";
import { messages, weighbridgeError } from "./messages.js";
import { loadWeighContext, tripOfCard, writeStationAudit } from "./service.js";
import { say } from "./speech.js";
import { loadWeighTrip } from "./view.js";

const weightField = z.number("Berat harus angka.").int("Berat harus kilogram bulat.").min(0, "Berat tidak boleh negatif.").max(200_000, "Berat terlalu besar.");
const heartbeatBody = z.object({ weightKg: weightField });
const cancelBody = z.object({ reason: z.enum(["TRUCK_LEFT", "OPERATOR"], "Alasan harus TRUCK_LEFT atau OPERATOR.") });
const pinBody = z.object({ pin: z.string("PIN wajib diisi.").regex(PIN_PATTERN, "PIN harus 4 sampai 8 angka.") });
const speechQuery = z.object({ text: z.string("Teks wajib diisi.").trim().min(1, "Teks wajib diisi.").max(300, "Teks terlalu panjang.") });

const weighBody = z.object({
  cardUid: z.string("UID kartu wajib diisi.").trim().min(1, "UID kartu wajib diisi.").max(40, "UID kartu terlalu panjang."),
  weightKg: z.number("Berat harus angka.").int("Berat harus kilogram bulat.").positive("Berat harus lebih dari 0.").max(200_000, "Berat terlalu besar."),
  plateRead: z.string("Plat harus berupa teks.").trim().max(20, "Plat terlalu panjang.").nullable().optional(),
  requestId: z.string("Nomor permintaan wajib diisi.").regex(/^[A-Za-z0-9._:-]{8,64}$/, "Nomor permintaan 8 sampai 64 huruf, angka, titik, titik dua, garis bawah, atau tanda minus."),
});

/** The stored answer of a request sent before, if any. */
async function storedAnswer(orm: Orm, stationId: number, requestId: string) {
  const [row] = await orm
    .select({ statusCode: weighbridgeRequests.statusCode, response: weighbridgeRequests.response })
    .from(weighbridgeRequests)
    .where(and(eq(weighbridgeRequests.stationId, stationId), eq(weighbridgeRequests.requestId, requestId)));
  return row ?? null;
}

/** Dates and other values as they will be stored in jsonb, so a repeated request gets exactly the same body. */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

export function registerWeighbridgeRoutes(app: FastifyInstance, context: AppContext): void {
  const orm = context.database.db;
  const stationOnly = { preHandler: [createStationGuard(orm)] };

  app.get("/api/weighbridge/card/:uid", stationOnly, async (request) => {
    const station = stationOf(request);
    const config = readWeighbridgeConfig(station.config);
    const tripId = await tripOfCard(orm, String((request.params as { uid?: unknown }).uid ?? ""));
    const weigh = await loadWeighContext(orm, tripId, config.directions);
    const trip = await loadWeighTrip(orm, tripId);
    return {
      trip,
      stage: weigh.stage,
      kind: weigh.kind,
      camera: weigh.stage === 1 ? config.cameraWeigh1 : config.cameraWeigh2,
      expected: {
        plateNo: weigh.plateNo,
        plateDisplay: weigh.plateDisplay,
        docGrossKg: weigh.trip.docGrossKg,
        docNetKg: weigh.trip.docNetKg,
        vehicleTareKg: weigh.vehicle?.tareKg ?? null,
      },
      ...messages.card(weigh.plateDisplay, weigh.stage, weigh.kind),
    };
  });

  app.post("/api/weighbridge/weigh", stationOnly, async (request, reply) => {
    const body = weighBody.parse(request.body);
    const station = stationOf(request);
    const config = readWeighbridgeConfig(station.config);
    const known = await storedAnswer(orm, station.id, body.requestId);
    if (known) return reply.code(known.statusCode).send(known.response);
    const now = context.now();
    try {
      const answer = await orm.transaction(async (tx) => {
        const tripId = await tripOfCard(tx, body.cardUid);
        const weigh = await loadWeighContext(tx, tripId, config.directions, true);
        await expireStaleExceptions(tx, now);
        const open = await openException(tx, tripId);
        let outcome: { statusCode: number; result: "SAVED" | "PENDING" | "PLATE_RETRY"; body: Record<string, unknown> };
        if (open) {
          // one open request per trip: asking again returns it, with the new weight
          await recordLiveWeight(tx, open, body.weightKg, now);
          const [current] = await tx.select().from(exceptions).where(eq(exceptions.id, open.id));
          const shown = current ?? open;
          outcome = { statusCode: 202, result: "PENDING", body: { result: "PENDING", exception: { id: shown.id, type: shown.type }, ...pendingSpoken(shown) } };
        } else {
          const input = { stationId: station.id, weightKg: body.weightKg, plateRead: body.plateRead ?? null, cardUid: body.cardUid, ip: request.ip };
          outcome = await proceed(tx, weigh, input, { after: null, plateAttempts: config.plateAttempts, plateCheck: "MATCH", mode: "AUTO" }, now);
        }
        const response = asJson(outcome.body);
        await tx.insert(weighbridgeRequests).values({
          stationId: station.id,
          requestId: body.requestId,
          tripId,
          tripStepId: weigh.step.id,
          result: outcome.result,
          statusCode: outcome.statusCode,
          response,
          createdAt: now,
        });
        return { statusCode: outcome.statusCode, response };
      });
      return reply.code(answer.statusCode).send(answer.response);
    } catch (error) {
      // The same request sent twice at the same moment: the second one gets the first one's answer. It usually
      // waits for the trip lock and then finds the step done (NOT_READY), more rarely it breaks the primary key;
      // either way the answer stored for this request id is the one to give.
      if (error instanceof AppError || violatedUnique(error) === "weighbridge_requests_pkey") {
        const stored = await storedAnswer(orm, station.id, body.requestId);
        if (stored) return reply.code(stored.statusCode).send(stored.response);
      }
      throw error;
    }
  });

  // the station PIN opens manual plate entry on the program; wrong attempts are limited
  app.post("/api/weighbridge/manual-plate", stationOnly, async (request) => {
    const { pin } = pinBody.parse(request.body ?? {});
    const station = stationOf(request);
    const now = context.now();
    const check = await checkStationPin(orm, station.id, pin, now);
    if (check.ok) {
      await writeStationAudit(orm, station.id, request.ip, now, { action: "MANUAL_PLATE_OPENED", entityType: "station", entityId: station.id, before: null, after: null });
      return { unlocked: true, ...messages.manualPlateOpen() };
    }
    if (check.code === "PIN_NOT_SET") throw weighbridgeError(409, "PIN_NOT_SET", messages.pinNotSet());
    if (check.code === "PIN_LOCKED") throw weighbridgeError(429, "PIN_LOCKED", messages.pinLocked(), { lockedUntil: check.until.toISOString() });
    throw weighbridgeError(403, "PIN_WRONG", messages.pinWrong(check.attemptsLeft), { attemptsLeft: check.attemptsLeft });
  });

  // the audio of one speech segment; 204 when the engine makes none (TTS_ENGINE=off)
  app.get("/api/weighbridge/speech", stationOnly, async (request, reply) => {
    const { text } = speechQuery.parse(request.query);
    const audio = await speak(context.speech.engine, context.speech.cache, text);
    if (!audio) return reply.code(204).send();
    return reply.header("content-type", "audio/wav").header("cache-control", "private, max-age=86400").send(Buffer.from(audio));
  });

  /** The request of this station, locked, after lazy expiry; 404 for another station's request. */
  const stationException = async (tx: Orm, stationId: number, id: number, now: Date) => {
    await expireStaleExceptions(tx, now);
    const [row] = await tx.select().from(exceptions).where(eq(exceptions.id, id)).for("update");
    if (!row || row.stationId !== stationId) throw weighbridgeError(404, "NOT_FOUND", say("Permintaan tidak ditemukan."));
    return row;
  };

  app.post("/api/weighbridge/exceptions/:id/heartbeat", stationOnly, async (request) => {
    const { id } = idParams.parse(request.params);
    const { weightKg } = heartbeatBody.parse(request.body ?? {});
    const station = stationOf(request);
    const now = context.now();
    return orm.transaction(async (tx) => {
      const row = await stationException(tx, station.id, id, now);
      if (row.status === "PENDING") await recordLiveWeight(tx, row, weightKg, now);
      return stationAnswer(tx, row);
    });
  });

  app.post("/api/weighbridge/exceptions/:id/cancel", stationOnly, async (request) => {
    const { id } = idParams.parse(request.params);
    const { reason } = cancelBody.parse(request.body ?? {});
    const station = stationOf(request);
    const now = context.now();
    return orm.transaction(async (tx) => {
      const row = await stationException(tx, station.id, id, now);
      if (row.status === "PENDING") {
        await tx
          .update(exceptions)
          .set({ status: "CANCELLED", context: sql`${exceptions.context} || ${JSON.stringify({ cancelReason: reason })}::jsonb` })
          .where(eq(exceptions.id, id));
        await writeStationAudit(tx, station.id, request.ip, now, { action: "EXCEPTION_CANCELLED", entityType: "exception", entityId: id, before: { status: "PENDING" }, after: { status: "CANCELLED" }, reason });
      } else if (row.status !== "CANCELLED" && row.status !== "EXPIRED") {
        throw weighbridgeError(409, "ALREADY_DECIDED", say("Permintaan ini sudah diputuskan."));
      }
      return { status: "CANCELLED", ...messages.cancelled() };
    });
  });
}
