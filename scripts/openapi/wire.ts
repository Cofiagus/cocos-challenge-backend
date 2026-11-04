// Espejos de wire para el contrato OpenAPI.
//
// Por qué existen: los schemas de entrada de dinero (`ArsInputSchema`,
// `PositiveArsInputSchema`) usan `z.preprocess` + `z.instanceof(Decimal)`, y `z.toJSONSchema`
// no puede representar tipos custom. Estos espejos describen LO MISMO que acepta el runtime en
// el cable (número JSON o string decimal) pero de forma representable.
//
// No son fuente de verdad: la fuente es `src/contracts`. `tests/docs/openapi.test.ts` verifica
// que el espejo y el schema real acepten/rechacen EXACTAMENTE la misma muestra de valores.

import { Decimal } from "decimal.js";
import { z } from "zod";
import {
  MAX_ORDER_SIZE_SHARES,
  OrderTypeSchema,
  TimeInForceSchema,
  TradingSideSchema,
  TransferSideSchema,
} from "../../src/contracts/index.js";

/**
 * Cota de almacenamiento espejo de src/contracts/money.ts (MAX_STORED_ARSS):
 * numeric(10,2). El espejo debe rechazar lo mismo que el schema real en el
 * cable (tests/docs/openapi.test.ts D7), incluida la cota de 2 decimales y
 * de |monto| ≤ 99999999.99 que el borde de entrada aplica desde el fix del
 * análisis del PR #2.
 */
const MAX_STORED_ARSS = new Decimal("99999999.99");

/** Decimal desde el cable (número JSON o string), undefined si no parsea. */
const moneyFromWire = (value: number | string): Decimal | undefined => {
  try {
    return new Decimal(typeof value === "number" ? String(value) : value.trim());
  } catch {
    return undefined;
  }
};

/** Mismo dominio que ArsInputSchema: finito, ≤2 decimales, |monto| acotado. */
const withinStorageDomain = (value: number | string): boolean => {
  const amount = moneyFromWire(value);
  return (
    amount !== undefined &&
    amount.isFinite() &&
    amount.decimalPlaces() <= 2 &&
    amount.abs().lessThanOrEqualTo(MAX_STORED_ARSS)
  );
};

/** Monto ARS en el cable: número JSON o string decimal. */
export const ArsWireSchema = z
  .union([z.number(), z.string()])
  .refine(withinStorageDomain, {
    message:
      "Se espera un número o string decimal finito, con a lo sumo 2 decimales y |monto| ≤ 99999999.99.",
  })
  .meta({ description: "Monto ARS: número JSON o string decimal (nunca float en cálculo)." });

/** Monto ARS estrictamente positivo (amountArs, price). */
export const PositiveArsWireSchema = z
  .union([z.number(), z.string()])
  .refine(
    (value) => {
      const amount = moneyFromWire(value);
      return withinStorageDomain(value) && amount !== undefined && amount.greaterThan(0);
    },
    { message: "El monto debe ser mayor que 0 (≤2 decimales, ≤ 99999999.99)." },
  )
  .meta({ description: "Monto ARS > 0: número JSON o string decimal." });

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
      `\`size\` entero 1..${MAX_ORDER_SIZE_SHARES}; \`price\` > 0 obligatorio si \`type=LIMIT\`; en \`type=MARKET\` ` +
      "se omite o va `null` (un número es 400).",
  });

/** Body de POST /transfers. */
export const CreateTransferBodySchema = z
  .strictObject({
    amountArs: PositiveArsWireSchema,
    side: TransferSideSchema,
  })
  .meta({ description: "Monto > 0 en ARS; `CASH_IN` acredita, `CASH_OUT` debita el disponible." });
