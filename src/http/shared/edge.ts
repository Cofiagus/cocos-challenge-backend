// Borde HTTP compartido por los routers: funciones puras (sin Express) que
// traducen errores de validación a texto de respuesta y filas persistidas al
// contrato. El texto viaja en el body de los 400 y los campos del
// OrderResponse son los del contrato: cambiarlos cambia la respuesta de la API.
//
// D3 (spec grandes montos): `size` está discriminado por `side` — BUY/SELL lo
// emiten como number entero (o null), CASH_IN/CASH_OUT como string monetario
// de 2 decimales (`serializeMoneyArs`), sin bigint crudo ni notación
// científica. Precios y fechas conservan sus nulls.

import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  serializeLocalTimestamp,
  serializeMoneyArs,
  type OrderRecord,
  type OrderRejectionReason,
  type OrderResponse,
} from "../../contracts/index.js";

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto). */
export const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");

/** Lectura del header Idempotency-Key: válida con key (o null) o inválida. */
export type IdempotencyKeyHeader =
  | { readonly ok: true; readonly key: string | null }
  | { readonly ok: false };

/**
 * Idempotency-Key del header (OPCIONAL): ausente ⇒ null; inválida
 * (no string / vacía / > 64) ⇒ invalid, y el borde responde 400 SIN crear
 * orden. Un header repetido llega como array: manda el primero.
 */
export const parseIdempotencyKeyHeader = (
  headers: IncomingHttpHeaders,
): IdempotencyKeyHeader => {
  const raw = headers[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return { ok: true, key: null };
  }
  const parsed = IdempotencyKeySchema.safeParse(value);
  return parsed.success ? { ok: true, key: parsed.data } : { ok: false };
};

/** Campos del OrderResponse que NO cambian con el side (IDs, precios, fechas). */
const orderResponseCommon = (order: OrderRecord, reason: OrderRejectionReason | null) => {
  // El mapper de infra ya falla ruidosamente ante un NULL acá: este
  // estrechamiento es sólo de tipos (inalcanzable en runtime).
  if (order.instrumentId === null) {
    throw new Error("Orden persistida sin instrumentId (inalcanzable).");
  }
  return {
    id: order.id,
    instrumentId: order.instrumentId,
    type: order.type,
    timeInForce: order.timeInForce,
    status: order.status,
    price: order.priceArs === null ? null : serializeMoneyArs(order.priceArs),
    filledPrice:
      order.filledPriceArs === null
        ? null
        : serializeMoneyArs(order.filledPriceArs),
    filledAt:
      order.filledAt === null ? null : serializeLocalTimestamp(order.filledAt),
    datetime: serializeLocalTimestamp(order.datetime),
    reason,
  };
};

/** Fila persistida + razón de rechazo/cancelación → OrderResponse del contrato. */
export const toOrderResponse = (
  order: OrderRecord,
  reason: OrderRejectionReason | null,
): OrderResponse => {
  const common = orderResponseCommon(order, reason);
  if (order.side === "BUY" || order.side === "SELL") {
    return { ...common, side: order.side, size: order.sizeShares };
  }
  // Cash: la columna física `size` es un monto en ARS; se emite como string
  // canónico de 2 decimales (un size histórico de 123 ⇒ "123.00").
  return {
    ...common,
    side: order.side,
    size: serializeMoneyArs(order.amountArs),
  };
};
