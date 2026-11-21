import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** An error the client is meant to see: HTTP status, a stable code, and a short Indonesian message. */
export class AppError extends Error {
  override name = "AppError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Per-field messages of a VALIDATION error. */
    readonly fields?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

const INVALID = "Data yang dikirim tidak valid.";

/** A 400 VALIDATION for a rule that the Zod schema of the route cannot express. */
export const invalid = (field: string, message: string) => new AppError(400, "VALIDATION", INVALID, [{ field, message }]);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
export const duplicate = (message: string) => new AppError(409, "DUPLICATE", message);
/** A change the current status does not allow. */
export const invalidState = (message: string) => new AppError(409, "INVALID_STATE", message);
export const forbidden = () => new AppError(403, "FORBIDDEN", "Anda tidak berhak membuka bagian ini.");
/** A business rule refused the request: 409 with the rule's own code. */
export const refused = (code: string, message: string) => new AppError(409, code, message);

export const notConfigured = (what: string) => new AppError(503, "NOT_CONFIGURED", `${what} belum diatur di server.`);

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } });
  }
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: {
        code: "VALIDATION",
        message: INVALID,
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
