// UC-5 — POST /api/users/:userId/transfers
//
// DECISIONS.md: transferencias modeladas como orders (side CASH_IN/CASH_OUT).
// CASH_IN → FILLED inmediato. CASH_OUT valida contra cashSettled −
// cashReserved (insuficiente → REJECTED persistida con
// INSUFFICIENT_FUNDS). La respuesta usa OrderResponse (es una order).

import { z } from "zod";
import { PositiveArsInputSchema } from "./money.js";
import { PositiveIntParamSchema } from "./orders.js";
import { TransferSideSchema } from "./enums.js";

/**
 * Params de ruta. `userId` se persiste en una columna `Int`: la misma cota
 * INT4 que usan orders y portfolio (PositiveIntParamSchema, definida en
 * orders.ts) convierte un id fuera de rango en 400 antes de consultar, en vez
 * del 500 del driver (SQLSTATE 22003 / Prisma P2020).
 */
export const CreateTransferParamsSchema = z.strictObject({
  userId: PositiveIntParamSchema,
});

/** Body de transferencia: amountArs > 0 (número o string, nunca float). */
export const CreateTransferRequestSchema = z.strictObject({
  amountArs: PositiveArsInputSchema,
  side: TransferSideSchema,
});
