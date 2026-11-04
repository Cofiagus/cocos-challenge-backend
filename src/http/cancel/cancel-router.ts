// UC-4 — DELETE /api/orders/:orderId.
//
// Router factory con DI: deps = la INTERFAZ del port de src/domain/ports,
// que cancelOrder (src/application/cancel) orquesta. El handler es FINO:
//   - Zod estricto en el borde (params: orderId int > 0) ⇒ 400
//     VALIDATION_ERROR SIN tocar la DB;
//   - cancelOrder ⇒ 200 OrderResponse con la fila CANCELLED (201 es para
//     creación; DECISIONS.md no fija el status de cancelación);
//   - CancelOrderError ⇒ su status + apiErrorBody (404/422);
//   - cualquier otro error propaga al manejador central (500 INTERNAL_ERROR).
//
// La respuesta se serializa con toOrderResponse (src/http/shared/edge.ts),
// igual que la de orders.

import { Router } from "express";
import type { Request, Response } from "express";
import {
  API_ERROR_CODES,
  CancelOrderParamsSchema,
  apiErrorBody,
} from "../../contracts/index.js";
import {
  CancelOrderError,
  cancelOrder,
  type CancelOrderDeps,
} from "../../application/cancel/cancel-order.js";
import { toOrderResponse, validationMessage } from "../shared/edge.js";

/** Deps del slice de cancelación: el PUERTO, orquestado por cancelOrder. */
export type CancelRouterDeps = CancelOrderDeps;

export const buildCancelRouter = (deps: CancelRouterDeps): Router => {
  const router = Router();

  router.delete(
    "/orders/:orderId",
    async (req: Request, res: Response) => {
      // Borde: params de ruta con Zod estricto, sin cast ('abc'/0/-1 ⇒ 400).
      const params = CancelOrderParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(
          apiErrorBody(
            API_ERROR_CODES.VALIDATION_ERROR,
            `Parámetros inválidos: ${validationMessage(params.error)}`,
          ),
        );
        return;
      }

      try {
        const result = await cancelOrder(deps, {
          orderId: params.data.orderId,
        });
        // 200 con la orden cancelada (decisión firmada por el orquestador).
        // Cancelación por usuario: sin razón (las razones del contrato son
        // de rechazo/IOC-FOK; la fila NEW que se canceló nunca tuvo una).
        res.status(200).json(toOrderResponse(result.order, null));
      } catch (error) {
        if (error instanceof CancelOrderError) {
          // Errores de aplicación → status + body del contrato (404/422).
          res.status(error.status).json(apiErrorBody(error.code, error.message));
          return;
        }
        throw error; // lo responde el manejador central (500 INTERNAL_ERROR)
      }
    },
  );

  return router;
};
