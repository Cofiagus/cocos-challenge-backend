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
//   - cualquier otro error propaga al manejador central (500 INTERNAL_ERROR).
//
// validationMessage / parseIdempotencyKeyHeader / toOrderResponse son las
// COMPARTIDAS de src/http/shared/edge.ts: mismos status, códigos y
// mensajes que los espejos locales que reemplazan.

import { Router } from "express";
import type { Request, Response } from "express";
import {
  API_ERROR_CODES,
  CreateTransferParamsSchema,
  CreateTransferRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  type ApiErrorBody,
  type CreateTransferRequest,
  apiErrorBody,
} from "../../contracts/index.js";
import {
  SubmitTransferError,
  submitTransfer,
  type SubmitTransferDeps,
} from "../../application/transfers/submit-transfer.js";
import { IdempotencyConflictError } from "../../application/orders/persist-order-decision.js";
import {
  parseIdempotencyKeyHeader,
  toOrderResponse,
  validationMessage,
} from "../shared/edge.js";

/** Deps del slice de transfers: los PUERTOS (patrón C), orquestados por submitTransfer. */
export type TransfersRouterDeps = SubmitTransferDeps;

/** Request ya validado en el borde, o el body del 400 que corresponde. */
type ParsedCreateTransfer =
  | {
      readonly ok: true;
      readonly userId: number;
      readonly request: CreateTransferRequest;
      readonly idempotencyKey: string | null;
    }
  | { readonly ok: false; readonly body: ApiErrorBody };

const invalidRequest = (message: string): ParsedCreateTransfer => ({
  ok: false,
  body: apiErrorBody(API_ERROR_CODES.VALIDATION_ERROR, message),
});

/**
 * Borde: params de ruta (userId), Idempotency-Key opcional y body, con Zod
 * estricto y en ese orden. Cualquier fallo ⇒ 400 SIN crear orden.
 */
const parseCreateTransferRequest = (req: Request): ParsedCreateTransfer => {
  const params = CreateTransferParamsSchema.safeParse(req.params);
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

  const body = CreateTransferRequestSchema.safeParse(req.body);
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

export const buildTransfersRouter = (deps: TransfersRouterDeps): Router => {
  const router = Router();

  router.post(
    "/users/:userId/transfers",
    async (req: Request, res: Response) => {
      const parsed = parseCreateTransferRequest(req);
      if (!parsed.ok) {
        res.status(400).json(parsed.body);
        return;
      }

      try {
        const result = await submitTransfer(deps, {
          userId: parsed.userId,
          amountArs: parsed.request.amountArs,
          side: parsed.request.side,
          idempotencyKey: parsed.idempotencyKey,
        });
        // 201 SIEMPRE que se persistió (FILLED o REJECTED).
        res.status(201).json(toOrderResponse(result.order, result.reason));
      } catch (error) {
        if (
          error instanceof SubmitTransferError ||
          error instanceof IdempotencyConflictError
        ) {
          // Los códigos de la transferencia son todos ApiErrorCode (sin
          // INSTRUMENT_NOT_FOUND custom — a diferencia de E, sin cast).
          res.status(error.status).json(apiErrorBody(error.code, error.message));
          return;
        }
        throw error; // lo responde el manejador central (500 INTERNAL_ERROR)
      }
    },
  );

  return router;
};
