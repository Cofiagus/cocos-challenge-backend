// UC-5 — POST /api/users/:userId/transfers
//
// DECISIONS.md: transferencias modeladas como orders (side CASH_IN/CASH_OUT).
// CASH_IN → FILLED inmediato. CASH_OUT valida contra cashSettled −
// cashReserved (insuficiente → REJECTED persistida con
// INSUFFICIENT_FUNDS). La respuesta usa OrderResponse (es una order).

import { z } from "zod";
import { PositiveArsInputSchema } from "./money.js";
import { TransferSideSchema } from "./enums.js";

export const CreateTransferParamsSchema = z.strictObject({
  userId: z.coerce.number().int().positive(),
});
export type CreateTransferParams = z.infer<
  typeof CreateTransferParamsSchema
>;

/** Body de transferencia: amountArs > 0 (número o string, nunca float). */
export const CreateTransferRequestSchema = z.strictObject({
  amountArs: PositiveArsInputSchema,
  side: TransferSideSchema,
});
export type CreateTransferRequest = z.infer<
  typeof CreateTransferRequestSchema
>;
