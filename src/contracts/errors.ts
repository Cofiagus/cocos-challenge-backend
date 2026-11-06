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
  /**
   * 503 — el proveedor de cotizaciones (Yahoo) no responde / timeout /
   * rate-limit (spec instruments-current-quotes Rev. 2). Lo traduce el
   * borde HTTP desde `MarketDataServiceUnavailableError`.
   */
  MARKET_DATA_SERVICE_UNAVAILABLE: "MARKET_DATA_SERVICE_UNAVAILABLE",
  /**
   * 503 — la base de datos no atendió el pedido: contención del pool (P2024),
   * `statement_timeout` (SQLSTATE 57014), transacción abortada por Prisma
   * (P2028), timeout de conexión (ETIMEDOUT) o base inalcanzable (P1001,
   * P1008, P1017, SQLSTATE clase 08, 57P01). Reintentable: el manejador
   * central responde 503 con `Retry-After`, nunca 500. El `message` distingue
   * "saturada" (la base está) de "no disponible" (no se llega al servidor).
   */
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
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

/**
 * Falla de disponibilidad del proveedor de cotizaciones (Yahoo Finance).
 *
 * Error de dominio: NO conoce HTTP ni status. El caso de uso lo lanza cuando el
 * proveedor no responde / da timeout / rate-limit; el borde HTTP lo traduce a
 * 503 con MARKET_DATA_SERVICE_UNAVAILABLE. Un ticker sin cotización computable
 * NO se representa con este error: es `null` en la fuente.
 */
export class MarketDataServiceUnavailableError extends Error {
  constructor() {
    super(
      "El servicio de cotizaciones (Yahoo Finance) no está disponible. Intentá nuevamente más tarde.",
    );
    this.name = "MarketDataServiceUnavailableError";
  }
}
