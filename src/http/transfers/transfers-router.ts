// UC-5 — POST /api/users/:userId/transfers (FASE 4 — Célula G).
//
// Router factory con DI (patrón C — igual que orders-router de la Célula
// E): deps = las INTERFACES de src/domain/ports, que submitTransfer
// (src/application) orquesta. El handler es FINO:
//   - Zod estricto en el borde (params + body + Idempotency-Key) ⇒ 400
//     VALIDATION_ERROR SIN crear orden;
//   - submitTransfer ⇒ 201 OrderResponse (transferencia = order; también
//     para REJECTED persistida — DECISIONS.md);
//   - SubmitTransferError ⇒ su status + apiErrorBody (los códigos de la
//     transferencia son TODOS del contrato: sin cast, a diferencia de E);
//   - cualquier otro error propaga (500 no controlado — default Express).
//
// validationMessage / parseIdempotencyKeyHeader / toOrderResponse son
// espejos LOCALES de los privados de orders-router.ts (Célula E): no se
// editan archivos de otras células ni se exportan helpers compartidos sin
// decisión del orquestador.

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  API_ERROR_CODES,
  CreateTransferParamsSchema,
  CreateTransferRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  type ApiErrorBody,
  type OrderResponse,
  apiErrorBody,
  serializeLocalTimestamp,
  serializeMoneyArs,
} from "../../contracts/index.js";
import {
  SubmitTransferError,
  submitTransfer,
  type SubmitTransferDeps,
  type SubmitTransferResult,
} from "../../application/transfers/submit-transfer.js";

/** Deps del slice de transfers: los PUERTOS (patrón C), orquestados por submitTransfer. */
export type TransfersRouterDeps = SubmitTransferDeps;

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto) — espejo de E. */
const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");

/**
 * Idempotency-Key del header (OPCIONAL): ausente ⇒ null; inválida
 * (no string / vacía / > 64) ⇒ 400 SIN crear orden — espejo de E.
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

/** Fila persistida (SubmitTransferResult) → OrderResponse del contrato. */
const toOrderResponse = (result: SubmitTransferResult): OrderResponse => {
  const { order } = result;
  // El mapper de infra (célula B) ya falla ruidosamente ante un NULL acá:
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

export const buildTransfersRouter = (deps: TransfersRouterDeps): Router => {
  const router = Router();

  router.post(
    "/users/:userId/transfers",
    async (req: Request, res: Response) => {
      // Borde: params de ruta (userId) con Zod estricto, sin cast.
      const params = CreateTransferParamsSchema.safeParse(req.params);
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

      // Borde: body con el contrato estricto (amountArs > 0 — número o
      // string parseado con Decimal; side CASH_IN/CASH_OUT) ⇒ 400 SIN orden.
      const body = CreateTransferRequestSchema.safeParse(req.body);
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
        const result = await submitTransfer(deps, {
          userId: params.data.userId,
          amountArs: body.data.amountArs,
          side: body.data.side,
          idempotencyKey: header.key,
        });
        // 201 SIEMPRE que se persistió (FILLED o REJECTED).
        res.status(201).json(toOrderResponse(result));
      } catch (error) {
        if (error instanceof SubmitTransferError) {
          // Los códigos de la transferencia son todos ApiErrorCode (sin
          // INSTRUMENT_NOT_FOUND custom — a diferencia de E, sin cast).
          res.status(error.status).json(apiErrorBody(error.code, error.message));
          return;
        }
        throw error; // 500 no controlado (default de Express)
      }
    },
  );

  return router;
};
