// UC-1 — GET /api/users/:userId/portfolio
//
// DECISIONS.md: cash = cashSettled − cashReserved (reservas derivadas de
// NEW, sin tabla). Sin precio de referencia: marketValue null,
// priceAvailable false, la posición NO suma al total. Sin MONEDA en
// positions. Posición con cantidad 0 no se lista; negativa (BMA −10) se
// lista tal cual.

import { z } from "zod";
import { MoneyArsSchema, PctSchema } from "./money.js";

/** Params de ruta. */
export const PortfolioParamsSchema = z.strictObject({
  userId: z.coerce.number().int().positive(),
});
export type PortfolioParams = z.infer<typeof PortfolioParamsSchema>;

/** Posición con P&L no realizado sobre costo promedio ponderado. */
export const PortfolioPositionSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  /** Acciones; entero, puede ser negativa (heredada del seed). */
  quantity: z.number().int(),
  /** Valor de mercado (quantity × close, 2 decimales). Null si NO_PRICE. */
  marketValue: MoneyArsSchema.nullable(),
  priceAvailable: z.boolean(),
  /** % sobre costo promedio ponderado (2 decimales). Null si NO_PRICE o costo 0. */
  totalReturnPct: PctSchema.nullable(),
});
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;

export const PortfolioResponseSchema = z.strictObject({
  /** Disponible para operar: cashSettled − cashReserved. */
  cash: MoneyArsSchema.meta({
    description:
      "Disponible para operar: settled − reservado por órdenes NEW de compra.",
  }),
  /** Reservado por órdenes NEW BUY (limit × size). */
  reservedCash: MoneyArsSchema,
  /** cash disponible + cash reservado + Σ marketValue de posiciones con precio. */
  totalAccountValue: MoneyArsSchema.meta({
    description:
      "cash + reservedCash + Σ marketValue de las posiciones con precio; abrir o cancelar una orden no lo mueve.",
  }),
  /** Sin MONEDA; sin posiciones de cantidad 0. */
  positions: z.array(PortfolioPositionSchema),
});
export type PortfolioResponse = z.infer<typeof PortfolioResponseSchema>;
