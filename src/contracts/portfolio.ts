// UC-1 — GET /api/users/:userId/portfolio
//
// DECISIONS.md: cash = cashSettled − cashReserved (reservas derivadas de
// NEW, sin tabla). Sin precio de referencia: marketValue null,
// priceAvailable false, la posición NO suma al total. Sin MONEDA en
// positions. Posición con cantidad 0 no se lista; negativa (BMA −10) se
// lista tal cual.

import { z } from "zod";
import { MoneyArsSchema, PctSchema } from "./money.js";
import { PositiveIntParamSchema } from "./orders.js";

/**
 * Params de ruta. `userId` se persiste en una columna `Int`: la cota INT4
 * compartida (PositiveIntParamSchema, definida en orders.ts junto a la misma
 * cota de `size`) convierte un id fuera de rango en 400 antes de consultar,
 * en vez del 500 del driver.
 */
export const PortfolioParamsSchema = z.strictObject({
  userId: PositiveIntParamSchema,
});
export type PortfolioParams = z.infer<typeof PortfolioParamsSchema>;

/**
 * Gramática de una cantidad de ACCIONES agregada (D3): string entero de base
 * 10, sin exponente, espacios, signo `+` ni ceros iniciales salvo el propio
 * `0`. Admite el signo `-` para la posición negativa heredada (BMA −10).
 */
const QUANTITY_SHARES_GRAMMAR = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * Cantidad interna (bigint) → string entero canónico para JSON. JSON no
 * representa bigint: convertirlo con `String` conserva todas las cifras
 * (más allá del entero seguro de JS) sin pasar por number.
 */
export const serializeQuantityShares = (quantityShares: bigint): string =>
  quantityShares.toString();

/** Posición con P&L no realizado sobre costo promedio ponderado. */
export const PortfolioPositionSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  /**
   * Acciones como string entero canónico (D3): puede ser mayor que
   * Number.MAX_SAFE_INTEGER y puede ser negativa (heredada del seed). El
   * bigint interno nunca se envía crudo a JSON.
   */
  quantity: z
    .string({ error: "Se espera un string entero canónico." })
    .regex(QUANTITY_SHARES_GRAMMAR, {
      message:
        "Se espera un string entero canónico (dígitos sin exponente, espacios, signo +, ceros iniciales ni fracción); el cero negativo -0 no se emite.",
    })
    .refine((value) => value !== "-0", {
      message: "El cero se serializa como 0, nunca como -0.",
    })
    .meta({
      description:
        "Cantidad de acciones como string entero canónico (signo - para la posición negativa heredada; sin ceros iniciales ni -0).",
    }),
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
