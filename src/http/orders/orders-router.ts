// UC-3 — POST /api/users/:userId/orders.
//
// Router factory con DI (patrón C): deps = las INTERFACES de src/domain/ports,
// que submitOrder (src/application) orquesta. El handler es FINO:
//   - Zod estricto en el borde (params + body + Idempotency-Key) ⇒ 400
//     VALIDATION_ERROR SIN crear orden;
//   - submitOrder ⇒ 201 OrderResponse (también para REJECTED/CANCELLED
//     persistidas — DECISIONS.md);
//   - SubmitOrderError ⇒ su status + apiErrorBody;
//   - cualquier otro error propaga (500 no controlado — default de Express).

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  API_ERROR_CODES,
  CreateOrderParamsSchema,
  CreateOrderRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  type ApiErrorBody,
  type ApiErrorCode,
  type OrderResponse,
  apiErrorBody,
  serializeLocalTimestamp,
  serializeMoneyArs,
} from "../../contracts/index.js";
import {
  SubmitOrderError,
  submitOrder,
  type SubmitOrderDeps,
  type SubmitOrderResult,
} from "../../application/orders/submit-order.js";

/** Deps del slice de orders: los PUERTOS (patrón C), orquestados por submitOrder. */
export type OrdersRouterDeps = SubmitOrderDeps;

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto). */
const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");

/**
 * Idempotency-Key del header (OPCIONAL): ausente ⇒ null; inválida
 * (no string / vacía / > 64) ⇒ invalid, y el borde responde 400 SIN crear orden.
 */
const parseIdempotencyKeyHeader = (
  headers: Request["headers"],
):
  | { readonly ok: true; readonly key: string | null }
  | { readonly ok: false } => {
  const raw = headers[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return { ok: true, key: null };
  }
  const parsed = IdempotencyKeySchema.safeParse(value);
  return parsed.success ? { ok: true, key: parsed.data } : { ok: false };
};

/** Fila persistida (SubmitOrderResult) → OrderResponse del contrato. */
const toOrderResponse = (result: SubmitOrderResult): OrderResponse => {
  const { order } = result;
  // El mapper de infra ya falla ruidosamente ante un NULL acá:
  // este estrechamiento es sólo de tipos (inalcanzable en runtime).
  if (order.instrumentId === null) {
    throw new Error("Orden persistida sin instrumentId (inalcanzable).");
  }
  return {
    id: order.id,
    instrumentId: order.instrumentId,
    side: order.side,
    type: order.type,
    timeInForce: order.timeInForce,
    status: order.status,
    size: order.sizeShares,
    price: order.priceArs === null ? null : serializeMoneyArs(order.priceArs),
    filledPrice:
      order.filledPriceArs === null
        ? null
        : serializeMoneyArs(order.filledPriceArs),
    filledAt:
      order.filledAt === null ? null : serializeLocalTimestamp(order.filledAt),
    datetime: serializeLocalTimestamp(order.datetime),
    reason: result.reason,
  };
};

export const buildOrdersRouter = (deps: OrdersRouterDeps): Router => {
  const router = Router();

  router.post(
    "/users/:userId/orders",
    async (req: Request, res: Response) => {
      // Borde: params de ruta (userId) con Zod estricto, sin cast.
      const params = CreateOrderParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(
          apiErrorBody(
            API_ERROR_CODES.VALIDATION_ERROR,
            `Parámetros inválidos: ${validationMessage(params.error)}`,
          ),
        );
        return;
      }

      // Borde: Idempotency-Key opcional (ausente ⇒ null; inválida ⇒ 400).
      const header = parseIdempotencyKeyHeader(req.headers);
      if (!header.ok) {
        const body: ApiErrorBody = apiErrorBody(
          API_ERROR_CODES.VALIDATION_ERROR,
          `Header ${IDEMPOTENCY_KEY_HEADER} inválido: se espera string de 1..64 caracteres.`,
        );
        res.status(400).json(body);
        return;
      }

      // Borde: body con el contrato estricto (XORs del brief — 400 SIN orden).
      const body = CreateOrderRequestSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(
          apiErrorBody(
            API_ERROR_CODES.VALIDATION_ERROR,
            `Body inválido: ${validationMessage(body.error)}`,
          ),
        );
        return;
      }

      try {
        const result = await submitOrder(deps, {
          userId: params.data.userId,
          request: body.data,
          idempotencyKey: header.key,
        });
        // 201 SIEMPRE que se persistió (FILLED/NEW/REJECTED/CANCELLED).
        res.status(201).json(toOrderResponse(result));
      } catch (error) {
        if (error instanceof SubmitOrderError) {
          // Errores de aplicación → status + body del contrato. El cast
          // documenta que INSTRUMENT_NOT_FOUND no está en ApiErrorCode (OPEN).
          res
            .status(error.status)
            .json(apiErrorBody(error.code as ApiErrorCode, error.message));
          return;
        }
        throw error; // 500 no controlado (default de Express)
      }
    },
  );

  return router;
};