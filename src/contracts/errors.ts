// Error HTTP del contrato — DECISIONS.md fija la forma:
// `{ "error": { "code": string, "message": string } }` y los status
// (400 input inválido sin registrar orden · 404 usuario inexistente ·
// 409 idempotency key con otro payload · 422 cancelar no-NEW).

import { z } from "zod";

/** Body de error de cualquier ruta (4xx/5xx). */
export const ApiErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/**
 * Códigos estables del contrato (DECISIONS.md fija los status, no los
 * códigos; estos nombres son parte del contrato revisado por el
 * de integración antes del build).
 */
export const API_ERROR_CODES = {
  /** 400 — body/params inválidos (Zod). No crea orden. */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  /** 400 — instrumento MONEDA: no operable (DECISIONS.md). */
  INSTRUMENT_NOT_OPERABLE: "INSTRUMENT_NOT_OPERABLE",
  /** 404 — instrumento inexistente (por instrumentId|ticker), sin orden. */
  INSTRUMENT_NOT_FOUND: "INSTRUMENT_NOT_FOUND",
  /** 404 — usuario inexistente. */
  USER_NOT_FOUND: "USER_NOT_FOUND",
  /** 404 — orden inexistente (DELETE /orders/:orderId). */
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  /** 409 — misma Idempotency-Key con payload distinto. */
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  /** 422 — cancelar una orden que no está NEW. */
  ORDER_NOT_CANCELLABLE: "ORDER_NOT_CANCELLABLE",
  /** 404 — ruta o método inexistente (sin handler). */
  NOT_FOUND: "NOT_FOUND",
  /** 400 — body JSON malformado (no parsea). */
  INVALID_JSON: "INVALID_JSON",
  /** 413 — body por encima del límite de `express.json()`. */
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  /** 500 — error inesperado; el detalle no viaja al cliente. */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
export type ApiErrorCode =
  (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/** Constructor del body de error (única forma permitida de armarlo). */
export const apiErrorBody = (code: ApiErrorCode, message: string): ApiErrorBody => ({
  error: { code, message },
});
