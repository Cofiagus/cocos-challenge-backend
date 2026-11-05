// Wire de entrada para el contrato OpenAPI.
//
// El espejo monetario independiente (unión número|string con su propio
// máximo 99999999.99) ya NO existe: `src/contracts/money.ts` define los
// schemas wire (`ArsWireSchema`, `PositiveArsWireSchema`) de forma
// directamente representable por `z.toJSONSchema` (string + pattern, sin
// `z.preprocess` ni `instanceof`), con el único máximo del sistema
// (`MAX_STORED_ARSS`, NUMERIC(24,2) de D1). Acá sólo se REUTILIZAN y se
// re-exportan — una sola definición de rango y gramática (spec §3.2);
// `tests/docs/openapi.test.ts` D7 verifica la frontera contra el runtime.
//
// No son fuente de verdad: la fuente es `src/contracts`.

import { z } from "zod";
import {
  ArsWireSchema,
  MAX_ORDER_SIZE_SHARES,
  OrderTypeSchema,
  PositiveArsWireSchema,
  TimeInForceSchema,
  TradingSideSchema,
  TransferSideSchema,
} from "../../src/contracts/index.js";

/** Superficie pública del wire monetario: la del contrato, sin duplicar. */
export { ArsWireSchema, PositiveArsWireSchema };

/**
 * Body de POST /orders. XOR instrumentId|ticker, XOR size|amountArs, `price` sólo en LIMIT
 * (en MARKET se omite o va `null`). Las reglas cruzadas (superRefine) viajan en la
 * `description` de la operación: JSON Schema las expresa como oneOf, pero el error 400 es
 * el mismo.
 */
export const CreateOrderBodySchema = z
  .strictObject({
    instrumentId: z.number().int().positive().optional(),
    ticker: z.string().min(1).max(10).optional(),
    side: TradingSideSchema,
    type: OrderTypeSchema,
    timeInForce: TimeInForceSchema.default("GTC"),
    size: z.number().int().positive().max(MAX_ORDER_SIZE_SHARES).optional(),
    amountArs: PositiveArsWireSchema.optional(),
    price: PositiveArsWireSchema.nullable().optional(),
  })
  .meta({
    description:
      "Exactamente uno de `instrumentId` | `ticker`; exactamente uno de `size` | `amountArs`; " +
      "`amountArs` y `price` son strings decimales canónicos (los números JSON se rechazan); " +
      `\`size\` entero 1..${MAX_ORDER_SIZE_SHARES}; \`price\` > 0 obligatorio si \`type=LIMIT\`; en \`type=MARKET\` ` +
      "se omite o va `null` (un número es 400).",
  });

/** Body de POST /transfers. */
export const CreateTransferBodySchema = z
  .strictObject({
    amountArs: PositiveArsWireSchema,
    side: TransferSideSchema,
  })
  .meta({ description: "Monto > 0 en ARS como string decimal canónico; `CASH_IN` acredita, `CASH_OUT` debita el disponible." });
