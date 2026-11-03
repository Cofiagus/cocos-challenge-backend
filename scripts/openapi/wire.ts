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
  OrderTypeSchema,
  TimeInForceSchema,
  TradingSideSchema,
  TransferSideSchema,
} from "../../src/contracts/index.js";

const parsesAsDecimal = (value: string): boolean => {
  try {
    void new Decimal(value.trim());
    return true;
  } catch {
    return false;
  }
};

/** Monto ARS en el cable: número JSON o string decimal. */
export const ArsWireSchema = z
  .union([
    z.number().refine((value) => Number.isFinite(value), {
      message: "Se espera un número finito.",
    }),
    z.string().refine(parsesAsDecimal, {
      message: "Se espera un decimal, por ejemplo \"1500.25\".",
    }),
  ])
  .meta({ description: "Monto ARS: número JSON o string decimal (nunca float en cálculo)." });

const greaterThanZero = (value: number | string): boolean => {
  if (typeof value === "number") {
    return Number.isFinite(value) && new Decimal(String(value)).greaterThan(0);
  }
  if (!parsesAsDecimal(value)) return false;
  return new Decimal(value.trim()).greaterThan(0);
};

/** Monto ARS estrictamente positivo (amountArs, price). */
export const PositiveArsWireSchema = z
  .union([
    z.number().refine((value) => Number.isFinite(value), {
      message: "Se espera un número finito.",
    }),
    z.string().refine(parsesAsDecimal, {
      message: "Se espera un decimal, por ejemplo \"1500.25\".",
    }),
  ])
  .refine(greaterThanZero, { message: "El monto debe ser mayor que 0." })
  .meta({ description: "Monto ARS > 0: número JSON o string decimal." });

/**
 * Body de POST /orders. XOR instrumentId|ticker, XOR size|amountArs, `price` sólo en LIMIT.
 * Las reglas cruzadas (superRefine) viajan en la `description` de la operación: JSON Schema
 * las expresa como oneOf, pero el error 400 es el mismo.
 */
export const CreateOrderBodySchema = z
  .strictObject({
    instrumentId: z.number().int().positive().optional(),
    ticker: z.string().min(1).max(10).optional(),
    side: TradingSideSchema,
    type: OrderTypeSchema,
    timeInForce: TimeInForceSchema.default("GTC"),
    size: z.number().int().positive().optional(),
    amountArs: PositiveArsWireSchema.optional(),
    price: PositiveArsWireSchema.optional(),
  })
  .meta({
    description:
      "Exactamente uno de `instrumentId` | `ticker`; exactamente uno de `size` | `amountArs`; " +
      "`price` > 0 obligatorio si `type=LIMIT` y prohibido si `type=MARKET`.",
  });

/** Body de POST /transfers. */
export const CreateTransferBodySchema = z
  .strictObject({
    amountArs: PositiveArsWireSchema,
    side: TransferSideSchema,
  })
  .meta({ description: "Monto > 0 en ARS; `CASH_IN` acredita, `CASH_OUT` debita el disponible." });
