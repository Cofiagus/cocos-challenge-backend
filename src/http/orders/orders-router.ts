// UC-3 — POST /api/users/:userId/orders.
//
// Router factory con DI (patrón C): deps = las INTERFACES de src/domain/ports,
// que submitOrder (src/application) orquesta. El handler es FINO:
//   - Zod estricto en el borde (params + body + Idempotency-Key) ⇒ 400
//     VALIDATION_ERROR SIN crear orden;
//   - submitOrder ⇒ 201 OrderResponse (también para REJECTED/CANCELLED
//     persistidas — DECISIONS.md);
//   - SubmitOrderError ⇒ su status + apiErrorBody;
//   - cualquier otro error propaga al manejador central (500 INTERNAL_ERROR).

import { Router } from "express";
import type { Request, Response } from "express";
import {
  API_ERROR_CODES,
  CreateOrderParamsSchema,
  CreateOrderRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  type ApiErrorBody,
  type CreateOrderRequest,
  apiErrorBody,
} from "../../contracts/index.js";
import {
  SubmitOrderError,
  submitOrder,
  type SubmitOrderDeps,
} from "../../application/orders/submit-order.js";
import { IdempotencyConflictError } from "../../application/orders/persist-order-decision.js";
import {
  parseIdempotencyKeyHeader,
  toOrderResponse,
  validationMessage,
} from "../shared/edge.js";

/** Deps del slice de orders: los PUERTOS (patrón C), orquestados por submitOrder. */
export type OrdersRouterDeps = SubmitOrderDeps;

/** Request ya validado en el borde, o el body del 400 que corresponde. */
type ParsedCreateOrder =
  | {
      readonly ok: true;
      readonly userId: number;
      readonly request: CreateOrderRequest;
      readonly idempotencyKey: string | null;
    }
  | { readonly ok: false; readonly body: ApiErrorBody };

const invalidRequest = (message: string): ParsedCreateOrder => ({
  ok: false,
  body: apiErrorBody(API_ERROR_CODES.VALIDATION_ERROR, message),
});

/**
 * Borde: params de ruta (userId), Idempotency-Key opcional y body, con Zod
 * estricto y en ese orden. Cualquier fallo ⇒ 400 SIN crear orden.
 */
const parseCreateOrderRequest = (req: Request): ParsedCreateOrder => {
  const params = CreateOrderParamsSchema.safeParse(req.params);
  if (!params.success) {
    return invalidRequest(
      `Parámetros inválidos: ${validationMessage(params.error)}`,
    );
  }

  const header = parseIdempotencyKeyHeader(req.headers);
  if (!header.ok) {
    return invalidRequest(
      `Header ${IDEMPOTENCY_KEY_HEADER} inválido: se espera string de 1..64 caracteres.`,
    );
  }

  const body = CreateOrderRequestSchema.safeParse(req.body);
  if (!body.success) {
    return invalidRequest(`Body inválido: ${validationMessage(body.error)}`);
  }

  return {
    ok: true,
    userId: params.data.userId,
    request: body.data,
    idempotencyKey: header.key,
  };
};

export const buildOrdersRouter = (deps: OrdersRouterDeps): Router => {
  const router = Router();

  router.post(
    "/users/:userId/orders",
    async (req: Request, res: Response) => {
      const parsed = parseCreateOrderRequest(req);
      if (!parsed.ok) {
        res.status(400).json(parsed.body);
        return;
      }

      try {
        const result = await submitOrder(deps, {
          userId: parsed.userId,
          request: parsed.request,
          idempotencyKey: parsed.idempotencyKey,
        });
        // 201 SIEMPRE que se persistió (FILLED/NEW/REJECTED/CANCELLED).
        res.status(201).json(toOrderResponse(result.order, result.reason));
      } catch (error) {
        if (
          error instanceof SubmitOrderError ||
          error instanceof IdempotencyConflictError
        ) {
          // Errores de aplicación → status + body del contrato.
          res
            .status(error.status)
            .json(apiErrorBody(error.code, error.message));
          return;
        }
        throw error; // lo responde el manejador central (500 INTERNAL_ERROR)
      }
    },
  );

  return router;
};
