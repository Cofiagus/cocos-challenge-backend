// UC-4 — DELETE /api/orders/:orderId.
//
// Router factory con DI (patrón C/E): deps = la INTERFAZ del port de
// src/domain/ports, que cancelOrder (src/application/cancel) orquesta.
// El handler es FINO:
//   - Zod estricto en el borde (params: orderId int > 0) ⇒ 400
//     VALIDATION_ERROR SIN tocar la DB;
//   - cancelOrder ⇒ 200 OrderResponse con la fila CANCELLED (decisión
//     de integración: 201 es para creación; DECISIONS.md no
//     fija el status de cancelación);
//   - CancelOrderError ⇒ su status + apiErrorBody (404/422);
//   - cualquier otro error propaga (500 no controlado — default de Express).
//
// La serialización es IGUAL que la del router de orders (UC-3): dinero con
// serializeMoneyArs (2 decimales), timestamps ISO sin offset con
// serializeLocalTimestamp.

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  API_ERROR_CODES,
  CancelOrderParamsSchema,
  type OrderResponse,
  apiErrorBody,
  serializeLocalTimestamp,
  serializeMoneyArs,
} from "../../contracts/index.js";
import {
  CancelOrderError,
  cancelOrder,
  type CancelOrderDeps,
  type CancelOrderResult,
} from "../../application/cancel/cancel-order.js";

/** Deps del slice de cancelación: el PUERTO, orquestado por cancelOrder. */
export type CancelRouterDeps = CancelOrderDeps;

/** Mensaje de validación: "campo: mensaje; ..." (ZodError → texto). */
const validationMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");

/** Fila CANCELLED (CancelOrderResult) → OrderResponse del contrato. */
const toOrderResponse = (result: CancelOrderResult): OrderResponse => {
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
    // Cancelación por usuario: sin razón (las razones del contrato son de
    // rechazo/IOC-FOK; la fila NEW que se canceló nunca tuvo una).
    reason: null,
  };
};

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
        // 200 con la orden cancelada (decisión de integración).
        res.status(200).json(toOrderResponse(result));
      } catch (error) {
        if (error instanceof CancelOrderError) {
          // Errores de aplicación → status + body del contrato (404/422).
          res.status(error.status).json(apiErrorBody(error.code, error.message));
          return;
        }
        throw error; // 500 no controlado (default de Express)
      }
    },
  );

  return router;
};
