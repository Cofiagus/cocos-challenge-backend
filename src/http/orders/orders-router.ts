// UC-3 — POST /api/users/:userId/orders.
//
// Router factory con DI (patrón C): deps = las INTERFACES de src/domain/ports,
// que submitOrder (src/application) orquesta. El handler es FINO:
//   - parseWriteRequest (src/http/shared/edge.ts): Zod estricto en el borde
//     (params + body + Idempotency-Key) ⇒ 400 VALIDATION_ERROR SIN crear orden;
//   - submitOrder ⇒ 201 OrderResponse (también para REJECTED/CANCELLED
//     persistidas — DECISIONS.md);
//   - toHttpError ⇒ su status + apiErrorBody para los errores de aplicación;
//   - cualquier otro error propaga al manejador central (500 INTERNAL_ERROR).

import { Router } from "express";
import type { Request, Response } from "express";
import {
  CreateOrderParamsSchema,
  CreateOrderRequestSchema,
  apiErrorBody,
} from "../../contracts/index.js";
import {
  submitOrder,
  type SubmitOrderDeps,
} from "../../application/orders/submit-order.js";
import {
  parseWriteRequest,
  toHttpError,
  toOrderResponse,
} from "../shared/edge.js";

/** Deps del slice de orders: los PUERTOS (patrón C), orquestados por submitOrder. */
export type OrdersRouterDeps = SubmitOrderDeps;

export const buildOrdersRouter = (deps: OrdersRouterDeps): Router => {
  const router = Router();

  router.post(
    "/users/:userId/orders",
    async (req: Request, res: Response) => {
      const parsed = parseWriteRequest(req, {
        params: CreateOrderParamsSchema,
        body: CreateOrderRequestSchema,
        header: true,
      });
      if (!parsed.ok) {
        res.status(400).json(parsed.error);
        return;
      }

      try {
        const result = await submitOrder(deps, {
          userId: parsed.params.userId,
          request: parsed.body,
          idempotencyKey: parsed.idempotencyKey,
        });
        // 201 SIEMPRE que se persistió (FILLED/NEW/REJECTED/CANCELLED).
        res.status(201).json(toOrderResponse(result.order, result.reason));
      } catch (error) {
        const httpError = toHttpError(error);
        if (httpError === null) {
          throw error; // lo responde el manejador central (500 INTERNAL_ERROR)
        }
        // Errores de aplicación → status + body del contrato.
        res
          .status(httpError.status)
          .json(apiErrorBody(httpError.code, httpError.message));
      }
    },
  );

  return router;
};
