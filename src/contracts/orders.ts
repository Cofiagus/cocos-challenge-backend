// UC-3 — POST /api/users/:userId/orders
// UC-4 — DELETE /api/orders/:orderId
//
// DECISIONS.md: éxito 201 también para REJECTED/CANCELLED persistidas;
// input inválido 400 SIN crear orden; usuario inexistente 404; Idempotency-Key
// opcional (misma key + mismo payload → la orden original; key + otro
// payload → 409). price = límite enviado; filledPrice = ejecución.
//
// D3 de specs/datos-financieros-grandes-montos.md: la ENTRADA de trading no
// cambia (size sigue number entero ≤ INT4); la SALIDA discrimina por side:
// BUY/SELL mantienen `size` numérico/null y CASH_IN/CASH_OUT lo emiten como
// string monetario de 2 decimales (pesos, con centavos). No hay campo
// duplicado ni dos formas monetarias simultáneas.

import type { Decimal } from "decimal.js";
import { z } from "zod";
import {
  OrderRejectionReasonSchema,
  OrderStatusSchema,
  OrderTypeSchema,
  TimeInForceSchema,
  TradingSideSchema,
  TransferSideSchema,
} from "./enums.js";
import { PositiveArsInputSchema, MoneyArsSchema } from "./money.js";

/** Nombre del header (Express lo casefold-ea). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key" as const;
export const IdempotencyKeySchema = z.string().min(1).max(64);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

/** Máximo de un INTEGER de Postgres (INT4): 2^31−1. */
export const MAX_INT4 = 2147483647;

/**
 * Cota de `size` de TRADING: la cantidad de acciones por orden sigue acotada
 * al máximo de INT4 (2^31−1), aunque la columna pase a NUMERIC(24,2). Sin
 * esta cota el valor pasa Zod y llega como 500 del INSERT en vez de 400.
 */
export const MAX_ORDER_SIZE_SHARES = MAX_INT4;

/**
 * Identificador positivo acotado a INT4 (1..2147483647): la misma cota que
 * `MAX_ORDER_SIZE_SHARES`, aplicada a los IDs que se persisten en columnas
 * `Int` (userId, orderId, instrumentId). Sin ella un id > INT4 pasa Zod y
 * golpea el SELECT/INSERT como error de Postgres (SQLSTATE 22003, Prisma
 * P2020) ⇒ 500, en vez del 400 del borde. `coerce` es para los params de
 * ruta de Express (strings); un body numérico también lo satisface.
 */
export const PositiveIntParamSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_INT4);
export type PositiveIntParam = z.infer<typeof PositiveIntParamSchema>;

/** `null` explícito es "ausente" en campos opcionales del body. */
const isPriceAbsent = (price: Decimal | null | undefined): boolean =>
  price === undefined || price === null;

/** Params de ruta de POST (userId) y DELETE (orderId). */
export const CreateOrderParamsSchema = z.strictObject({
  userId: PositiveIntParamSchema,
});
export type CreateOrderParams = z.infer<typeof CreateOrderParamsSchema>;

export const CancelOrderParamsSchema = z.strictObject({
  orderId: PositiveIntParamSchema,
});
export type CancelOrderParams = z.infer<typeof CancelOrderParamsSchema>;

/**
 * Body de envío de orden.
 *
 * Reglas (DECISIONS.md + brief, validadas en el borde — 400 SIN crear
 * orden):
 *  - exactamente UNO de `instrumentId` / `ticker`;
 *  - exactamente UNO de `size` (acciones) / `amountArs` (pesos);
 *  - `price` > 0 obligatorio si LIMIT y ausente en MARKET (se ejecuta al
 *    precio de referencia); en MARKET, `price: null` se acepta como ausente;
 *  - `timeInForce` default GTC (DAY fuera de alcance);
 *  - `side` de trading: BUY/SELL (transferencias van por su ruta).
 */
