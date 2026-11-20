import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** An error the client is meant to see: HTTP status, a stable code, and a short Indonesian message. */
export class AppError extends Error {
  override name = "AppError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notConfigured = (what: string) => new AppError(503, "NOT_CONFIGURED", `${what} belum diatur di server.`);

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: {
        code: "VALIDATION",
        message: "Data yang dikirim tidak valid.",
        fields: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
      },
    });
  }
  const status = (error as FastifyError).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return reply.code(status).send({ error: { code: "BAD_REQUEST", message: "Permintaan tidak dapat dibaca." } });
  }
  request.log.error({ err: error }, "unhandled error");
  return reply.code(500).send({ error: { code: "INTERNAL", message: "Terjadi kesalahan di server." } });
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Alamat tidak ditemukan." } });
}
