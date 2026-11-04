// UC-3 — POST /api/users/:userId/orders
// UC-4 — DELETE /api/orders/:orderId
//
// DECISIONS.md: éxito 201 también para REJECTED/CANCELLED persistidas;
// input inválido 400 SIN crear orden; usuario inexistente 404; Idempotency-Key
// opcional (misma key + mismo payload → la orden original; key + otro
// payload → 409). price = límite enviado; filledPrice = ejecución.

import type { Decimal } from "decimal.js";
import { z } from "zod";
import {
  OrderRejectionReasonSchema,
  OrderSideSchema,
  OrderStatusSchema,
  OrderTypeSchema,
  TimeInForceSchema,
  TradingSideSchema,
} from "./enums.js";
import { PositiveArsInputSchema, MoneyArsSchema } from "./money.js";

/** Nombre del header (Express lo casefold-ea). */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key" as const;
export const IdempotencyKeySchema = z.string().min(1).max(64);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

/**
 * Cota de `size`: la columna `size` es INTEGER (INT4) de Postgres, cuyo máximo
 * es 2^31−1. Sin esta cota el valor pasa Zod y el INSERT falla con 500 en vez
 * de llegar como 400 del contrato.
 */
export const MAX_ORDER_SIZE_SHARES = 2147483647;

/** `null` explícito es "ausente" en campos opcionales del body. */
const isPriceAbsent = (price: Decimal | null | undefined): boolean =>
  price === undefined || price === null;

/** Params de ruta de POST (userId) y DELETE (orderId). */
export const CreateOrderParamsSchema = z.strictObject({
  userId: z.coerce.number().int().positive(),
});
export type CreateOrderParams = z.infer<typeof CreateOrderParamsSchema>;

export const CancelOrderParamsSchema = z.strictObject({
  orderId: z.coerce.number().int().positive(),
});
export type CancelOrderParams = z.infer<typeof CancelOrderParamsSchema>;

/**
 * Body de envío de orden.
 *
 * Reglas (DECISIONS.md + brief FASE 1, validadas en el borde — 400 SIN crear
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
    instrumentId: z.number().int().positive().optional(),
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

/** Orden en respuestas de POST /orders y DELETE /orders/:orderId. */
export const OrderResponseSchema = z.strictObject({
  id: z.number().int(),
  instrumentId: z.number().int(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  timeInForce: TimeInForceSchema,
  status: OrderStatusSchema,
  /** Acciones; 0 en un REJECTED por ZERO_SIZE. */
  size: z.number().int().nullable(),
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
});
export type OrderResponse = z.infer<typeof OrderResponseSchema>;