export const CreateOrderRequestSchema = z
  .strictObject({
    /**
     * Instrumento por id: entero 1..INT4. Sin la cota, un id mayor pasa Zod
     * y el SELECT contra la columna Int responde 500 (ver PositiveIntParamSchema).
     */
    instrumentId: PositiveIntParamSchema.optional(),
    ticker: z.string().min(1).max(10).optional(),
    side: TradingSideSchema,
    type: OrderTypeSchema,
    timeInForce: TimeInForceSchema.default("GTC"),
    /** Acciones enteras > 0 (nunca fracciones) y ≤ INT4. */
    size: z.number().int().positive().max(MAX_ORDER_SIZE_SHARES).optional(),
    /** Monto total en ARS (size = floor(amountArs / precio) — DECISIONS.md). */
    amountArs: PositiveArsInputSchema.optional(),
    /**
     * Precio límite en ARS (> 0, sólo LIMIT). En MARKET, `null` es "sin
     * precio": el campo es opcional y un cliente que lo serializa como null
     * no recibe 400.
     */
    price: PositiveArsInputSchema.nullable().optional(),
  })
  .superRefine((order, ctx) => {
    if (
      (order.instrumentId === undefined) ===
      (order.ticker === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Enviar exactamente uno de instrumentId o ticker.",
        path: ["instrumentId"],
      });
    }
    if ((order.size === undefined) === (order.amountArs === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Enviar exactamente uno de size o amountArs.",
        path: ["size"],
      });
    }
    if (order.type === "LIMIT" && isPriceAbsent(order.price)) {
      ctx.addIssue({
        code: "custom",
        message: "LIMIT requiere price > 0.",
        path: ["price"],
      });
    }
    if (order.type === "MARKET" && !isPriceAbsent(order.price)) {
      ctx.addIssue({
        code: "custom",
        message: "MARKET no admite price: se ejecuta al precio de referencia.",
        path: ["price"],
      });
    }
  });
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

/**
 * Campos de la orden que NO cambian con el side (forma de la respuesta
 * vigente: IDs, tipo, TIF, estado, precios, tiempos y razón).
 */
const orderResponseCommonShape = {
  id: z.number().int(),
  instrumentId: z.number().int(),
  type: OrderTypeSchema,
  timeInForce: TimeInForceSchema,
  status: OrderStatusSchema,
  /** Límite enviado (LIMIT); null en MARKET (DECISIONS.md: price = límite). */
  price: MoneyArsSchema.nullable(),
  /** Precio de ejecución (FILLED); null si no ejecutó. */
  filledPrice: MoneyArsSchema.nullable(),
  /** ISO 8601 sin offset (timestamp sin zona — hora local del mercado). */
  filledAt: z.string().nullable(),
  /** ISO 8601 sin offset (hora de envío/aceptación). */
  datetime: z.string(),
  /** Razón del rechazo/cancelación; null en NEW/FILLED. */
  reason: OrderRejectionReasonSchema.nullable(),
} as const;

/**
 * Orden en respuestas de POST /orders, POST /transfers (UC-5) y
 * DELETE /orders/:orderId.
 *
 * `size` está discriminado por `side` (D3):
 *  - BUY/SELL: cantidad de ACCIONES, number entero o null según el caso
 *    vigente (0 en un REJECTED por ZERO_SIZE);
 *  - CASH_IN/CASH_OUT: MONTO en pesos como string de exactamente 2 decimales
 *    ("123.00" para un cash histórico de size 123, sin reescribir el valor
 *    persistido); el decimal se serializa con `serializeMoneyArs`.
 */
export const OrderResponseSchema = z.discriminatedUnion("side", [
  z.strictObject({
    ...orderResponseCommonShape,
    side: TradingSideSchema,
    size: z.number().int().nullable().meta({
      description:
        "Acciones de la orden (BUY/SELL): entero o null; 0 en un REJECTED por ZERO_SIZE.",
    }),
  }),
  z.strictObject({
    ...orderResponseCommonShape,
    side: TransferSideSchema,
    size: MoneyArsSchema.meta({
      description:
        "Monto en ARS de la transferencia como string con exactamente 2 decimales (columna física size con precio 1.00).",
    }),
  }),
]);
export type OrderResponse = z.infer<typeof OrderResponseSchema>;
