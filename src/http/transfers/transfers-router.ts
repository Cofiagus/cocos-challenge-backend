// UC-5 — POST /api/users/:userId/transfers.
//
// Router factory con DI (igual que orders-router): deps = las INTERFACES de
// src/domain/ports, que submitTransfer (src/application) coordina. El handler
// es FINO:
//   - parseWriteRequest (src/http/shared/edge.ts): Zod estricto en el borde
//     (params + body + Idempotency-Key) ⇒ 400 VALIDATION_ERROR SIN crear orden;
//   - submitTransfer ⇒ 201 OrderResponse (transferencia = order; también
//     para REJECTED persistida — DECISIONS.md);
//   - toHttpError ⇒ su status + apiErrorBody (los códigos de la transferencia
//     son TODOS del contrato: sin cast, a diferencia de E);
//   - cualquier otro error propaga al manejador central (500 INTERNAL_ERROR).
//
// parseWriteRequest / toHttpError / toOrderResponse son las COMPARTIDAS de
// src/http/shared/edge.ts: mismos status, códigos y mensajes que los espejos
// locales que reemplazan.

import { Router } from "express";
import type { Request, Response } from "express";
import {
  CreateTransferParamsSchema,
  CreateTransferRequestSchema,
  apiErrorBody,
} from "../../contracts/index.js";
import {
  submitTransfer,
  type SubmitTransferDeps,
} from "../../application/transfers/submit-transfer.js";
import {
  parseWriteRequest,
  toHttpError,
  toOrderResponse,
} from "../shared/edge.js";

/** Deps del slice de transfers: los PUERTOS (patrón C), orquestados por submitTransfer. */
export type TransfersRouterDeps = SubmitTransferDeps;

export const buildTransfersRouter = (deps: TransfersRouterDeps): Router => {
  const router = Router();

  router.post(
    "/users/:userId/transfers",
    async (req: Request, res: Response) => {
      const parsed = parseWriteRequest(req, {
        params: CreateTransferParamsSchema,
        body: CreateTransferRequestSchema,
        header: true,
      });
      if (!parsed.ok) {
        res.status(400).json(parsed.error);
        return;
      }

      try {
        const result = await submitTransfer(deps, {
          userId: parsed.params.userId,
          amountArs: parsed.body.amountArs,
          side: parsed.body.side,
          idempotencyKey: parsed.idempotencyKey,
        });
        // 201 SIEMPRE que se persistió (FILLED o REJECTED).
        res.status(201).json(toOrderResponse(result.order, result.reason));
      } catch (error) {
        const httpError = toHttpError(error);
        if (httpError === null) {
          throw error; // lo responde el manejador central (500 INTERNAL_ERROR)
        }
        // Los códigos de la transferencia son todos ApiErrorCode (sin
        // INSTRUMENT_NOT_FOUND custom — a diferencia de E, sin cast).
        res
          .status(httpError.status)
          .json(apiErrorBody(httpError.code, httpError.message));
      }
    },
  );

  return router;
};
