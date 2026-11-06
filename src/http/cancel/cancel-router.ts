// UC-4 — DELETE /api/orders/:orderId.
//
// Router factory con DI: deps = la INTERFAZ del port de src/domain/ports,
// que cancelOrder (src/application/cancel) orquesta. El handler es FINO:
//   - parseWriteRequest (src/http/shared/edge.ts): Zod estricto en el borde
//     (params: orderId int > 0) ⇒ 400 VALIDATION_ERROR SIN tocar la DB; la
//     ruta no tiene body ni admite Idempotency-Key;
//   - cancelOrder ⇒ 200 OrderResponse con la fila CANCELLED (201 es para
//     creación; DECISIONS.md no fija el status de cancelación);
//   - toHttpError ⇒ su status + apiErrorBody (404/422);
//   - cualquier otro error propaga al manejador central (500 INTERNAL_ERROR).
//
// La respuesta se serializa con toOrderResponse (src/http/shared/edge.ts),
// igual que la de orders.

import { Router } from "express";
import type { Request, Response } from "express";
import { CancelOrderParamsSchema, apiErrorBody } from "../../contracts/index.js";
import {
  cancelOrder,
  type CancelOrderDeps,
} from "../../application/cancel/cancel-order.js";
import {
  parseWriteRequest,
  toHttpError,
  toOrderResponse,
} from "../shared/edge.js";

/** Deps del slice de cancelación: el PUERTO, orquestado por cancelOrder. */
export type CancelRouterDeps = CancelOrderDeps;

export const buildCancelRouter = (deps: CancelRouterDeps): Router => {
  const router = Router();

  router.delete(
    "/orders/:orderId",
    async (req: Request, res: Response) => {
      // Borde: params de ruta con Zod estricto, sin cast ('abc'/0/-1 ⇒ 400).
      const parsed = parseWriteRequest(req, { params: CancelOrderParamsSchema });
      if (!parsed.ok) {
        res.status(400).json(parsed.error);
        return;
      }

      try {
        const result = await cancelOrder(deps, {
          orderId: parsed.params.orderId,
        });
        // 200 con la orden cancelada.
        // Cancelación por usuario: sin razón (las razones del contrato son
        // de rechazo/IOC-FOK; la fila NEW que se canceló nunca tuvo una).
        res.status(200).json(toOrderResponse(result.order, null));
      } catch (error) {
        const httpError = toHttpError(error);
        if (httpError === null) {
          throw error; // lo responde el manejador central (500 INTERNAL_ERROR)
        }
        // Errores de aplicación → status + body del contrato (404/422).
        res
          .status(httpError.status)
          .json(apiErrorBody(httpError.code, httpError.message));
      }
    },
  );

  return router;
};
